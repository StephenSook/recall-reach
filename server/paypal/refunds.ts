// Approvals and refunds. The agent or the app may propose; only a person's approval moves money.
//
// An approval binds shop, session, recall version, order line, exact amount and currency, expires
// in 15 minutes, and is consumed once, atomically. Executing it re-reads the capture from PayPal and
// refuses on any mismatch. Capture contract (payments_payment_v2.json, read 2026-11-05): status is
// COMPLETED, PARTIALLY_REFUNDED, REFUNDED, PENDING, DECLINED or FAILED, and the refunded total is only
// on refund resources. Measured 2026-11-05: a GET on any refund of a capture reports that capture's total
// so far, including refunds made elsewhere. So what is left comes from PayPal, once a refund of ours can
// show it, and PayPal's own REFUND_AMOUNT_EXCEEDED is the backstop. "You can send a full or partial refund within 180 days
// of the payment date" (paypal.com help, how-do-i-issue-a-refund).
//
// Raw PayPal ids stay in paypal_refund_refs (46-hour purge); the ledger holds only an HMAC.
import { createHash } from "node:crypto";
import { z } from "zod";
import type { Db, Queryable } from "../db/types";
import { joinShop } from "../match/run";
import { businessDay } from "../time/businessDay";
import type { RecordKey } from "../privacy/recordKey";
import { PayPalApiError, type PayPalClient } from "./client";
import { disputeOnCapture } from "./disputes";
import { centsToValue, getCapture, valueToCents, type CaptureFacts } from "./orders";
import { refundNote } from "./refundNote";

const APPROVAL_MS = 15 * 60_000;
const REFUND_WINDOW_DAYS = 180;
const UNCONFIRMED_AFTER_MS = 10 * 60_000;
/** Longer than the slowest send: 3 attempts plus one after a token refresh at 60 s, 2 token requests at 30 s, 1.5 s of backoff. */
const SEND_LEASE_MS = 6 * 60_000;
// PayPal stores a request id "for a period of time" and names no period for refunds (idempotency page and
// refund reference, read 2026-11-05). Past it, a repeat could make a second refund, so asking again is
// limited to a window short enough to trust. Widen it only on a measured replay.
const ASK_AGAIN_MS = 6 * 3_600_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type RefusalCode =
  | "NO_SUCH_MATCH"
  | "NOT_A_CONFIRMED_MATCH"
  | "NOT_REFUND_ELIGIBLE"
  | "JOIN_NOT_IDENTIFIED"
  | "REFUND_ALREADY_IN_PROGRESS"
  | "APPROVAL_NOT_VALID"
  | "RECALL_CHANGED"
  | "LINE_CHANGED"
  | "PAYPAL_FACTS_AGED_OUT"
  | "PAYMENT_CHANGED"
  | "PAYPAL_FACTS_CHANGED"
  | "PAYPAL_UNREACHABLE"
  | "PAYMENT_DISPUTED"
  | "DISPUTES_UNREADABLE"
  | "REFUND_WINDOW_CLOSED"
  | "PAYMENT_NOT_AFTER_RECALL"
  | "NOTHING_LEFT_TO_REFUND"
  | "REMAINING_UNKNOWN"
  | "AMOUNT_ABOVE_REMAINING"
  | "ORDER_INCOMPLETE"
  | "NO_SUCH_REFUND"
  | "NOTHING_TO_ASK"
  | "REFUND_BEING_SENT"
  | "TOO_OLD_TO_ASK_AGAIN"
  | "CHECK_IN_PAYPAL";

// PayPal judged the request and said no. 409 is not here: it means a previous call is still in progress.
const CLEAR_REFUSALS = new Set([400, 401, 403, 404, 422]);

/** Only a clear refusal proves no money moved. Anything else stays unconfirmed. */
const clearlyRefused = (err: unknown): err is PayPalApiError =>
  err instanceof PayPalApiError && !err.uncertain && CLEAR_REFUSALS.has(err.status);

export class RefundRefused extends Error {
  constructor(readonly code: RefusalCode, message: string) {
    super(message);
    this.name = "RefundRefused";
  }
}

/** Line price times quantity, less the line's allocated discount. Never below zero. */
export function refundAmountCents(line: { unitPriceCents: number; quantity: number; discountCents: number }): number {
  return Math.max(0, line.unitPriceCents * line.quantity - line.discountCents);
}

/** PayPal's own list of a seller's activity. Sandbox only, like everything here. */
export const PAYPAL_ACTIVITY_URL = "https://www.sandbox.paypal.com/unifiedtransactions/";

export const refundedAmount = (cents: number, currency: string) => `${centsToValue(cents)} ${currency}`;

const LINE_COLUMNS = "order_number, line_no, title, sku, quantity, unit_price_cents, discount_cents, currency, ordered_on, order_incomplete";

interface LineFacts {
  order_number: string;
  line_no: number;
  title: string;
  sku: string | null;
  quantity: number;
  unit_price_cents: number;
  discount_cents: number;
  currency: string;
  ordered_on: string;
  order_incomplete: boolean;
}

/** Everything a refund amount or decision rests on. JSON, so no field can run into the next. */
const lineVersion = (l: LineFacts) =>
  createHash("sha256")
    .update(JSON.stringify([l.order_number, l.line_no, l.title, l.sku, l.quantity, l.unit_price_cents, l.discount_cents, l.currency, l.ordered_on, l.order_incomplete]))
    .digest("hex");

/** Refuses unless the recall and the line are still what the person approved. Returns the dates that decide eligibility. */
async function approvedFactsHold(
  q: Queryable,
  approval: { recall_id: number; recall_sha256: string; order_line_id: string; line_sha256: string | null },
  lock: "" | " for share" = "",
): Promise<{ recallDate: string; orderedOn: string; note: string }> {
  const recall = (
    await q.query<{ raw_sha256: string; recall_date: string; recall_number: string; title: string; products: { name: string }[] }>(
      `select raw_sha256, recall_date, recall_number, title, products from recalls where recall_id = $1${lock}`,
      [approval.recall_id],
    )
  ).rows[0];
  if (recall.raw_sha256 !== approval.recall_sha256) {
    throw new RefundRefused("RECALL_CHANGED", "CPSC changed this recall after the approval. Please review it again.");
  }
  const line = (await q.query<LineFacts>(`select ${LINE_COLUMNS} from order_lines where id = $1${lock}`, [approval.order_line_id])).rows[0];
  if (lineVersion(line) !== approval.line_sha256) {
    throw new RefundRefused("LINE_CHANGED", "This order line changed after the approval. Please review it again.");
  }
  // From the version the person approved, since a changed recall was refused above.
  const note = refundNote(recall.recall_number, recall.products[0]?.name ?? recall.title);
  return { recallDate: recall.recall_date, orderedOn: line.ordered_on, note };
}

/**
 * The capture for the payment matching identified, after joining again with what is held now. The line
 * must still link to exactly that payment, so a new or replaced payment can never receive the refund.
 */
async function identifiedCapture(q: Queryable, shopId: string, orderLineId: string, paymentId: string | null, today: string): Promise<string> {
  const agedOut = () => new RefundRefused("PAYPAL_FACTS_AGED_OUT", "PayPal's record of this sale is no longer held here. Read it from PayPal again.");
  if (!paymentId) throw agedOut();
  const { joined, captureIds } = await joinShop(q, shopId, { today });
  const link = joined.lines[orderLineId];
  if (link?.state !== "IDENTIFIED" || link.paymentKey !== paymentId) {
    throw new RefundRefused("PAYMENT_CHANGED", "The PayPal payment for this order line has changed. Please review it again.");
  }
  const captureId = captureIds.get(paymentId);
  if (!captureId) throw agedOut();
  return captureId;
}

export interface Approval {
  approvalId: string;
  amountCents: number;
  currency: string;
  expiresAt: string;
}

export async function approveRefund(
  db: Queryable,
  client: PayPalClient,
  input: { shopId: string; sessionId: string; matchId: string; now?: Date },
): Promise<Approval> {
  const now = input.now ?? new Date();
  if (!UUID.test(input.matchId)) throw new RefundRefused("NO_SUCH_MATCH", "No such match for this shop. Go back to your queue.");
  const { rows } = await db.query<
    LineFacts & {
      verdict: string;
      strength: string | null;
      sale_path: string | null;
      join_state: string | null;
      recall_id: number;
      recall_sha256: string;
      order_line_id: string | null;
      paypal_payment_id: string | null;
    }
  >(
    `select m.verdict, m.strength, m.sale_path, m.join_state, m.recall_id, m.recall_sha256, m.order_line_id, m.paypal_payment_id,
            ${LINE_COLUMNS.split(", ")
              .map((c) => `l.${c}`)
              .join(", ")}
     from recall_matches m join order_lines l on l.id = m.order_line_id
     where m.id = $1 and m.shop_id = $2`,
    [input.matchId, input.shopId],
  );
  const m = rows[0];
  if (!m || !m.order_line_id) throw new RefundRefused("NO_SUCH_MATCH", "No such match for this shop. Go back to your queue.");
  if (m.verdict !== "MATCH" || m.strength !== "CONFIRMED") throw new RefundRefused("NOT_A_CONFIRMED_MATCH", "A refund needs a confirmed match. You can still send the check request.");
  if (m.sale_path !== "REFUND_ELIGIBLE") {
    throw new RefundRefused("NOT_REFUND_ELIGIBLE", "Only a sale dated after the recall date can be refunded here. You can still send the notice.");
  }
  if (m.join_state !== "IDENTIFIED") {
    throw new RefundRefused("JOIN_NOT_IDENTIFIED", "This order line is not linked to exactly one PayPal payment. Check the sale in PayPal.");
  }
  if (m.order_incomplete) {
    throw new RefundRefused("ORDER_INCOMPLETE", "A row of this order could not be read, so this amount cannot be trusted. Fix the file and import it again.");
  }
  const captureId = await identifiedCapture(db, input.shopId, m.order_line_id, m.paypal_payment_id, businessDay(now));
  const open = await db.query("select 1 from refunds where order_line_id = $1 and status <> 'failed'", [m.order_line_id]);
  if (open.rows.length > 0) {
    throw new RefundRefused("REFUND_ALREADY_IN_PROGRESS", "A refund for this order line already exists. Open it from the card.");
  }
  const amountCents = refundAmountCents({
    unitPriceCents: m.unit_price_cents,
    quantity: m.quantity,
    discountCents: m.discount_cents,
  });
  if (amountCents <= 0) throw new RefundRefused("NOTHING_LEFT_TO_REFUND", "This line has nothing to refund. You can still send the notice.");

  // The exact amount a person sees has to be one PayPal can still honor.
  const { rows: recalls } = await db.query<{ recall_date: string }>("select recall_date from recalls where recall_id = $1", [m.recall_id]);
  await refusePayPalFacts(db, client, captureId, { amountCents, currency: m.currency, recallDate: recalls[0].recall_date, now });

  const expiresAt = new Date(now.getTime() + APPROVAL_MS).toISOString();
  const inserted = await db.query<{ id: string }>(
    `insert into approvals (shop_id, session_id, recall_id, recall_sha256, order_line_id, amount_cents, currency, expires_at, paypal_payment_id, line_sha256)
     values ($1, $2, $3, $4, $5, $6, $7, $8::timestamptz, $9, $10) returning id`,
    [input.shopId, input.sessionId, m.recall_id, m.recall_sha256, m.order_line_id, amountCents, m.currency, expiresAt, m.paypal_payment_id, lineVersion(m)],
  );
  return { approvalId: inserted.rows[0].id, amountCents, currency: m.currency, expiresAt };
}

export interface RefundOutcome {
  refundId: string;
  status: "reserved" | "pending" | "refunded" | "failed" | "unconfirmed";
  amountCents: number;
  currency: string;
  failure: string | null;
}

/** PayPal's refund statuses are COMPLETED, PENDING, FAILED and CANCELLED. A new one proves nothing yet. */
function ledgerStatusFor(paypalStatus: string): RefundOutcome["status"] {
  if (paypalStatus === "COMPLETED") return "refunded";
  if (paypalStatus === "PENDING") return "pending";
  if (paypalStatus === "FAILED" || paypalStatus === "CANCELLED") return "failed";
  return "unconfirmed";
}

export async function executeRefund(
  db: Db,
  client: PayPalClient,
  input: { shopId: string; sessionId: string; approvalId: string; recordKey: RecordKey; now?: Date },
): Promise<RefundOutcome> {
  const now = input.now ?? new Date();
  const startedAt = performance.now();
  const invalid = () => new RefundRefused("APPROVAL_NOT_VALID", "This approval is missing, expired, already used, or from another session. Press Review refund again.");
  if (!UUID.test(input.approvalId)) throw invalid();

  // Every check runs before the approval is spent, so a refused or failed attempt uses up nothing.
  const found = await db.query<{
    recall_id: number;
    recall_sha256: string;
    order_line_id: string;
    paypal_payment_id: string | null;
    line_sha256: string | null;
    amount_cents: number;
    currency: string;
  }>(
    `select recall_id, recall_sha256, order_line_id, paypal_payment_id, line_sha256, amount_cents, currency from approvals
     where id = $1 and shop_id = $2 and session_id = $3 and consumed_at is null and expires_at > $4::timestamptz`,
    [input.approvalId, input.shopId, input.sessionId, now.toISOString()],
  );
  const approval = found.rows[0];
  if (!approval) throw invalid();

  const { recallDate, orderedOn, note } = await approvedFactsHold(db, approval);
  if (orderedOn <= recallDate) {
    throw new RefundRefused("NOT_REFUND_ELIGIBLE", "Only a sale dated after the recall date can be refunded here. You can still send the notice.");
  }

  const today = businessDay(now);
  const captureId = await identifiedCapture(db, input.shopId, approval.order_line_id, approval.paypal_payment_id, today);

  const { capture, refundedByPayPal } = await refusePayPalFacts(db, client, captureId, {
    amountCents: approval.amount_cents,
    currency: approval.currency,
    recallDate,
    now,
  });

  // Spending the approval, reserving the line and recording the intent happen together or not at all.
  // The lock serializes reservations on one capture, so two lines cannot both claim the same balance. The facts
  // are read only once it is held, and held still until this commits: waiting for the lock can take a while.
  const row = await db.transaction(async (tx) => {
    await tx.query("select pg_advisory_xact_lock(hashtextextended($1, 0))", [captureId]);
    await approvedFactsHold(tx, approval, " for share");
    await tx.query("select 1 from paypal_payments where id = $1 for share", [approval.paypal_payment_id]);
    if ((await identifiedCapture(tx, input.shopId, approval.order_line_id, approval.paypal_payment_id, today)) !== captureId) {
      throw new RefundRefused("PAYMENT_CHANGED", "The PayPal payment for this order line has changed. Please review it again.");
    }
    refuseAboveRemaining(capture.amountCents, refundedByPayPal, await ledgerOnCapture(tx, captureId), approval.amount_cents, approval.currency);
    const consumed = await tx.query(
      `update approvals set consumed_at = $4::timestamptz
       where id = $1 and shop_id = $2 and session_id = $3 and consumed_at is null and expires_at > $4::timestamptz
       returning id`,
      [input.approvalId, input.shopId, input.sessionId, timeSince(startedAt, now)],
    );
    if (consumed.rows.length === 0) throw invalid();
    const inserted = await tx.query<{ id: string; request_id: string; send_lease_id: string }>(
      `insert into refunds (approval_id, shop_id, order_line_id, amount_cents, currency, status, send_lease_until, send_lease_id)
       values ($1, $2, $3, $4, $5, 'reserved', $6::timestamptz, gen_random_uuid())
       on conflict (order_line_id) where status <> 'failed' do nothing
       returning id, request_id, send_lease_id`,
      [input.approvalId, input.shopId, approval.order_line_id, approval.amount_cents, approval.currency, leaseEnd(startedAt, now)],
    );
    const reserved = inserted.rows[0];
    if (!reserved) throw new RefundRefused("REFUND_ALREADY_IN_PROGRESS", "A refund for this order line already exists. Open it from the card.");
    await tx.query("insert into paypal_refund_refs (refund_row_id, capture_id) values ($1, $2)", [reserved.id, captureId]);
    return reserved;
  });

  return sendRefund(
    db,
    client,
    { rowId: row.id, requestId: row.request_id, captureId, amountCents: approval.amount_cents, currency: approval.currency, note, repeat: false, holder: row.send_lease_id, startedAt },
    input.recordKey,
    now,
  );
}

/**
 * A reservation moves to unconfirmed before it is sent, so one whose lease ran out was never sent. Both
 * facts are checked as the row is written, because a send that begins meanwhile must keep the line blocked.
 */
async function giveUpIfNeverSent(q: Queryable, refundRowId: string, now: Date): Promise<RefundOutcome["status"]> {
  await q.query(
    `update refunds set status = 'failed', failure = 'Never sent to PayPal.', send_lease_until = null, send_lease_id = null, updated_at = $2::timestamptz
     where id = $1 and status = 'reserved' and (send_lease_until is null or send_lease_until <= $2::timestamptz)`,
    [refundRowId, now.toISOString()],
  );
  const { rows } = await q.query<{ status: RefundOutcome["status"] }>("select status from refunds where id = $1", [refundRowId]);
  return rows[0].status;
}

/**
 * Moves the ledger only out of a state that can still change, and returns the row as it now stands.
 * Refunded and failed are final, so an answer that took longer to arrive can never undo them.
 */
async function moveLedger(
  q: Queryable,
  refundRowId: string,
  to: RefundOutcome["status"],
  now: Date,
  extra: { failure?: string | null; holder?: string } = {},
): Promise<RefundOutcome["status"]> {
  const moved = await q.query<{ status: RefundOutcome["status"] }>(
    `update refunds set status = $2, updated_at = $3::timestamptz,
       failure = case when $4::boolean then $5 else failure end,
       send_lease_until = case when $6::uuid is null then send_lease_until end,
       send_lease_id = case when $6::uuid is null then send_lease_id end
     where id = $1 and status in ('pending', 'unconfirmed') and ($6::uuid is null or send_lease_id = $6::uuid)
     returning status`,
    [refundRowId, to, now.toISOString(), extra.failure !== undefined, extra.failure ?? null, extra.holder ?? null],
  );
  if (moved.rows[0]) return moved.rows[0].status;
  const { rows } = await q.query<{ status: RefundOutcome["status"] }>("select status from refunds where id = $1", [refundRowId]);
  return rows[0].status;
}

/** The checks before a send can take minutes when PayPal is slow, so a lease runs from when it is taken. */
const leaseEnd = (startedAt: number, now: Date) => new Date(now.getTime() + (performance.now() - startedAt) + SEND_LEASE_MS).toISOString();
/** The whole send has to fit inside the limit, retries included, so the last moment to begin is a lease early. */
const tooOldToRepeat = (createdAt: Date, atMs: number) => atMs + SEND_LEASE_MS - createdAt.getTime() > ASK_AGAIN_MS;

/** The slowest single attempt: 60 s for the request and 30 s for its token. One begun later might outlive its lease. */
const LAST_ATTEMPT_MS = 90_000;

/** The time now, on the same clock as `now` (tests set it), however long the checks since then have taken. */
const timeSince = (startedAt: number, now: Date) => new Date(now.getTime() + (performance.now() - startedAt)).toISOString();

/** Our ledger on one capture: what is settled as refunded, what may still land, and a refund PayPal can be asked about. */
async function ledgerOnCapture(q: Queryable, captureId: string): Promise<{ refundedCents: number; openCents: number; knownRefundId: string | null }> {
  const { rows } = await q.query<{ status: string; amount_cents: number; refund_id: string | null }>(
    `select r.status, r.amount_cents, p.refund_id
     from refunds r join paypal_refund_refs p on p.refund_row_id = r.id
     where p.capture_id = $1 and r.status <> 'failed'`,
    [captureId],
  );
  const sum = (settled: boolean) => rows.filter((r) => (r.status === "refunded") === settled).reduce((total, r) => total + r.amount_cents, 0);
  return { refundedCents: sum(true), openCents: sum(false), knownRefundId: rows.find((r) => r.refund_id)?.refund_id ?? null };
}

const refundTotalSchema = z.object({
  seller_payable_breakdown: z.object({ total_refunded_amount: z.object({ value: z.string() }) }),
});

/** What PayPal says has been refunded on this capture so far, from any refund of ours on it. */
async function refundedPerPayPal(client: PayPalClient, capture: CaptureFacts, knownRefundId: string | null): Promise<number> {
  if (capture.status === "COMPLETED") return 0;
  const unknown = () => new RefundRefused("REMAINING_UNKNOWN", "This payment was partly refunded outside this app. Check PayPal first.");
  if (!knownRefundId) throw unknown();
  let data: unknown;
  try {
    ({ data } = await client.request("GET", `/v2/payments/refunds/${knownRefundId}`));
  } catch {
    throw new RefundRefused("PAYPAL_UNREACHABLE", "PayPal did not answer, so nothing was refunded. Please try again.");
  }
  const parsed = refundTotalSchema.safeParse(data);
  if (!parsed.success) throw unknown();
  return valueToCents(parsed.data.seller_payable_breakdown.total_refunded_amount.value);
}

/** Refuses unless this much still fits. What may be on its way counts against it, even if PayPal does not show it yet. */
function refuseAboveRemaining(captureCents: number, refundedByPayPal: number, ledger: { refundedCents: number; openCents: number }, amountCents: number, currency: string): void {
  const left = captureCents - Math.max(refundedByPayPal, ledger.refundedCents) - ledger.openCents;
  if (amountCents > left) {
    throw new RefundRefused(
      "AMOUNT_ABOVE_REMAINING",
      `This payment has ${refundedAmount(Math.max(0, left), currency)} left to refund, and this line is ${refundedAmount(amountCents, currency)}. To refund what is left, do it in PayPal.`,
    );
  }
}

/** Everything a live capture must show before a person can approve this amount, or the approval can be spent. */
async function refusePayPalFacts(
  q: Queryable,
  client: PayPalClient,
  captureId: string,
  facts: { amountCents: number; currency: string; recallDate: string; now: Date },
): Promise<{ capture: CaptureFacts; refundedByPayPal: number }> {
  const capture = await readCapture(client, captureId);
  if (capture.currency !== facts.currency) throw new RefundRefused("PAYPAL_FACTS_CHANGED", "PayPal's currency differs from the approved one. Check the payment in PayPal.");
  if (capture.status === "REFUNDED") throw new RefundRefused("NOTHING_LEFT_TO_REFUND", "PayPal says this payment is already fully refunded. You can still send the notice.");
  if (capture.status !== "COMPLETED" && capture.status !== "PARTIALLY_REFUNDED") {
    await refuseHeld(client, captureId, capture);
  }
  refusePaymentDates(capture, facts.recallDate, facts.now);
  await refuseDisputed(client, captureId);
  const ledger = await ledgerOnCapture(q, captureId);
  const refundedByPayPal = await refundedPerPayPal(client, capture, ledger.knownRefundId);
  refuseAboveRemaining(capture.amountCents, refundedByPayPal, ledger, facts.amountCents, facts.currency);
  return { capture, refundedByPayPal };
}

async function readCapture(client: PayPalClient, captureId: string): Promise<CaptureFacts> {
  try {
    return await getCapture(client, captureId);
  } catch {
    throw new RefundRefused("PAYPAL_UNREACHABLE", "PayPal did not answer, so nothing was refunded. Please try again.");
  }
}

/** Within 180 days of the payment, and paid after the recall date, whatever the order date says. */
function refusePaymentDates(capture: CaptureFacts, recallDate: string, now: Date): void {
  const paidAt = Date.parse(capture.createTime ?? "");
  if (Number.isNaN(paidAt)) throw new RefundRefused("PAYPAL_FACTS_CHANGED", "PayPal gave no readable date for this payment. Check the payment in PayPal.");
  if (now.getTime() - paidAt > REFUND_WINDOW_DAYS * 86_400_000) {
    throw new RefundRefused("REFUND_WINDOW_CLOSED", "PayPal refund window closed. Check the recall page for the next steps.");
  }
  const paidOn = businessDay(new Date(paidAt));
  if (paidOn <= recallDate) {
    throw new RefundRefused("PAYMENT_NOT_AFTER_RECALL", "PayPal's payment date is not after the recall date. You can still send the notice.");
  }
}

/** Sends one stored refund and records PayPal's answer. Repeating it with the same request id makes no second refund. */
async function sendRefund(
  db: Queryable,
  client: PayPalClient,
  send: { rowId: string; requestId: string; captureId: string; amountCents: number; currency: string; note: string; repeat: boolean; holder: string; startedAt: number },
  recordKey: RecordKey,
  now: Date,
): Promise<RefundOutcome> {
  const settle = async (answer: RefundOutcome["status"], failure: string | null, refundId?: string) => {
    // A refund id is a fact whichever answer wins, so it is kept even when this answer is too late to count.
    if (refundId) {
      await db.query("update paypal_refund_refs set refund_id = $2 where refund_row_id = $1", [send.rowId, refundId]);
      await db.query("update refunds set refund_ref_hmac = coalesce(refund_ref_hmac, $2) where id = $1", [send.rowId, recordKey("paypal-resource", refundId)]);
    }
    const status = await moveLedger(db, send.rowId, answer, now, { failure, holder: send.holder });
    return { refundId: send.rowId, status, amountCents: send.amountCents, currency: send.currency, failure: status === answer ? failure : null };
  };

  // From here the outcome is unknown. A send that lost the row or outlived its lease must not go out at all,
  // because a reservation past its lease may be given up and the line freed.
  const sendAt = Date.parse(timeSince(send.startedAt, now));
  const realSendAt = Date.now(); // read before any waiting, so a pause below cannot move the deadline
  const sending = await db.query<{ send_lease_until: Date }>(
    `update refunds set status = 'unconfirmed', updated_at = $3::timestamptz
     where id = $1 and send_lease_id = $2 and status in ('reserved', 'unconfirmed') and send_lease_until > $4::timestamptz and dispute_seen_at is null
     returning send_lease_until`,
    [send.rowId, send.holder, new Date(sendAt).toISOString(), new Date(sendAt + LAST_ATTEMPT_MS).toISOString()],
  );
  if (sending.rows.length === 0) {
    const { rows } = await db.query<{ status: RefundOutcome["status"]; failure: string | null }>("select status, failure from refunds where id = $1", [send.rowId]);
    return { refundId: send.rowId, status: rows[0].status, amountCents: send.amountCents, currency: send.currency, failure: rows[0].failure };
  }

  try {
    // An attempt begun in time finishes inside the lease, and nobody is sent to refund by hand until the lease
    // ends. So a send held up for any reason, including between attempts, cannot land after that.
    const usableLease = sending.rows[0].send_lease_until.getTime() - sendAt - LAST_ATTEMPT_MS;
    const { data } = await client.request<{ id: string; status: string }>("POST", `/v2/payments/captures/${send.captureId}/refund`, {
      requestId: send.requestId,
      body: { amount: { currency_code: send.currency, value: centsToValue(send.amountCents) }, note_to_payer: send.note },
      notAfter: realSendAt + usableLease,
    });
    const status = ledgerStatusFor(data.status);
    return await settle(status, status === "failed" ? `PayPal status ${data.status}` : null, data.id);
  } catch (err) {
    // "Failed" frees the line for a new request id. A repeat's refusal cannot prove the earlier send made
    // nothing, not even with the capture reading COMPLETED while a refund settles, so a person checks.
    if (clearlyRefused(err)) {
      if (!send.repeat) return settle("failed", err.issue ?? `HTTP ${err.status}`);
      await db.query("update refunds set repeat_refused_at = coalesce(repeat_refused_at, $2::timestamptz) where id = $1", [send.rowId, now.toISOString()]);
      return settle("unconfirmed", `${REFUSED_REPEAT} (${err.issue ?? `HTTP ${err.status}`}). Check PayPal directly before doing anything else.`);
    }
    return settle("unconfirmed", "No clear answer from PayPal. Check it before trying again.");
  }
}

/**
 * Recovers a refund whose answer was lost: repeats the stored request, with the same capture, amount,
 * currency and request id. Measured 2026-11-05: PayPal answers a repeated id with the original refund, and
 * it ignores a changed amount, so this always sends what the row holds. It is a person's explicit action.
 */
/** A disputed payment could be paid back twice. A stalled refund can be retried, and a second payout can't be taken back. */
async function refuseDisputed(client: PayPalClient, captureId: string): Promise<void> {
  const dispute = await disputeOnCapture(client, captureId);
  if (dispute === "DISPUTED") throw new RefundRefused("PAYMENT_DISPUTED", DISPUTED_MESSAGE);
  if (dispute === "UNREADABLE") throw new RefundRefused("DISPUTES_UNREADABLE", "PayPal's disputes could not be read, so nothing was refunded. Please try again.");
}

const DISPUTED_MESSAGE = "PayPal shows a dispute on this payment. Check it in PayPal first.";

/**
 * A payment PayPal won't refund as it stands. If the reason is a dispute, say so. A payment PayPal holds for
 * the buyer's complaint (PENDING, BUYER_COMPLAINT) names it alone, without waiting on the Disputes API.
 */
async function refuseHeld(client: PayPalClient, captureId: string, capture: CaptureFacts): Promise<never> {
  const disputed = new RefundRefused("PAYMENT_DISPUTED", DISPUTED_MESSAGE);
  if (capture.status === "PENDING" && capture.statusReason === "BUYER_COMPLAINT") throw disputed;
  // Unreadable disputes change nothing here: the status already refuses.
  if ((await disputeOnCapture(client, captureId)) === "DISPUTED") throw disputed;
  throw new RefundRefused("PAYPAL_FACTS_CHANGED", "PayPal's status for this payment does not allow a refund. Check the payment in PayPal.");
}

export async function askPayPalAgain(
  db: Queryable,
  client: PayPalClient,
  input: { shopId: string; refundId: string; recordKey: RecordKey; now?: Date },
): Promise<RefundOutcome> {
  const now = input.now ?? new Date();
  const startedAt = performance.now();
  const notFound = () => new RefundRefused("NO_SUCH_REFUND", "No such refund for this shop. Go back to your queue.");
  if (!UUID.test(input.refundId)) throw notFound();
  const { rows } = await db.query<{
    status: string;
    amount_cents: number;
    currency: string;
    request_id: string;
    created_at: Date;
    capture_id: string | null;
    paypal_refund_id: string | null;
    recall_id: number;
    recall_sha256: string;
    order_line_id: string;
    line_sha256: string | null;
    paypal_payment_id: string | null;
    repeat_refused_at: Date | null;
    seller_sent_to_paypal_at: Date | null;
    dispute_seen_at: Date | null;
    send_lease_until: Date | null;
  }>(
    `select r.status, r.amount_cents, r.currency, r.request_id, r.created_at, r.repeat_refused_at, r.seller_sent_to_paypal_at, r.dispute_seen_at, r.send_lease_until, p.capture_id, p.refund_id as paypal_refund_id,
            a.recall_id, a.recall_sha256, a.order_line_id, a.line_sha256, a.paypal_payment_id
     from refunds r join approvals a on a.id = r.approval_id left join paypal_refund_refs p on p.refund_row_id = r.id
     where r.id = $1 and r.shop_id = $2`,
    [input.refundId, input.shopId],
  );
  const row = rows[0];
  if (!row) throw notFound();
  if (row.status === "reserved") throw new RefundRefused("REFUND_BEING_SENT", "PayPal is still being asked. Try again in a few minutes.");
  if (row.status !== "unconfirmed" || row.paypal_refund_id) {
    throw new RefundRefused("NOTHING_TO_ASK", "PayPal already has a record of this refund. Check it against PayPal.");
  }
  // Another send may be on its way to PayPal, so wait for it. Reading PayPal now would act on an answer it could overtake.
  if (row.send_lease_until && row.send_lease_until.getTime() > now.getTime()) throw new RefundRefused("REFUND_BEING_SENT", "PayPal is still being asked. Try again in a few minutes.");
  const checkInPayPal = () => new RefundRefused("CHECK_IN_PAYPAL", "This one is with PayPal now. Check the payment there.");
  const disputedAgain = () => new RefundRefused("PAYMENT_DISPUTED", "PayPal shows a dispute on this payment. Check it in PayPal first.");
  if (row.dispute_seen_at) throw disputedAgain();
  // A person may have refunded it by hand from here on, and a repeat could then make a second refund.
  if (row.seller_sent_to_paypal_at || row.repeat_refused_at) throw checkInPayPal();
  if (!row.capture_id) throw new RefundRefused("PAYPAL_FACTS_AGED_OUT", "PayPal's record of this sale is no longer held here. Check PayPal directly.");
  const tooOldNow = () => new RefundRefused("TOO_OLD_TO_ASK_AGAIN", "This request is too old to send again safely. Check PayPal directly.");
  if (tooOldToRepeat(row.created_at, now.getTime())) throw tooOldNow();
  // A first send's checks, except what this refund could itself have changed if it landed: a capture showing a refund,
  // and the amount left. If the first request never reached PayPal, this is the real first refund, so disputes are read too.
  const { recallDate, note } = await approvedFactsHold(db, row);
  const today = businessDay(now);
  if ((await identifiedCapture(db, input.shopId, row.order_line_id, row.paypal_payment_id, today)) !== row.capture_id) {
    throw new RefundRefused("PAYMENT_CHANGED", "The PayPal payment for this order line has changed. Please review it again.");
  }
  const capture = await readCapture(client, row.capture_id);
  if (capture.currency !== row.currency) throw new RefundRefused("PAYPAL_FACTS_CHANGED", "PayPal's currency differs from the approved one. Check the payment in PayPal.");
  if (capture.status !== "COMPLETED" && capture.status !== "PARTIALLY_REFUNDED" && capture.status !== "REFUNDED") {
    throw new RefundRefused("PAYPAL_FACTS_CHANGED", "PayPal's status for this payment does not allow a refund. Check the payment in PayPal.");
  }
  refusePaymentDates(capture, recallDate, now);
  // The first request may have landed, so this can't say nothing was refunded. A dispute settles it: the owner looks in PayPal.
  const dispute = await disputeOnCapture(client, row.capture_id);
  if (dispute === "UNREADABLE") throw new RefundRefused("DISPUTES_UNREADABLE", "PayPal's disputes could not be read, so this wasn't sent again. Please try again.");
  if (dispute === "DISPUTED") {
    await db.query("update refunds set dispute_seen_at = coalesce(dispute_seen_at, $2::timestamptz) where id = $1 and status = 'unconfirmed'", [input.refundId, now.toISOString()]);
    throw disputedAgain();
  }

  // Those checks can take minutes, so the limit and the lease are read on the clock as it stands now.
  const claimAt = timeSince(startedAt, now);
  if (tooOldToRepeat(row.created_at, Date.parse(claimAt))) throw tooOldNow();
  const claimed = await db.query<{ send_lease_id: string }>(
    `update refunds set send_lease_until = $2::timestamptz, send_lease_id = gen_random_uuid(), updated_at = $3::timestamptz
     where id = $1 and status = 'unconfirmed' and (send_lease_until is null or send_lease_until <= $3::timestamptz)
       and seller_sent_to_paypal_at is null and repeat_refused_at is null and dispute_seen_at is null
     returning send_lease_id`,
    [input.refundId, leaseEnd(startedAt, now), claimAt],
  );
  const holder = claimed.rows[0]?.send_lease_id;
  if (!holder) {
    const { rows: latest } = await db.query<{ seller_sent_to_paypal_at: Date | null; repeat_refused_at: Date | null; dispute_seen_at: Date | null }>(
      "select seller_sent_to_paypal_at, repeat_refused_at, dispute_seen_at from refunds where id = $1",
      [input.refundId],
    );
    if (latest[0].dispute_seen_at) throw disputedAgain();
    if (latest[0].seller_sent_to_paypal_at || latest[0].repeat_refused_at) throw checkInPayPal();
    throw new RefundRefused("REFUND_BEING_SENT", "PayPal is still being asked. Try again in a few minutes.");
  }

  return sendRefund(
    db,
    client,
    { rowId: input.refundId, requestId: row.request_id, captureId: row.capture_id, amountCents: row.amount_cents, currency: row.currency, note, repeat: true, holder, startedAt },
    input.recordKey,
    now,
  );
}

/** Records that the seller was sent to look in PayPal. It changes nothing else: the line stays blocked. */
export async function sendSellerToPayPal(db: Queryable, input: { shopId: string; refundId: string; now?: Date }): Promise<void> {
  const now = input.now ?? new Date();
  const notFound = () => new RefundRefused("NO_SUCH_REFUND", "No such refund for this shop. Go back to your queue.");
  if (!UUID.test(input.refundId)) throw notFound();
  const { rows } = await db.query<{ status: string }>("select status from refunds where id = $1 and shop_id = $2", [input.refundId, input.shopId]);
  if (!rows[0]) throw notFound();
  if (rows[0].status !== "unconfirmed") throw new RefundRefused("NOTHING_TO_ASK", "This refund already has a clear answer. Check it against PayPal.");
  const sent = await db.query(
    `update refunds set seller_sent_to_paypal_at = coalesce(seller_sent_to_paypal_at, $2::timestamptz)
     where id = $1 and status = 'unconfirmed' and (send_lease_until is null or send_lease_until <= $2::timestamptz)
     returning id`,
    [input.refundId, now.toISOString()],
  );
  if (sent.rows.length === 0) throw new RefundRefused("REFUND_BEING_SENT", "PayPal is still being asked. Try again in a few minutes.");
}

const REFUSED_REPEAT = "PayPal refused the repeat";

const refundSchema = z.object({
  id: z.string(),
  status: z.string(),
  amount: z.object({ currency_code: z.string(), value: z.string() }),
});

export interface Reconciliation {
  /** The match this refund was approved on, whose card a seller came from. */
  matchId: string | null;
  /** No clear answer, and it is still safe to repeat the stored request. */
  canAskAgain: boolean;
  /** No clear answer and no PayPal refund id. Only PayPal itself can say what happened. */
  /** With a dispute on the payment, the owner must not be told to refund by hand: PayPal may already have paid the buyer. */
  stuck: { orderNumber: string; sentToPayPal: boolean; disputed: boolean } | null;
  /** What PayPal's answer says this row should now be, while a read has not changed it. */
  newerAnswer: RefundOutcome["status"] | null;
  ledger: { status: string; amountCents: number; currency: string };
  capture: { status: string; amountCents: number; currency: string } | null;
  refund: { status: string; amountCents: number; currency: string } | null;
  /**
   * PayPal's refund event. paypalCheck is PayPal's own answer about the delivery, asked after ours passed: ASKING for
   * its first minute, then UNAVAILABLE if no answer was recorded. event is the refund's status and amount as the event said.
   */
  webhook: { seen: boolean; paypalCheck: "SUCCESS" | "FAILURE" | "UNAVAILABLE" | "ASKING" | null; event: { status: string | null; amountCents: number | null; currency: string | null } | null };
  exceptions: string[];
}

/** How long PayPal's own check may still be on its way before no answer counts as none. */
const PAYPAL_CHECK_GRACE_MS = 60_000;

interface ReconcileInput {
  shopId: string;
  refundId: string;
  recordKey: RecordKey;
  now?: Date;
}

/** Capture, refund, webhook and our ledger side by side. Settles a pending or unconfirmed refund from PayPal's answer. */
/** What opening the refund page does: reads ours and PayPal's records, and changes nothing. */
export const readRefund = (db: Queryable, client: PayPalClient, input: ReconcileInput) => reconcile(db, client, input, false);

/** A person asked for it: brings the ledger up to date with PayPal's answer. */
export const reconcileRefund = (db: Queryable, client: PayPalClient, input: ReconcileInput) => reconcile(db, client, input, true);

async function reconcile(db: Queryable, client: PayPalClient, input: ReconcileInput, write: boolean): Promise<Reconciliation> {
  const now = input.now ?? new Date();
  const notFound = () => new RefundRefused("NO_SUCH_REFUND", "No such refund for this shop. Go back to your queue.");
  if (!UUID.test(input.refundId)) throw notFound();
  const { rows } = await db.query<{
    status: RefundOutcome["status"];
    amount_cents: number;
    currency: string;
    refund_ref_hmac: string | null;
    created_at: Date;
    send_lease_until: Date | null;
    failure: string | null;
    repeat_refused_at: Date | null;
    seller_sent_to_paypal_at: Date | null;
    dispute_seen_at: Date | null;
    order_number: string;
    capture_id: string | null;
    paypal_refund_id: string | null;
    match_id: string | null;
  }>(
    `select r.status, r.amount_cents, r.currency, r.refund_ref_hmac, r.created_at, r.send_lease_until, r.failure, r.repeat_refused_at, r.dispute_seen_at, r.seller_sent_to_paypal_at,
            l.order_number, p.capture_id, p.refund_id as paypal_refund_id,
            (select m.id from approvals a join recall_matches m on m.shop_id = a.shop_id and m.recall_id = a.recall_id and m.order_line_id = a.order_line_id where a.id = r.approval_id limit 1) as match_id
     from refunds r join order_lines l on l.id = r.order_line_id left join paypal_refund_refs p on p.refund_row_id = r.id
     where r.id = $1 and r.shop_id = $2`,
    [input.refundId, input.shopId],
  );
  const row = rows[0];
  if (!row) throw notFound();

  const exceptions: string[] = [];
  const captureFacts = row.capture_id ? await getCapture(client, row.capture_id) : null;
  let refund: Reconciliation["refund"] = null;
  if (row.paypal_refund_id) {
    const { data } = await client.request("GET", `/v2/payments/refunds/${row.paypal_refund_id}`);
    const r = refundSchema.parse(data);
    refund = { status: r.status, amountCents: valueToCents(r.amount.value), currency: r.amount.currency_code };
  }

  const event = row.refund_ref_hmac
    ? (
        await db.query<{ paypal_check: "SUCCESS" | "FAILURE" | "UNAVAILABLE" | null; received_at: Date; resource_status: string | null; resource_amount_cents: number | null; resource_currency: string | null }>(
          "select paypal_check, received_at, resource_status, resource_amount_cents, resource_currency from paypal_webhook_events where resource_id_hmac = $1 order by received_at desc limit 1",
          [row.refund_ref_hmac],
        )
      ).rows[0] ?? null
    : null;
  const webhookSeen = event !== null;
  const paypalCheck: Reconciliation["webhook"]["paypalCheck"] = !event
    ? null
    : (event.paypal_check ?? (now.getTime() - new Date(event.received_at).getTime() < PAYPAL_CHECK_GRACE_MS ? "ASKING" : "UNAVAILABLE"));
  const eventFacts = event ? { status: event.resource_status, amountCents: event.resource_amount_cents, currency: event.resource_currency } : null;

  // Our ledger follows PayPal's own answer about the refund.
  let status = row.status;
  let newerAnswer: RefundOutcome["status"] | null = null;
  if (status === "reserved") {
    const leaseOver = row.send_lease_until === null || row.send_lease_until.getTime() <= now.getTime();
    if (write) status = await giveUpIfNeverSent(db, input.refundId, now);
    else if (leaseOver) newerAnswer = "failed";
  } else if (status === "pending" || status === "unconfirmed") {
    let answer: RefundOutcome["status"] = status;
    if (refund?.status === "COMPLETED") answer = "refunded";
    else if (refund?.status === "FAILED" || refund?.status === "CANCELLED") answer = "failed";
    else if (!webhookSeen && now.getTime() - row.created_at.getTime() > UNCONFIRMED_AFTER_MS) answer = "unconfirmed";
    if (write) status = await moveLedger(db, input.refundId, answer, now);
    else if (answer !== status) newerAnswer = answer;
  }

  // The records can't agree while one of them is out of date, however they read.
  if (newerAnswer) exceptions.push("PayPal's answer is newer than our ledger. Update it below.");
  if (!row.capture_id) exceptions.push("PayPal's record of this refund has aged out here. Check PayPal directly.");
  // One way forward at a time. Telling a seller to refund by hand while a send may be running, or while a
  // repeat is still on offer, could end in two refunds of one sale.
  const noAnswer = status === "unconfirmed" && !row.paypal_refund_id;
  const sendMayBeRunning = row.send_lease_until !== null && row.send_lease_until.getTime() > now.getTime();
  const refusedRepeat = row.repeat_refused_at !== null;
  const sentToPayPal = row.seller_sent_to_paypal_at !== null;
  const tooOld = tooOldToRepeat(row.created_at, now.getTime());
  const disputed = row.dispute_seen_at !== null;
  const canAskAgain = noAnswer && row.capture_id !== null && !sendMayBeRunning && !refusedRepeat && !sentToPayPal && !tooOld && !disputed;
  const stuck = noAnswer && !sendMayBeRunning && !canAskAgain ? { orderNumber: row.order_number, sentToPayPal, disputed } : null;
  if (noAnswer && row.capture_id !== null && tooOld) exceptions.push("This request is too old to send again safely. Check PayPal directly.");
  if (status === "reserved") exceptions.push("This refund has not been sent to PayPal yet.");
  if (status === "unconfirmed") exceptions.push("No clear answer from PayPal yet. Check it before trying again.");
  if (status === "unconfirmed" && row.failure?.startsWith(REFUSED_REPEAT)) exceptions.push(row.failure);
  if (refund && (refund.amountCents !== row.amount_cents || refund.currency !== row.currency)) {
    exceptions.push("PayPal's refund amount differs from the ledger.");
  }
  if (status === "refunded" && captureFacts && captureFacts.status !== "REFUNDED" && captureFacts.status !== "PARTIALLY_REFUNDED") {
    exceptions.push("The ledger says refunded, but PayPal's payment does not show a refund.");
  }
  if (refund && eventFacts?.status && eventFacts.status !== refund.status) {
    exceptions.push(`PayPal's refund event says ${eventFacts.status}, and PayPal's refund reads ${refund.status}.`);
  }
  if (refund && eventFacts?.amountCents != null && (eventFacts.amountCents !== refund.amountCents || eventFacts.currency !== refund.currency)) {
    exceptions.push("PayPal's refund event gives another amount than PayPal's refund.");
  }
  if (paypalCheck === "FAILURE") exceptions.push("PayPal's own check didn't confirm this webhook. Our check did, so it was kept.");
  if (refund?.status === "PENDING") exceptions.push("PayPal hasn't finished this refund yet.");
  else if (!webhookSeen && status !== "failed" && status !== "reserved") exceptions.push("PayPal's webhook has not arrived yet.");

  return {
    matchId: row.match_id,
    canAskAgain,
    stuck,
    newerAnswer,
    ledger: { status, amountCents: row.amount_cents, currency: row.currency },
    capture: captureFacts ? { status: captureFacts.status, amountCents: captureFacts.amountCents, currency: captureFacts.currency } : null,
    refund,
    webhook: { seen: webhookSeen, paypalCheck, event: eventFacts },
    exceptions,
  };
}
