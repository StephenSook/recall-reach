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
import { z } from "zod";
import type { Db, Queryable } from "../db/types";
import { normalizeOrderNumber } from "../match/join";
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
  | "PAYPAL_FACTS_AGED_OUT"
  | "PAYPAL_FACTS_CHANGED"
  | "PAYPAL_UNREACHABLE"
  | "REFUND_WINDOW_CLOSED"
  | "PAYMENT_NOT_AFTER_RECALL"
  | "NOTHING_LEFT_TO_REFUND"
  | "REMAINING_UNKNOWN"
  | "AMOUNT_ABOVE_REMAINING"
  | "NO_SUCH_REFUND";

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
  const { rows } = await db.query<{
    verdict: string;
    sale_path: string | null;
    join_state: string | null;
    recall_id: number;
    recall_sha256: string;
    order_line_id: string | null;
    unit_price_cents: number;
    quantity: number;
    discount_cents: number;
    currency: string;
  }>(
    `select m.verdict, m.sale_path, m.join_state, m.recall_id, m.recall_sha256, m.order_line_id,
            l.unit_price_cents, l.quantity, l.discount_cents, l.currency
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
    `insert into approvals (shop_id, session_id, recall_id, recall_sha256, order_line_id, amount_cents, currency, expires_at)
     values ($1, $2, $3, $4, $5, $6, $7, $8::timestamptz) returning id`,
    [input.shopId, input.sessionId, m.recall_id, m.recall_sha256, m.order_line_id, amountCents, m.currency, expiresAt],
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
    amount_cents: number;
    currency: string;
  }>(
    `select recall_id, recall_sha256, order_line_id, amount_cents, currency from approvals
     where id = $1 and shop_id = $2 and session_id = $3 and consumed_at is null and expires_at > $4::timestamptz`,
    [input.approvalId, input.shopId, input.sessionId, now.toISOString()],
  );
  const approval = found.rows[0];
  if (!approval) throw invalid();

  const recall = (
    await db.query<{ raw_sha256: string; recall_date: string }>("select raw_sha256, recall_date from recalls where recall_id = $1", [
      approval.recall_id,
    ])
  ).rows[0];
  if (recall.raw_sha256 !== approval.recall_sha256) {
    throw new RefundRefused("RECALL_CHANGED", "CPSC changed this recall after the approval. Please review it again.");
  }

  const line = (
    await db.query<{ order_number: string; ordered_on: string }>("select order_number, ordered_on from order_lines where id = $1", [
      approval.order_line_id,
    ])
  ).rows[0];
  if (line.ordered_on <= recall.recall_date) {
    throw new RefundRefused("NOT_REFUND_ELIGIBLE", "Only a sale dated after the recall date can be refunded here.");
  }

  const payments = await db.query<{ order_number: string | null; capture_id: string | null }>(
    "select order_number, capture_id from paypal_payments where shop_id = $1",
    [input.shopId],
  );
  const payment = payments.rows.find(
    (p) => p.order_number !== null && normalizeOrderNumber(p.order_number) === normalizeOrderNumber(line.order_number),
  );
  if (!payment?.capture_id) {
    throw new RefundRefused("PAYPAL_FACTS_AGED_OUT", "PayPal's record of this sale is no longer held here. Read it from PayPal again.");
  }

  let capture: CaptureFacts;
  try {
    capture = await getCapture(client, payment.capture_id);
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
  if (paidOn <= recall.recall_date) {
    throw new RefundRefused("PAYMENT_NOT_AFTER_RECALL", "PayPal's payment date is not after the recall date.");
  }

  let remaining = capture.amountCents;
  if (capture.status === "PARTIALLY_REFUNDED") {
    const ledger = await db.query<{ total: string }>(
      `select coalesce(sum(r.amount_cents), 0)::text as total
       from refunds r join paypal_refund_refs p on p.refund_row_id = r.id
       where p.capture_id = $1 and r.status <> 'failed'`,
      [payment.capture_id],
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

  // One statement, so two callers cannot both spend the same approval.
  const consumed = await db.query(
    `update approvals set consumed_at = $4::timestamptz
     where id = $1 and shop_id = $2 and session_id = $3 and consumed_at is null and expires_at > $4::timestamptz
     returning id`,
    [input.approvalId, input.shopId, input.sessionId, now.toISOString()],
  );
  if (consumed.rows.length === 0) throw invalid();

  const row = (
    await db.query<{ id: string; request_id: string }>(
      `insert into refunds (approval_id, shop_id, order_line_id, amount_cents, currency, status)
       values ($1, $2, $3, $4, $5, 'pending') returning id, request_id`,
      [input.approvalId, input.shopId, approval.order_line_id, approval.amount_cents, approval.currency],
    )
  ).rows[0];
  await db.query("insert into paypal_refund_refs (refund_row_id, capture_id) values ($1, $2)", [row.id, payment.capture_id]);

  const settle = async (status: RefundOutcome["status"], failure: string | null, refundId?: string) => {
    if (refundId) await db.query("update paypal_refund_refs set refund_id = $2 where refund_row_id = $1", [row.id, refundId]);
    await db.query(
      `update refunds set status = $2, failure = $3, refund_ref_hmac = coalesce($4, refund_ref_hmac), updated_at = $5::timestamptz where id = $1`,
      [row.id, status, failure, refundId ? input.recordKey("paypal-resource", refundId) : null, now.toISOString()],
    );
    return { refundId: row.id, status, amountCents: approval.amount_cents, currency: approval.currency, failure };
  };

  try {
    const { data } = await client.request<{ id: string; status: string }>("POST", `/v2/payments/captures/${payment.capture_id}/refund`, {
      requestId: row.request_id,
      body: { amount: { currency_code: approval.currency, value: centsToValue(approval.amount_cents) } },
    });
    const status = data.status === "COMPLETED" ? "refunded" : data.status === "PENDING" ? "pending" : "failed";
    return await settle(status, status === "failed" ? `PayPal status ${data.status}` : null, data.id);
  } catch (err) {
    // A clear refusal from PayPal moved no money. Anything else may have: it stays unconfirmed.
    if (err instanceof PayPalApiError && err.status < 500) return settle("failed", err.issue ?? `HTTP ${err.status}`);
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
