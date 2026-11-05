// Approvals and refunds. The agent or the app may propose; only a person's approval moves money.
//
// An approval binds shop, session, recall version, order line, exact amount and currency, expires
// in 15 minutes, and is consumed once, atomically. Executing it re-reads the capture from PayPal and
// refuses on any mismatch. Capture contract (payments_payment_v2.json, read 2026-11-05): status is
// COMPLETED, PARTIALLY_REFUNDED, REFUNDED, PENDING, DECLINED or FAILED, and the refunded total is
// only on refund resources. So what is left comes from the live status plus our ledger, and PayPal's
// own REFUND_AMOUNT_EXCEEDED is the backstop. "You can send a full or partial refund within 180 days
// of the payment date" (paypal.com help, how-do-i-issue-a-refund).
//
// Raw PayPal ids stay in paypal_refund_refs (46-hour purge); the ledger holds only an HMAC.
import { createHash } from "node:crypto";
import { z } from "zod";
import type { Db, Queryable } from "../db/types";
import { joinShop } from "../match/run";
import type { RecordKey } from "../privacy/recordKey";
import { PayPalApiError, type PayPalClient } from "./client";
import { centsToValue, getCapture, valueToCents, type CaptureFacts } from "./orders";

const APPROVAL_MS = 15 * 60_000;
const REFUND_WINDOW_DAYS = 180;
const UNCONFIRMED_AFTER_MS = 10 * 60_000;
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
  | "REFUND_WINDOW_CLOSED"
  | "PAYMENT_NOT_AFTER_RECALL"
  | "NOTHING_LEFT_TO_REFUND"
  | "REMAINING_UNKNOWN"
  | "AMOUNT_ABOVE_REMAINING"
  | "NO_SUCH_REFUND";

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

export const refundedAmount = (cents: number, currency: string) => `${centsToValue(cents)} ${currency}`;

const LINE_COLUMNS = "order_number, line_no, title, sku, quantity, unit_price_cents, discount_cents, currency, ordered_on";

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
}

/** Everything a refund amount or decision rests on. JSON, so no field can run into the next. */
const lineVersion = (l: LineFacts) =>
  createHash("sha256")
    .update(JSON.stringify([l.order_number, l.line_no, l.title, l.sku, l.quantity, l.unit_price_cents, l.discount_cents, l.currency, l.ordered_on]))
    .digest("hex");

/** Refuses unless the recall and the line are still what the person approved. Returns the dates that decide eligibility. */
async function approvedFactsHold(
  q: Queryable,
  approval: { recall_id: number; recall_sha256: string; order_line_id: string; line_sha256: string | null },
): Promise<{ recallDate: string; orderedOn: string }> {
  const recall = (
    await q.query<{ raw_sha256: string; recall_date: string }>("select raw_sha256, recall_date from recalls where recall_id = $1", [approval.recall_id])
  ).rows[0];
  if (recall.raw_sha256 !== approval.recall_sha256) {
    throw new RefundRefused("RECALL_CHANGED", "CPSC changed this recall after the approval. Please review it again.");
  }
  const line = (await q.query<LineFacts>(`select ${LINE_COLUMNS} from order_lines where id = $1`, [approval.order_line_id])).rows[0];
  if (lineVersion(line) !== approval.line_sha256) {
    throw new RefundRefused("LINE_CHANGED", "This order line changed after the approval. Please review it again.");
  }
  return { recallDate: recall.recall_date, orderedOn: line.ordered_on };
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
  input: { shopId: string; sessionId: string; matchId: string; now?: Date },
): Promise<Approval> {
  const now = input.now ?? new Date();
  if (!UUID.test(input.matchId)) throw new RefundRefused("NO_SUCH_MATCH", "No such match for this shop.");
  const { rows } = await db.query<
    LineFacts & {
      verdict: string;
      sale_path: string | null;
      join_state: string | null;
      recall_id: number;
      recall_sha256: string;
      order_line_id: string | null;
      paypal_payment_id: string | null;
    }
  >(
    `select m.verdict, m.sale_path, m.join_state, m.recall_id, m.recall_sha256, m.order_line_id, m.paypal_payment_id,
            ${LINE_COLUMNS.split(", ")
              .map((c) => `l.${c}`)
              .join(", ")}
     from recall_matches m join order_lines l on l.id = m.order_line_id
     where m.id = $1 and m.shop_id = $2`,
    [input.matchId, input.shopId],
  );
  const m = rows[0];
  if (!m || !m.order_line_id) throw new RefundRefused("NO_SUCH_MATCH", "No such match for this shop.");
  if (m.verdict !== "MATCH") throw new RefundRefused("NOT_A_CONFIRMED_MATCH", "A refund needs a confirmed match.");
  if (m.sale_path !== "REFUND_ELIGIBLE") {
    throw new RefundRefused("NOT_REFUND_ELIGIBLE", "Only a sale dated after the recall date can be refunded here.");
  }
  if (m.join_state !== "IDENTIFIED") {
    throw new RefundRefused("JOIN_NOT_IDENTIFIED", "This order line is not linked to exactly one PayPal payment.");
  }
  await identifiedCapture(db, input.shopId, m.order_line_id, m.paypal_payment_id, now.toISOString().slice(0, 10));
  const open = await db.query("select 1 from refunds where order_line_id = $1 and status <> 'failed'", [m.order_line_id]);
  if (open.rows.length > 0) {
    throw new RefundRefused("REFUND_ALREADY_IN_PROGRESS", "A refund for this order line already exists.");
  }
  const amountCents = refundAmountCents({
    unitPriceCents: m.unit_price_cents,
    quantity: m.quantity,
    discountCents: m.discount_cents,
  });
  if (amountCents <= 0) throw new RefundRefused("NOTHING_LEFT_TO_REFUND", "This line has nothing to refund.");

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
  status: "pending" | "refunded" | "failed" | "unconfirmed";
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
  const invalid = () => new RefundRefused("APPROVAL_NOT_VALID", "This approval is missing, expired, already used, or from another session.");
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

  const { recallDate, orderedOn } = await approvedFactsHold(db, approval);
  if (orderedOn <= recallDate) {
    throw new RefundRefused("NOT_REFUND_ELIGIBLE", "Only a sale dated after the recall date can be refunded here.");
  }

  const today = now.toISOString().slice(0, 10);
  const captureId = await identifiedCapture(db, input.shopId, approval.order_line_id, approval.paypal_payment_id, today);

  let capture: CaptureFacts;
  try {
    capture = await getCapture(client, captureId);
  } catch {
    throw new RefundRefused("PAYPAL_UNREACHABLE", "PayPal did not answer, so nothing was refunded. Please try again.");
  }
  if (capture.currency !== approval.currency) {
    throw new RefundRefused("PAYPAL_FACTS_CHANGED", "PayPal's currency differs from the approved one.");
  }
  if (capture.status === "REFUNDED") throw new RefundRefused("NOTHING_LEFT_TO_REFUND", "PayPal says this payment is already fully refunded.");
  if (capture.status !== "COMPLETED" && capture.status !== "PARTIALLY_REFUNDED") {
    throw new RefundRefused("PAYPAL_FACTS_CHANGED", "PayPal's status for this payment does not allow a refund.");
  }

  const paidOn = (capture.createTime ?? "").slice(0, 10);
  if (!paidOn) throw new RefundRefused("PAYPAL_FACTS_CHANGED", "PayPal gave no date for this payment.");
  if (now.getTime() - Date.parse(`${paidOn}T00:00:00Z`) > REFUND_WINDOW_DAYS * 86_400_000) {
    throw new RefundRefused("REFUND_WINDOW_CLOSED", "PayPal refund window closed.");
  }
  if (paidOn <= recallDate) {
    throw new RefundRefused("PAYMENT_NOT_AFTER_RECALL", "PayPal's payment date is not after the recall date.");
  }

  let remaining = capture.amountCents;
  if (capture.status === "PARTIALLY_REFUNDED") {
    const ledger = await db.query<{ total: string }>(
      `select coalesce(sum(r.amount_cents), 0)::text as total
       from refunds r join paypal_refund_refs p on p.refund_row_id = r.id
       where p.capture_id = $1 and r.status <> 'failed'`,
      [captureId],
    );
    const known = Number(ledger.rows[0].total);
    if (known === 0) {
      throw new RefundRefused("REMAINING_UNKNOWN", "This payment was partly refunded outside this app. Check PayPal first.");
    }
    remaining = capture.amountCents - known;
  }
  if (approval.amount_cents > remaining) {
    throw new RefundRefused("AMOUNT_ABOVE_REMAINING", "The approved amount is more than this payment has left to refund.");
  }

  // Spending the approval, reserving the line and recording the intent happen together or not at all.
  // The lock serializes reservations on one capture, so two lines cannot both claim the same balance.
  const row = await db.transaction(async (tx) => {
    await approvedFactsHold(tx, approval);
    if ((await identifiedCapture(tx, input.shopId, approval.order_line_id, approval.paypal_payment_id, today)) !== captureId) {
      throw new RefundRefused("PAYMENT_CHANGED", "The PayPal payment for this order line has changed. Please review it again.");
    }
    await tx.query("select pg_advisory_xact_lock(hashtextextended($1, 0))", [captureId]);
    const reservedOnCapture = await tx.query<{ total: string }>(
      `select coalesce(sum(r.amount_cents), 0)::text as total
       from refunds r join paypal_refund_refs p on p.refund_row_id = r.id
       where p.capture_id = $1 and r.status <> 'failed'`,
      [captureId],
    );
    if (Number(reservedOnCapture.rows[0].total) + approval.amount_cents > capture.amountCents) {
      throw new RefundRefused("AMOUNT_ABOVE_REMAINING", "The approved amount is more than this payment has left to refund.");
    }
    const consumed = await tx.query(
      `update approvals set consumed_at = $4::timestamptz
       where id = $1 and shop_id = $2 and session_id = $3 and consumed_at is null and expires_at > $4::timestamptz
       returning id`,
      [input.approvalId, input.shopId, input.sessionId, now.toISOString()],
    );
    if (consumed.rows.length === 0) throw invalid();
    const inserted = await tx.query<{ id: string; request_id: string }>(
      `insert into refunds (approval_id, shop_id, order_line_id, amount_cents, currency, status)
       values ($1, $2, $3, $4, $5, 'pending')
       on conflict (order_line_id) where status <> 'failed' do nothing
       returning id, request_id`,
      [input.approvalId, input.shopId, approval.order_line_id, approval.amount_cents, approval.currency],
    );
    const reserved = inserted.rows[0];
    if (!reserved) throw new RefundRefused("REFUND_ALREADY_IN_PROGRESS", "A refund for this order line already exists.");
    await tx.query("insert into paypal_refund_refs (refund_row_id, capture_id) values ($1, $2)", [reserved.id, captureId]);
    return reserved;
  });

  const settle = async (status: RefundOutcome["status"], failure: string | null, refundId?: string) => {
    if (refundId) await db.query("update paypal_refund_refs set refund_id = $2 where refund_row_id = $1", [row.id, refundId]);
    await db.query(
      `update refunds set status = $2, failure = $3, refund_ref_hmac = coalesce($4, refund_ref_hmac), updated_at = $5::timestamptz where id = $1`,
      [row.id, status, failure, refundId ? input.recordKey("paypal-resource", refundId) : null, now.toISOString()],
    );
    return { refundId: row.id, status, amountCents: approval.amount_cents, currency: approval.currency, failure };
  };

  try {
    const { data } = await client.request<{ id: string; status: string }>("POST", `/v2/payments/captures/${captureId}/refund`, {
      requestId: row.request_id,
      body: { amount: { currency_code: approval.currency, value: centsToValue(approval.amount_cents) } },
    });
    const status = ledgerStatusFor(data.status);
    return await settle(status, status === "failed" ? `PayPal status ${data.status}` : null, data.id);
  } catch (err) {
    if (clearlyRefused(err)) return settle("failed", err.issue ?? `HTTP ${err.status}`);
    return settle("unconfirmed", "No clear answer from PayPal. Check it before trying again.");
  }
}

const refundSchema = z.object({
  id: z.string(),
  status: z.string(),
  amount: z.object({ currency_code: z.string(), value: z.string() }),
});

export interface Reconciliation {
  ledger: { status: string; amountCents: number; currency: string };
  capture: { status: string; amountCents: number; currency: string } | null;
  refund: { status: string; amountCents: number; currency: string } | null;
  webhook: { seen: boolean };
  exceptions: string[];
}

/** Capture, refund, webhook and our ledger side by side. Settles a pending or unconfirmed refund from PayPal's answer. */
export async function reconcileRefund(
  db: Queryable,
  client: PayPalClient,
  input: { shopId: string; refundId: string; recordKey: RecordKey; now?: Date },
): Promise<Reconciliation> {
  const now = input.now ?? new Date();
  const notFound = () => new RefundRefused("NO_SUCH_REFUND", "No such refund for this shop.");
  if (!UUID.test(input.refundId)) throw notFound();
  const { rows } = await db.query<{
    status: string;
    amount_cents: number;
    currency: string;
    refund_ref_hmac: string | null;
    created_at: Date;
    capture_id: string | null;
    paypal_refund_id: string | null;
  }>(
    `select r.status, r.amount_cents, r.currency, r.refund_ref_hmac, r.created_at, p.capture_id, p.refund_id as paypal_refund_id
     from refunds r left join paypal_refund_refs p on p.refund_row_id = r.id
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

  const webhookSeen = row.refund_ref_hmac
    ? (await db.query("select 1 from paypal_webhook_events where resource_id_hmac = $1", [row.refund_ref_hmac])).rows.length > 0
    : false;

  // Our ledger follows PayPal's own answer about the refund.
  let status = row.status;
  if (status === "pending" || status === "unconfirmed") {
    if (refund?.status === "COMPLETED") status = "refunded";
    else if (refund?.status === "FAILED" || refund?.status === "CANCELLED") status = "failed";
    else if (!webhookSeen && now.getTime() - row.created_at.getTime() > UNCONFIRMED_AFTER_MS) status = "unconfirmed";
    if (status !== row.status) {
      await db.query("update refunds set status = $2, updated_at = $3::timestamptz where id = $1", [input.refundId, status, now.toISOString()]);
    }
  }

  if (!row.capture_id) exceptions.push("PayPal's record of this refund has aged out here. Check PayPal directly.");
  if (status === "unconfirmed") exceptions.push("No clear answer from PayPal yet. Check it before trying again.");
  if (refund && (refund.amountCents !== row.amount_cents || refund.currency !== row.currency)) {
    exceptions.push("PayPal's refund amount differs from the ledger.");
  }
  if (status === "refunded" && captureFacts && captureFacts.status !== "REFUNDED" && captureFacts.status !== "PARTIALLY_REFUNDED") {
    exceptions.push("The ledger says refunded, but PayPal's payment does not show a refund.");
  }
  if (!webhookSeen && status !== "failed") exceptions.push("PayPal's webhook has not arrived yet.");

  return {
    ledger: { status, amountCents: row.amount_cents, currency: row.currency },
    capture: captureFacts ? { status: captureFacts.status, amountCents: captureFacts.amountCents, currency: captureFacts.currency } : null,
    refund,
    webhook: { seen: webhookSeen },
    exceptions,
  };
}
