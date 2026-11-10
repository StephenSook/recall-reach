// A separate sandbox payment for a sale past PayPal's 180-day refund window. A refund can't reach it, so an owner can choose to
// send one. Approved twice, for one exact amount, only to an email the owner typed, never PayPal's payer email. It never reads
// as paid until PayPal's item says so. Demo shops only: the sandbox app is shared, so no other shop may spend from it.
import type { Queryable } from "../db/types";
import type { ContactCipher } from "../privacy/contactCipher";
import type { RecordKey } from "../privacy/recordKey";
import { callsBelongTo } from "./callLog";
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
  // One statement. A new approval is a new payment, so what PayPal said about the old batch goes with it, and no send can fall between.
  const { rows } = await db.query<{ id: string }>(
    `with up as (
       insert into payouts (shop_id, session_id, sample_key, receiver_enc, amount_cents, currency, status, expires_at)
       values ($1, $2, $3, $4, $5, $6, 'reviewed', $7)
       on conflict (shop_id, sample_key) do update set session_id = excluded.session_id, receiver_enc = excluded.receiver_enc, amount_cents = excluded.amount_cents,
         status = 'reviewed', paypal_status = null, batch_ref_hmac = null, expires_at = excluded.expires_at, request_id = gen_random_uuid(), updated_at = now()
       where payouts.status in ('reviewed', 'failed')
       returning id
     ), gone as (delete from paypal_payout_refs where payout_row_id in (select id from up))
     select id from up`,
    [input.shopId, input.sessionId, PAST_WINDOW_SAMPLE.key, input.cipher.seal(email), cents, PAST_WINDOW_SAMPLE.currency, new Date(input.now.getTime() + REVIEW_LASTS_MS).toISOString()],
  );
  if (!rows[0]) throw new PayoutRefused("ALREADY_SENT", "This payment has already gone to PayPal. Check it against PayPal.");
  return { id: rows[0].id, amountCents: cents };
}

/** Answers only move forward, since PayPal's events don't arrive in order. "Still waiting" can't undo paid, and a stale paid can't undo a reversal. */
const STATUS_RANK = "case status when 'sending' then 0 when 'unconfirmed' then 1 when 'unclaimed' then 2 when 'paid' then 3 when 'failed' then 4 else 5 end";
const rankOf = (status: PayoutStatus) => (status === "unconfirmed" ? 1 : status === "unclaimed" ? 2 : status === "paid" ? 3 : status === "failed" ? 4 : 5);

async function moveStatus(db: Queryable, status: PayoutStatus, paypalStatus: string | null, where: string, args: unknown[]): Promise<void> {
  await db.query(`update payouts set status = $1, paypal_status = $2, updated_at = now() where ${where} and ${STATUS_RANK} <= $3`, [status, paypalStatus, rankOf(status), ...args]);
}

/** What's on the row now, whichever answer got there first. A send cut off partway has no clear answer either. */
async function currentStatus(db: Queryable, id: string): Promise<{ status: PayoutStatus; paypalStatus: string | null }> {
  const { rows } = await db.query<{ status: string; paypal_status: string | null }>("select status, paypal_status from payouts where id = $1", [id]);
  return { status: rows[0].status === "sending" ? "unconfirmed" : (rows[0].status as PayoutStatus), paypalStatus: rows[0].paypal_status };
}

const clearlyRefused = (err: unknown): err is PayPalApiError => err instanceof PayPalApiError && err.status >= 400 && err.status < 500 && !err.uncertain;

/** The second approval. One request ever goes: a lost answer stays unconfirmed for a person to check, and isn't sent again. */
export async function sendPayout(
  db: Queryable,
  client: PayPalClient,
  input: { shopId: string; sessionId: string; payoutId: string; approvalId: string; recordKey: RecordKey; cipher: ContactCipher; now: Date },
): Promise<{ id: string; status: PayoutStatus; paypalStatus: string | null }> {
  const invalid = () => new PayoutRefused("NOT_VALID", "This approval is missing, expired, or from another session. Review the payment again.");
  if (!UUID.test(input.payoutId) || !UUID.test(input.approvalId)) throw invalid();
  const { rows } = await db.query<{ id: string; receiver_enc: string; amount_cents: number; currency: string; request_id: string }>(
    `update payouts set status = 'sending', updated_at = now()
     where id = $1 and shop_id = $2 and session_id = $3 and request_id = $5::uuid and status = 'reviewed' and expires_at > $4::timestamptz
     returning id, receiver_enc, amount_cents, currency, request_id`,
    [input.payoutId, input.shopId, input.sessionId, input.now.toISOString(), input.approvalId],
  );
  const row = rows[0];
  if (!row) {
    const { rows: found } = await db.query<{ status: string; session_id: string }>("select status, session_id from payouts where id = $1 and shop_id = $2", [input.payoutId, input.shopId]);
    if (found[0] && found[0].status !== "reviewed" && found[0].status !== "failed") throw new PayoutRefused("ALREADY_SENT", "This payment has already gone to PayPal. Check it against PayPal.");
    throw invalid();
  }
  // Every write after the send is for this approval only. While PayPal answers, its failure webhook can free the row,
  // and the owner can review and send a new payment. This answer must not touch that one.
  const settle = async (status: PayoutStatus, paypalStatus: string | null) => {
    await moveStatus(db, status, paypalStatus, "id = $4 and request_id = $5::uuid", [row.id, row.request_id]);
    return { id: row.id, ...(await currentStatus(db, row.id)) };
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
            sender_item_id: row.request_id,
          },
        ],
      },
    });
    const batchId = data.batch_header.payout_batch_id;
    await recordBatch(db, { id: row.id, approval: row.request_id, batchId, batchHash: input.recordKey("paypal-resource", batchId), replace: true });
    return await settle("unconfirmed", data.batch_header.batch_status);
  } catch (err) {
    if (clearlyRefused(err)) return settle("failed", err.issue ?? `HTTP ${err.status}`);
    return settle("unconfirmed", null);
  }
}

/**
 * Keeps a batch's keyed hash and its PayPal id, in one statement, only while this approval is still the row's. A new review
 * deletes the refs and changes the approval, so either it comes first and nothing is written, or it comes after and clears this.
 * replace: the send's own answer overrides; an event fills in only a batch not yet known.
 */
async function recordBatch(db: Queryable, b: { id: string; approval: string; batchId: string; batchHash: string; replace: boolean }): Promise<void> {
  await db.query(
    `with ours as (
       update payouts set batch_ref_hmac = $2 where id = $1 and request_id = $3::uuid ${b.replace ? "" : "and batch_ref_hmac is null"} returning id
     )
     insert into paypal_payout_refs (payout_row_id, batch_id) select id, $4 from ours
     on conflict (payout_row_id) do ${b.replace ? "update set batch_id = excluded.batch_id" : "nothing"}`,
    [b.id, b.batchHash, b.approval, b.batchId],
  );
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
  const { rows } = await db.query<{ id: string; request_id: string; batch_id: string | null; batch_ref_hmac: string | null }>(
    "select p.id, p.request_id, r.batch_id, p.batch_ref_hmac from payouts p left join paypal_payout_refs r on r.payout_row_id = p.id where p.id = $1 and p.shop_id = $2",
    [input.payoutId, input.shopId],
  );
  if (!rows[0]) throw new PayoutRefused("NO_SUCH_PAYOUT", "No such payment for this shop. Go back to your queue.");
  if (!rows[0].batch_id && !rows[0].batch_ref_hmac) throw new PayoutRefused("NO_ANSWER", "PayPal gave no clear answer to this payment, and it wasn't sent again. Check the shop's PayPal activity.");
  if (!rows[0].batch_id) throw new PayoutRefused("AGED_OUT", "PayPal's record of this payment is no longer held here. Check PayPal directly.");
  const paypalStatus = (await readPayoutBatch(client)(rows[0].batch_id)).status;
  const status = paypalStatus ? fromItemStatus(paypalStatus) : "unconfirmed";
  // Only for the approval this read began with: the owner may have reviewed a new payment since.
  await moveStatus(db, status, paypalStatus, "id = $4 and request_id = $5::uuid", [rows[0].id, rows[0].request_id]);
  return currentStatus(db, rows[0].id);
}

/** PayPal's read of a batch: its one item's status, and who sent it. A send sets both sender ids to its approval's request id. */
export interface PayoutBatchRead {
  status: string | null;
  senderBatchId: string | null;
  senderItemId: string | null;
}

export function readPayoutBatch(client: PayPalClient): (batchId: string) => Promise<PayoutBatchRead> {
  return async (batchId) => {
    const { data } = await client.request<{
      batch_header?: { sender_batch_header?: { sender_batch_id?: string } };
      items?: { transaction_status?: string; payout_item?: { sender_item_id?: string } }[];
    }>("GET", `/v1/payments/payouts/${encodeURIComponent(batchId)}`);
    const item = data.items?.[0];
    return { status: item?.transaction_status ?? null, senderBatchId: data.batch_header?.sender_batch_header?.sender_batch_id ?? null, senderItemId: item?.payout_item?.sender_item_id ?? null };
  };
}

/**
 * PayPal's item webhook, once its signature is verified. Found by the batch's keyed hash, or by the approval the item carries
 * when the send's own answer was lost, in which case this is the first we hear of the batch. The event only says which batch to
 * read: nothing is recorded or moved until PayPal's own read shows this approval sent that batch, and its status comes from that
 * read. A read that fails, or names no status yet, throws, so the delivery fails and PayPal sends it again.
 */
export async function recordPayoutItemEvent(
  db: Queryable,
  recordKey: RecordKey,
  resource: { payout_batch_id?: unknown; transaction_status?: unknown; payout_item?: { sender_item_id?: unknown } },
  readBatch: (batchId: string) => Promise<PayoutBatchRead>,
): Promise<boolean> {
  if (typeof resource.payout_batch_id !== "string" || typeof resource.transaction_status !== "string") return false;
  const batchHash = recordKey("paypal-resource", resource.payout_batch_id);
  const carried = resource.payout_item?.sender_item_id;
  const approval = typeof carried === "string" && UUID.test(carried) ? carried : null;
  const { rows } = await db.query<{ id: string; request_id: string; shop_id: string; batch_ref_hmac: string | null }>(
    "select id, request_id, shop_id, batch_ref_hmac from payouts where batch_ref_hmac = $1 or request_id = $2::uuid",
    [batchHash, approval],
  );
  const row = rows[0];
  if (!row) return false;
  // An approval sends one batch. One it already has settles which, so another batch's event is not about it.
  if (row.batch_ref_hmac !== null && row.batch_ref_hmac !== batchHash) return false;
  // The webhook didn't know the shop; the read below is kept in this one's call log.
  callsBelongTo(row.shop_id);
  const read = await readBatch(resource.payout_batch_id);
  // PayPal must name this approval as the batch's sender, or the batch is someone else's, whatever the event paired it with.
  if (read.senderBatchId !== row.request_id || read.senderItemId !== row.request_id) return false;
  if (!read.status) throw new Error("PayPal's read of the payout batch named no status yet");
  // Each step is for the approval found above: the owner may review a new payment while this runs.
  await recordBatch(db, { id: row.id, approval: row.request_id, batchId: resource.payout_batch_id, batchHash, replace: false });
  await moveStatus(db, fromItemStatus(read.status), read.status, "id = $4 and request_id = $5::uuid", [row.id, row.request_id]);
  return true;
}

export interface ShopPayout {
  id: string;
  /** New with each review. The second approval carries it, so an old page can't send what a newer review set. */
  approvalId: string;
  status: PayoutStatus;
  paypalStatus: string | null;
  receiver: string;
  amountCents: number;
  currency: string;
}

export async function shopPayout(db: Queryable, shopId: string, cipher: ContactCipher): Promise<ShopPayout | null> {
  const { rows } = await db.query<{ id: string; request_id: string; status: string; paypal_status: string | null; receiver_enc: string; amount_cents: number; currency: string }>(
    "select id, request_id, status, paypal_status, receiver_enc, amount_cents, currency from payouts where shop_id = $1 and sample_key = $2",
    [shopId, PAST_WINDOW_SAMPLE.key],
  );
  const r = rows[0];
  if (!r) return null;
  return {
    id: r.id,
    approvalId: r.request_id,
    // A send cut off partway has no clear answer either.
    status: r.status === "sending" ? "unconfirmed" : (r.status as PayoutStatus),
    paypalStatus: r.paypal_status,
    receiver: cipher.open(r.receiver_enc),
    amountCents: r.amount_cents,
    currency: r.currency,
  };
}

