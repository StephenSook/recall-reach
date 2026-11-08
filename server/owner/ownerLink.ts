// A shop owner's own PayPal login, linked to the shop from a session that is already signed in to it, so that login opens
// the shop again later. Only an HMAC of the PayPal account id is kept. One PayPal account opens one shop.
import type { Queryable } from "../db/types";
import type { RecordKey } from "../privacy/recordKey";

/** RACED: another login was linked to this shop in the same moment, and that one stands. */
export type LinkResult = "LINKED" | "ALREADY_LINKED" | "LINKED_ELSEWHERE" | "NOT_A_REAL_SHOP" | "RACED";

export interface OwnerLink {
  linkedAt: string;
  signedInAt: string | null;
  /** Whether this login is the PayPal account the shop's refunds go from, measured when it was linked. Null if none was connected. */
  isSeller: boolean | null;
}

const iso = (v: unknown) => (v === null || v === undefined ? null : new Date(v as string).toISOString());
// Null when the shop has no connected seller; otherwise whether the login is that seller.
const IS_SELLER = "(select c.merchant_id_hmac = $3 from shop_paypal_connections c where c.shop_id = $1 and c.merchant_id_hmac is not null)";

export async function linkOwner(db: Queryable, input: { shopId: string; payerId: string; recordKey: RecordKey; now: Date }): Promise<LinkResult> {
  const owner = input.recordKey("paypal-owner", input.payerId);
  const seller = input.recordKey("paypal-merchant", input.payerId);
  const { rows } = await db.query<{ kind: string; owner_payer_hmac: string | null }>("select kind, owner_payer_hmac from shops where id = $1", [input.shopId]);
  if (rows[0]?.kind !== "REAL") return "NOT_A_REAL_SHOP";
  if (rows[0].owner_payer_hmac === owner) {
    await db.query(`update shops set owner_is_seller = ${IS_SELLER} where id = $1 and owner_payer_hmac = $2`, [input.shopId, owner, seller]);
    return "ALREADY_LINKED";
  }
  const taken = await db.query("select 1 from shops where owner_payer_hmac = $1 and id <> $2", [owner, input.shopId]);
  if (taken.rows.length > 0) return "LINKED_ELSEWHERE";
  // Written only over the owner this call read, so two logins linking the same shop at once can't both win.
  let updated;
  try {
    updated = await db.query(
      `update shops set owner_payer_hmac = $2, owner_linked_at = $4, owner_signed_in_at = null, owner_is_seller = ${IS_SELLER}
       where id = $1 and owner_payer_hmac is not distinct from $5 returning id`,
      [input.shopId, owner, seller, input.now.toISOString(), rows[0].owner_payer_hmac],
    );
  } catch (err) {
    // Another shop took this login between the check and the write: the unique index settles it.
    if ((err as { code?: unknown }).code === "23505") return "LINKED_ELSEWHERE";
    throw err;
  }
  if (updated.rows.length > 0) return "LINKED";
  const now = await db.query<{ owner_payer_hmac: string | null }>("select owner_payer_hmac from shops where id = $1", [input.shopId]);
  return now.rows[0]?.owner_payer_hmac === owner ? "ALREADY_LINKED" : "RACED";
}

/** The real shop this PayPal login opens, if any. */
export async function shopForOwner(db: Queryable, input: { payerId: string; recordKey: RecordKey }): Promise<string | null> {
  const { rows } = await db.query<{ id: string }>("select id from shops where owner_payer_hmac = $1 and kind = 'REAL'", [input.recordKey("paypal-owner", input.payerId)]);
  return rows[0]?.id ?? null;
}

export async function readOwnerLink(db: Queryable, shopId: string): Promise<OwnerLink | null> {
  const { rows } = await db.query<Record<string, unknown>>("select owner_linked_at, owner_signed_in_at, owner_is_seller from shops where id = $1 and owner_payer_hmac is not null", [shopId]);
  const r = rows[0];
  if (!r) return null;
  return { linkedAt: iso(r.owner_linked_at) as string, signedInAt: iso(r.owner_signed_in_at), isSeller: (r.owner_is_seller as boolean | null) ?? null };
}

export async function markOwnerSignedIn(db: Queryable, shopId: string, now: Date): Promise<void> {
  await db.query("update shops set owner_signed_in_at = $2 where id = $1 and owner_payer_hmac is not null", [shopId, now.toISOString()]);
}

export async function unlinkOwner(db: Queryable, shopId: string): Promise<void> {
  await db.query("update shops set owner_payer_hmac = null, owner_linked_at = null, owner_signed_in_at = null, owner_is_seller = null where id = $1", [shopId]);
}
