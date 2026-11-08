// A shop's connection to its own PayPal account: started by a Partner Referral, connected only when PayPal's status says
// so. The seller's merchant id is sealed with the shop's key and never leaves the server.
//
// Everything that changes a shop's link (connecting, a check with PayPal, the shop's sales read, a revoke, a disconnect)
// runs alone for that shop, inside withConnectionLock, so no two can interleave. Underneath that, each connection attempt
// has its own random id and each read of PayPal's status reserves a number from a database sequence just before it asks,
// and a write applies only to its own attempt and only if no later-reserved read has landed: a second fence, for any
// caller that forgets the first.
import type { Db, Queryable } from "../db/types";
import { isConnected, type SellerStatus } from "../paypal/platform";
import { createContactCipher } from "../privacy/contactCipher";
import type { RecordKey } from "../privacy/recordKey";

/** What PayPal is told about the shop: an HMAC of its id. */
export const trackingIdFor = (recordKey: RecordKey, shopId: string) => recordKey("paypal-tracking", shopId);

export interface Connection {
  trackingId: string;
  startedAt: string;
  status: SellerStatus | null;
  readAt: string | null;
  refusal: string | null;
  connected: boolean;
}

/** One read of PayPal's status, reserved just before asking: the attempt it belongs to and its place in line. */
export interface StatusRead {
  attempt: string;
  seq: string;
}

/** Another change to this shop's link is running, or this server already has its share of them running. Try again soon. */
export class ConnectionBusy extends Error {
  constructor() {
    super("A check of this shop's PayPal account is already running.");
    this.name = "ConnectionBusy";
  }
}

// A link change holds a database connection while it waits on PayPal, and the pool has five. Shops' own changes get at
// most MAX_LINK_CHANGES at once in this process, and PayPal's revokes a lane of their own that those can't fill, so the
// rest of the site always keeps two connections and a revoke never queues behind a busy shop.
export const MAX_LINK_CHANGES = 2;
export const REVOKE_LANES = 1;
const running = { shop: 0, revoke: 0 };

/**
 * Runs fn alone for this shop's PayPal link, in one transaction holding a per-shop advisory lock, and gives it that
 * transaction to work in. The lock lasts until the transaction ends, so a check that waits on PayPal holds it throughout.
 * Nothing waits for it: if the shop's lock is taken, or MAX_LINK_CHANGES are already running, this throws ConnectionBusy
 * straight away, without keeping a connection.
 */
export async function withConnectionLock<T>(db: Db, shopId: string, fn: (tx: Db) => Promise<T>, opts: { lane?: "shop" | "revoke" } = {}): Promise<T> {
  const lane = opts.lane ?? "shop";
  if (running[lane] >= (lane === "revoke" ? REVOKE_LANES : MAX_LINK_CHANGES)) throw new ConnectionBusy();
  running[lane] += 1;
  try {
    return await db.transaction(async (tx) => {
      const { rows } = await tx.query<{ locked: boolean }>("select pg_try_advisory_xact_lock(hashtext('shop-paypal-connection'), hashtext($1)) as locked", [shopId]);
      if (rows[0]?.locked !== true) throw new ConnectionBusy();
      return fn({ ...tx, transaction: (inner) => inner(tx) });
    });
  } finally {
    running[lane] -= 1;
  }
}

/** The shop's PayPal payments came from the seller it was linked to. When that seller goes or changes, they go too. */
async function dropSellersPayments(db: Queryable, shopId: string): Promise<void> {
  await db.query("delete from paypal_payments where shop_id = $1", [shopId]);
}

const savedSeller = async (db: Queryable, shopId: string): Promise<string | null> =>
  (await db.query<{ h: string | null }>("select merchant_id_hmac as h from shop_paypal_connections where shop_id = $1", [shopId])).rows[0]?.h ?? null;

/** Starts, or starts again, a connection attempt. A new attempt fences off every read still out for an older one. */
export async function startConnection(db: Queryable, input: { shopId: string; trackingId: string; now: Date }): Promise<void> {
  await db.query(
    `insert into shop_paypal_connections (shop_id, tracking_id, started_at) values ($1, $2, $3)
     on conflict (shop_id) do update set started_at = excluded.started_at, refusal = null, attempt = gen_random_uuid()`,
    [input.shopId, input.trackingId, input.now.toISOString()],
  );
}

/** Reserves a read for the shop's current attempt. Call it immediately before asking PayPal. Null if nothing was started. */
export async function reserveStatusRead(db: Queryable, shopId: string): Promise<StatusRead | null> {
  const { rows } = await db.query<{ attempt: string; seq: string }>(
    "select attempt::text as attempt, nextval('shop_paypal_status_reads')::text as seq from shop_paypal_connections where shop_id = $1",
    [shopId],
  );
  return rows[0] ? { attempt: rows[0].attempt, seq: rows[0].seq } : null;
}

// The fence every write and delete after a read carries: $2 is the attempt, $3 the read's place in line.
const FENCED = "attempt = $2::uuid and read_seq < $3::bigint";

/**
 * Saves PayPal's answer. False when the attempt changed or a later read already landed: then this answer is out of date.
 * A different seller from the one saved takes the old seller's payments with it. Call inside withConnectionLock.
 */
export async function saveSellerStatus(db: Queryable, input: { shopId: string; read: StatusRead; status: SellerStatus; secret: string; recordKey: RecordKey; now: Date }): Promise<boolean> {
  const sealed = createContactCipher(input.secret, input.shopId).seal(input.status.merchantId);
  const seller = input.recordKey("paypal-merchant", input.status.merchantId);
  const before = await savedSeller(db, input.shopId);
  const { rows } = await db.query(
    `update shop_paypal_connections set merchant_id_sealed = $4, merchant_id_hmac = $5, payments_receivable = $6, primary_email_confirmed = $7,
       scopes = $8, status_read_at = $9, read_seq = $3::bigint, refusal = null
     where shop_id = $1 and ${FENCED} returning 1`,
    [input.shopId, input.read.attempt, input.read.seq, sealed, seller, input.status.paymentsReceivable, input.status.primaryEmailConfirmed, input.status.scopes, input.now.toISOString()],
  );
  if (rows.length > 0 && before !== null && before !== seller) await dropSellersPayments(db, input.shopId);
  return rows.length > 0;
}

/**
 * PayPal no longer shows the saved seller: what was saved stops counting, so nothing reads as connected or refunds from it,
 * and the seller's payments go. The row stays, holding its attempt and read number, so a later check can still land.
 * Call inside withConnectionLock.
 */
export async function clearSellerStatus(db: Queryable, input: { shopId: string; read: StatusRead; now: Date }): Promise<boolean> {
  const before = await savedSeller(db, input.shopId);
  const { rows } = await db.query(
    `update shop_paypal_connections set merchant_id_sealed = null, merchant_id_hmac = null, payments_receivable = null, primary_email_confirmed = null,
       scopes = '{}', status_read_at = $4, read_seq = $3::bigint
     where shop_id = $1 and ${FENCED} returning 1`,
    [input.shopId, input.read.attempt, input.read.seq, input.now.toISOString()],
  );
  if (rows.length > 0 && before !== null) await dropSellersPayments(db, input.shopId);
  return rows.length > 0;
}

export async function recordConnectRefusal(db: Queryable, input: { shopId: string; refusal: string }): Promise<void> {
  await db.query("update shop_paypal_connections set refusal = $2 where shop_id = $1", [input.shopId, input.refusal.slice(0, 500)]);
}

const iso = (v: unknown) => (v === null || v === undefined ? null : new Date(v as string).toISOString());

export async function readConnection(db: Queryable, input: { shopId: string; secret: string }): Promise<Connection | null> {
  const { rows } = await db.query<Record<string, unknown>>("select * from shop_paypal_connections where shop_id = $1", [input.shopId]);
  const r = rows[0];
  if (!r) return null;
  const status: SellerStatus | null = r.merchant_id_sealed
    ? {
        merchantId: createContactCipher(input.secret, input.shopId).open(String(r.merchant_id_sealed)),
        paymentsReceivable: r.payments_receivable === true,
        primaryEmailConfirmed: r.primary_email_confirmed === true,
        scopes: (r.scopes as string[]) ?? [],
      }
    : null;
  return { trackingId: String(r.tracking_id), startedAt: iso(r.started_at) as string, status, readAt: iso(r.status_read_at), refusal: (r.refusal as string | null) ?? null, connected: isConnected(status) };
}

/** The seller's merchant id, only while PayPal's last answer said the shop is connected. */
export async function connectedMerchant(db: Queryable, input: { shopId: string; secret: string }): Promise<string | null> {
  const c = await readConnection(db, input);
  return c?.connected && c.status ? c.status.merchantId : null;
}

/** The shop asked to disconnect: the link goes, and the payments read through it. Call inside withConnectionLock. */
export async function disconnectShop(db: Queryable, shopId: string): Promise<void> {
  await db.query("delete from shop_paypal_connections where shop_id = $1", [shopId]);
  await dropSellersPayments(db, shopId);
}

/** The shops linked to one PayPal seller, found by the HMAC of its merchant id. */
export async function shopsLinkedTo(db: Queryable, merchantIdHmac: string): Promise<{ shopId: string; trackingId: string }[]> {
  const { rows } = await db.query<{ shop_id: string; tracking_id: string }>("select shop_id, tracking_id from shop_paypal_connections where merchant_id_hmac = $1", [merchantIdHmac]);
  return rows.map((r) => ({ shopId: r.shop_id, trackingId: r.tracking_id }));
}
