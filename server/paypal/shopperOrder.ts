// The shopping agent's offer, turned into a sandbox order a person approves on PayPal's page. The model has no part in this: the
// price is read again here, from the listing, and the slip it matches can be used once, for a few minutes.
import { createHash } from "node:crypto";
import type { Queryable } from "../db/types";
import { readListingCheck, type TextCheckAnswer } from "../match/textCheck";
import type { RecordKey } from "../privacy/recordKey";
import type { BuyableListing, ListingSource } from "../sweep/channel3";
import type { PayPalClient } from "./client";
import { captureOrder, createPayPalOrder, getOrder } from "./orders";

export const SLIP_LASTS_MS = 10 * 60_000;
const KEEP_SLIPS_HOURS = 48;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PAYPAL_ID = /^[A-Za-z0-9-]+$/;
const BRAND_NAME = "RECALL REACH SANDBOX TEST";

export type SlipRefusal = "NO_SLIP" | "EXPIRED" | "CHANGED" | "GONE" | "NOW_FLAGGED" | "NOT_PAID" | "HELD";

export class SlipRefused extends Error {
  constructor(
    readonly code: SlipRefusal,
    message: string,
  ) {
    super(message);
    this.name = "SlipRefused";
  }
}

/** Each part carries its length, so two different carts can't hash alike. */
export function cartHash(listing: Pick<BuyableListing, "id" | "title" | "priceCents" | "currency">): string {
  const hash = createHash("sha256");
  for (const part of [listing.id, listing.title, String(listing.priceCents), listing.currency]) hash.update(`${Buffer.byteLength(part)}:${part}`);
  return hash.digest("hex");
}

export async function createSlip(db: Queryable, listing: BuyableListing, now: Date): Promise<{ id: string; expiresAt: string }> {
  await db.query("delete from shopping_slips where created_at < $1::timestamptz - make_interval(hours => $2)", [now.toISOString(), KEEP_SLIPS_HOURS]);
  const expiresAt = new Date(now.getTime() + SLIP_LASTS_MS).toISOString();
  const { rows } = await db.query<{ id: string }>(
    "insert into shopping_slips (listing_id, title, brand, price_cents, currency, cart_hash, expires_at, created_at) values ($1, $2, $3, $4, $5, $6, $7, $8) returning id",
    [listing.id, listing.title, listing.brand, listing.priceCents, listing.currency, cartHash(listing), expiresAt, now.toISOString()],
  );
  return { id: rows[0].id, expiresAt };
}

const orderNumberOf = (slipId: string) => `SHOP-${slipId.replace(/-/g, "")}`;

/**
 * Uses the slip, reads the listing again, and checks it again, so a price that moved or a recall published since stops it.
 * A slip is spent even when that stops it. Only PayPal failing to make the order gives it back, since nothing happened.
 */
export async function startShopperOrder(
  db: Queryable,
  client: PayPalClient,
  input: { slipId: string; siteUrl: string; recordKey: RecordKey; now: Date },
  deps: { read: ListingSource["read"]; check: (listing: BuyableListing) => Promise<TextCheckAnswer> },
): Promise<{ approveUrl: string }> {
  const noSlip = () => new SlipRefused("NO_SLIP", "That offer isn't here any more. Search again.");
  if (!UUID.test(input.slipId)) throw noSlip();
  const { rows } = await db.query<{ id: string; listing_id: string; cart_hash: string }>(
    "update shopping_slips set used_at = $2 where id = $1 and used_at is null and expires_at > $2::timestamptz returning id, listing_id, cart_hash",
    [input.slipId, input.now.toISOString()],
  );
  const slip = rows[0];
  if (!slip) {
    const { rows: found } = await db.query("select 1 from shopping_slips where id = $1", [input.slipId]);
    throw found[0] ? new SlipRefused("EXPIRED", "That offer has run out or was already used. Search again.") : noSlip();
  }
  const live = await deps.read(slip.listing_id).catch(() => null);
  if (!live) throw new SlipRefused("GONE", "That listing couldn't be read again, so nothing was started. Search again.");
  if (cartHash(live) !== slip.cart_hash) throw new SlipRefused("CHANGED", "That listing's price or title changed, so nothing was started. Search again.");
  if (readListingCheck(await deps.check(live), live) !== "NO_MATCH_FOUND") {
    throw new SlipRefused("NOW_FLAGGED", "That listing no longer comes back with no recall match, so nothing was started.");
  }
  try {
    // The slip's own id: a retry after a lost answer gets PayPal's first order, not a second one.
    const { orderId, approveUrl } = await createPayPalOrder(client, {
      orderNumber: orderNumberOf(slip.id),
      currency: live.currency,
      discountCents: 0,
      lines: [{ title: live.title, sku: null, quantity: 1, unitPriceCents: live.priceCents }],
      requestId: slip.id,
      returnUrl: `${input.siteUrl}/api/shopper/return?slip=${slip.id}`,
      cancelUrl: `${input.siteUrl}/shopper?cancelled=1`,
      brandName: BRAND_NAME,
    });
    await db.query("update shopping_slips set order_ref_hmac = $2 where id = $1", [slip.id, input.recordKey("paypal-resource", orderId)]);
    return { approveUrl };
  } catch (err) {
    await db.query("update shopping_slips set used_at = null where id = $1 and finished_at is null", [slip.id]);
    throw err;
  }
}

/** The buyer is back from PayPal. The address proves nothing: the order is read from PayPal, and only COMPLETED reads as done. */
export async function finishShopperOrder(db: Queryable, client: PayPalClient, input: { slipId: string; orderId: string; recordKey: RecordKey; now: Date }): Promise<void> {
  const notPaid = () => new SlipRefused("NOT_PAID", "PayPal doesn't show this order as complete.");
  if (!UUID.test(input.slipId) || !PAYPAL_ID.test(input.orderId)) throw notPaid();
  const { rows } = await db.query<{ id: string; price_cents: number; currency: string; order_ref_hmac: string | null }>("select id, price_cents, currency, order_ref_hmac from shopping_slips where id = $1", [input.slipId]);
  const slip = rows[0];
  // Only the order this slip started is read from PayPal.
  if (!slip?.order_ref_hmac || slip.order_ref_hmac !== input.recordKey("paypal-resource", input.orderId)) throw notPaid();
  const matches = (o: Awaited<ReturnType<typeof getOrder>>) => o.invoiceId === orderNumberOf(slip.id) && o.amountCents === slip.price_cents && o.currency === slip.currency;
  const before = await getOrder(client, input.orderId);
  if (!matches(before)) throw notPaid();
  if (before.status === "APPROVED") await captureOrder(client, input.orderId, `capture-${input.orderId}`);
  else if (before.status !== "COMPLETED") throw notPaid();
  const after = await getOrder(client, input.orderId);
  if (!matches(after) || after.status !== "COMPLETED") throw notPaid();
  if (after.capture?.status === "PENDING") throw new SlipRefused("HELD", "PayPal is still holding this order.");
  if (after.capture?.status !== "COMPLETED") throw notPaid();
  await db.query("update shopping_slips set finished_at = coalesce(finished_at, $2) where id = $1", [slip.id, input.now.toISOString()]);
}

export async function readFinishedSlip(db: Queryable, slipId: string): Promise<{ title: string; priceCents: number; currency: string } | null> {
  if (!UUID.test(slipId)) return null;
  const { rows } = await db.query<{ title: string; price_cents: number; currency: string }>("select title, price_cents, currency from shopping_slips where id = $1 and finished_at is not null", [slipId]);
  return rows[0] ? { title: rows[0].title, priceCents: rows[0].price_cents, currency: rows[0].currency } : null;
}
