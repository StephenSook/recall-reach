// A shop's connection to its own PayPal account: started by a Partner Referral, connected only when PayPal's status says
// so. The seller's merchant id is sealed with the shop's key and never leaves the server.
import type { Queryable } from "../db/types";
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

export async function startConnection(db: Queryable, input: { shopId: string; trackingId: string; now: Date }): Promise<void> {
  await db.query(
    `insert into shop_paypal_connections (shop_id, tracking_id, started_at) values ($1, $2, $3)
     on conflict (shop_id) do update set started_at = excluded.started_at, refusal = null`,
    [input.shopId, input.trackingId, input.now.toISOString()],
  );
}

export async function saveSellerStatus(db: Queryable, input: { shopId: string; status: SellerStatus; secret: string; recordKey: RecordKey; now: Date }): Promise<void> {
  const sealed = createContactCipher(input.secret, input.shopId).seal(input.status.merchantId);
  await db.query(
    `update shop_paypal_connections set merchant_id_sealed = $2, merchant_id_hmac = $3, payments_receivable = $4, primary_email_confirmed = $5,
       scopes = $6, status_read_at = $7, refusal = null
     where shop_id = $1`,
    [input.shopId, sealed, input.recordKey("paypal-merchant", input.status.merchantId), input.status.paymentsReceivable, input.status.primaryEmailConfirmed, input.status.scopes, input.now.toISOString()],
  );
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

export async function disconnectShop(db: Queryable, shopId: string): Promise<void> {
  await db.query("delete from shop_paypal_connections where shop_id = $1", [shopId]);
}

/** PayPal said the seller took its consent back. */
export async function forgetMerchant(db: Queryable, merchantIdHmac: string): Promise<void> {
  await db.query("delete from shop_paypal_connections where merchant_id_hmac = $1", [merchantIdHmac]);
}
