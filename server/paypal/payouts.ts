// A separate sandbox payment for a sale past PayPal's 180-day refund window. A refund can't reach it, so an owner can choose to
// send one. Approved twice, for one exact amount, only to an email the owner typed, never PayPal's payer email. It never reads
// as paid until PayPal's item says so. Demo shops only: the sandbox app is shared, so no other shop may spend from it.
import type { Queryable } from "../db/types";
import type { ContactCipher } from "../privacy/contactCipher";
import type { RecordKey } from "../privacy/recordKey";
import { PayPalApiError, type PayPalClient } from "./client";
import { centsToValue } from "./orders";

/** A labelled sample, apart from the queue's cards and every count: a real recall, with a sale past the window. */
export const PAST_WINDOW_SAMPLE = {
  key: "past-window-26266",
  recallNumber: "26266",
  title: "CheerKid baby bath seat BH-222",
  soldOn: "2026-03-04",
  priceCents: 2400,
  currency: "USD",
} as const;

const REVIEW_LASTS_MS = 15 * 60_000;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type PayoutRefusal = "DEMO_ONLY" | "BAD_AMOUNT" | "BAD_EMAIL" | "ALREADY_SENT" | "NOT_VALID" | "NO_SUCH_PAYOUT" | "AGED_OUT" | "NO_ANSWER";

export class PayoutRefused extends Error {
  constructor(
    readonly code: PayoutRefusal,
    message: string,
  ) {
    super(message);
    this.name = "PayoutRefused";
  }
}

export type PayoutStatus = "reviewed" | "unconfirmed" | "paid" | "unclaimed" | "failed";

function centsFrom(amount: string): number | null {
  if (!/^\d+(\.\d{1,2})?$/.test(amount.trim())) return null;
  const [whole, part = ""] = amount.trim().split(".");
  return Number(whole) * 100 + Number(part.padEnd(2, "0"));
}

/** The first approval: one exact amount, to the email typed. Nothing goes to PayPal. */
export async function reviewPayout(
  db: Queryable,
  input: { shopId: string; sessionId: string; email: string; amount: string; cipher: ContactCipher; now: Date },
): Promise<{ id: string; amountCents: number }> {
  const { rows: shops } = await db.query<{ kind: string }>("select kind from shops where id = $1", [input.shopId]);
  if (shops[0]?.kind !== "DEMO") throw new PayoutRefused("DEMO_ONLY", "This is for a demo shop. A real shop's payment would need its own PayPal connected.");
  const cents = centsFrom(input.amount);
  if (cents === null || cents <= 0 || cents > PAST_WINDOW_SAMPLE.priceCents) {
    throw new PayoutRefused("BAD_AMOUNT", `Enter an amount up to ${centsToValue(PAST_WINDOW_SAMPLE.priceCents)} ${PAST_WINDOW_SAMPLE.currency}, what this sale was paid.`);
  }
  const email = input.email.trim();
  if (!EMAIL.test(email)) throw new PayoutRefused("BAD_EMAIL", "Enter the email the shop collected for this buyer.");
  const { rows } = await db.query<{ id: string }>(
    `insert into payouts (shop_id, session_id, sample_key, receiver_enc, amount_cents, currency, status, expires_at)
     values ($1, $2, $3, $4, $5, $6, 'reviewed', $7)
     on conflict (shop_id, sample_key) do update set session_id = excluded.session_id, receiver_enc = excluded.receiver_enc, amount_cents = excluded.amount_cents,
       status = 'reviewed', paypal_status = null, batch_ref_hmac = null, expires_at = excluded.expires_at, request_id = gen_random_uuid(), updated_at = now()
     where payouts.status in ('reviewed', 'failed')
     returning id`,
    [input.shopId, input.sessionId, PAST_WINDOW_SAMPLE.key, input.cipher.seal(email), cents, PAST_WINDOW_SAMPLE.currency, new Date(input.now.getTime() + REVIEW_LASTS_MS).toISOString()],
  );
  if (!rows[0]) throw new PayoutRefused("ALREADY_SENT", "This payment has already gone to PayPal. Check it against PayPal.");
  // A new approval is a new payment. What PayPal says about the old batch no longer applies to it.
  await db.query("delete from paypal_payout_refs where payout_row_id = $1", [rows[0].id]);
  return { id: rows[0].id, amountCents: cents };
}

const clearlyRefused = (err: unknown): err is PayPalApiError => err instanceof PayPalApiError && err.status >= 400 && err.status < 500 && !err.uncertain;

/** The second approval. One request ever goes: a lost answer stays unconfirmed for a person to check, and isn't sent again. */
export async function sendPayout(
  db: Queryable,
  client: PayPalClient,
  input: { shopId: string; sessionId: string; payoutId: string; recordKey: RecordKey; cipher: ContactCipher; now: Date },
): Promise<{ id: string; status: PayoutStatus; paypalStatus: string | null }> {
  const invalid = () => new PayoutRefused("NOT_VALID", "This approval is missing, expired, or from another session. Review the payment again.");
  if (!UUID.test(input.payoutId)) throw invalid();
  const { rows } = await db.query<{ id: string; receiver_enc: string; amount_cents: number; currency: string; request_id: string }>(
    `update payouts set status = 'sending', updated_at = now()
     where id = $1 and shop_id = $2 and session_id = $3 and status = 'reviewed' and expires_at > $4::timestamptz
     returning id, receiver_enc, amount_cents, currency, request_id`,
    [input.payoutId, input.shopId, input.sessionId, input.now.toISOString()],
  );
  const row = rows[0];
  if (!row) {
    const { rows: found } = await db.query<{ status: string; session_id: string }>("select status, session_id from payouts where id = $1 and shop_id = $2", [input.payoutId, input.shopId]);
    if (found[0] && found[0].status !== "reviewed" && found[0].status !== "failed") throw new PayoutRefused("ALREADY_SENT", "This payment has already gone to PayPal. Check it against PayPal.");
    throw invalid();
  }
  const settle = async (status: PayoutStatus, paypalStatus: string | null) => {
    await db.query("update payouts set status = $2, paypal_status = $3, updated_at = now() where id = $1", [row.id, status, paypalStatus]);
    return { id: row.id, status, paypalStatus };
  };
  try {
    // request_id is new with each approval, so PayPal itself refuses a second batch for the same one.
    const { data } = await client.request<{ batch_header: { payout_batch_id: string; batch_status: string } }>("POST", "/v1/payments/payouts", {
      requestId: row.request_id,
      body: {
        sender_batch_header: { sender_batch_id: row.request_id, email_subject: "A payment about a recalled product" },
        items: [
          {
            recipient_type: "EMAIL",
            amount: { value: centsToValue(row.amount_cents), currency: row.currency },
            receiver: input.cipher.open(row.receiver_enc),
            note: `From the shop, about a product CPSC recalled: CPSC recall ${PAST_WINDOW_SAMPLE.recallNumber}. Follow the recall steps at cpsc.gov/Recalls. Sandbox test money.`,
            sender_item_id: row.id,
          },
        ],
      },
    });
    const batchId = data.batch_header.payout_batch_id;
    await db.query("update payouts set batch_ref_hmac = $2 where id = $1", [row.id, input.recordKey("paypal-resource", batchId)]);
    await db.query("insert into paypal_payout_refs (payout_row_id, batch_id) values ($1, $2) on conflict (payout_row_id) do update set batch_id = excluded.batch_id", [row.id, batchId]);
    return await settle("unconfirmed", data.batch_header.batch_status);
  } catch (err) {
    if (clearlyRefused(err)) return settle("failed", err.issue ?? `HTTP ${err.status}`);
    return settle("unconfirmed", null);
  }
}

/** What PayPal's item status means here. Anything it doesn't know stays unconfirmed, never paid. */
function fromItemStatus(status: string): Exclude<PayoutStatus, "reviewed"> {
  if (status === "SUCCESS") return "paid";
  if (status === "UNCLAIMED") return "unclaimed";
  if (status === "FAILED" || status === "RETURNED" || status === "BLOCKED" || status === "REFUNDED" || status === "REVERSED" || status === "DENIED") return "failed";
  return "unconfirmed";
}

export async function readPayoutFromPayPal(db: Queryable, client: PayPalClient, input: { shopId: string; payoutId: string; now: Date }): Promise<{ status: PayoutStatus; paypalStatus: string | null }> {
  if (!UUID.test(input.payoutId)) throw new PayoutRefused("NO_SUCH_PAYOUT", "No such payment for this shop. Go back to your queue.");
  const { rows } = await db.query<{ id: string; batch_id: string | null; batch_ref_hmac: string | null }>(
    "select p.id, r.batch_id, p.batch_ref_hmac from payouts p left join paypal_payout_refs r on r.payout_row_id = p.id where p.id = $1 and p.shop_id = $2",
    [input.payoutId, input.shopId],
  );
  if (!rows[0]) throw new PayoutRefused("NO_SUCH_PAYOUT", "No such payment for this shop. Go back to your queue.");
  if (!rows[0].batch_id && !rows[0].batch_ref_hmac) throw new PayoutRefused("NO_ANSWER", "PayPal gave no clear answer to this payment, and it wasn't sent again. Check the shop's PayPal activity.");
  if (!rows[0].batch_id) throw new PayoutRefused("AGED_OUT", "PayPal's record of this payment is no longer held here. Check PayPal directly.");
  const { data } = await client.request<{ items?: { transaction_status?: string }[] }>("GET", `/v1/payments/payouts/${encodeURIComponent(rows[0].batch_id)}`);
  const paypalStatus = data.items?.[0]?.transaction_status ?? null;
  const status = paypalStatus ? fromItemStatus(paypalStatus) : "unconfirmed";
  await db.query("update payouts set status = $2, paypal_status = $3, updated_at = now() where id = $1", [rows[0].id, status, paypalStatus]);
  return { status, paypalStatus };
}

/** PayPal's item webhook, once its signature is verified: the batch is found by its keyed hash. */
export async function recordPayoutItemEvent(db: Queryable, recordKey: RecordKey, resource: { payout_batch_id?: unknown; transaction_status?: unknown }): Promise<boolean> {
  if (typeof resource.payout_batch_id !== "string" || typeof resource.transaction_status !== "string") return false;
  // A late "still waiting" can't undo a final answer. Webhooks don't arrive in order.
  const { rows } = await db.query(
    `update payouts set status = $2, paypal_status = $3, updated_at = now()
     where batch_ref_hmac = $1 and ($2 <> 'unconfirmed' or status in ('sending', 'unconfirmed', 'unclaimed')) returning 1`,
    [recordKey("paypal-resource", resource.payout_batch_id), fromItemStatus(resource.transaction_status), resource.transaction_status],
  );
  return rows.length > 0;
}

export interface ShopPayout {
  id: string;
  status: PayoutStatus;
  paypalStatus: string | null;
  receiver: string;
  amountCents: number;
  currency: string;
}

export async function shopPayout(db: Queryable, shopId: string, cipher: ContactCipher): Promise<ShopPayout | null> {
  const { rows } = await db.query<{ id: string; status: string; paypal_status: string | null; receiver_enc: string; amount_cents: number; currency: string }>(
    "select id, status, paypal_status, receiver_enc, amount_cents, currency from payouts where shop_id = $1 and sample_key = $2",
    [shopId, PAST_WINDOW_SAMPLE.key],
  );
  const r = rows[0];
  if (!r) return null;
  return {
    id: r.id,
    // A send cut off partway has no clear answer either.
    status: r.status === "sending" ? "unconfirmed" : (r.status as PayoutStatus),
    paypalStatus: r.paypal_status,
    receiver: cipher.open(r.receiver_enc),
    amountCents: r.amount_cents,
    currency: r.currency,
  };
}

