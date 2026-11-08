import { createHash, randomBytes } from "node:crypto";
import { z } from "zod";
import type { Db, Queryable } from "../db/types";
import { runShopCheck } from "../match/run";
import { createContactCipher } from "../privacy/contactCipher";
import { DEMO_SHOP_HOURS, OWN_FILE_DAYS } from "../import/ownFile";
import { businessDay } from "../time/businessDay";
import { receiptKeyFromToken, receiptTokenFor } from "./token";

export const FAMILY_ASKED = "A family asked to hear about this";
const hash = (token: string) => createHash("sha256").update(token).digest("hex");
const field = (max: number) => z.string().trim().max(max).refine((v) => !/[\u0000-\u001f\u007f]/.test(v));
const receiptInput = z.object({
  item: field(240).refine((v) => v.length > 0),
  brand: field(120).optional().default(""),
  model: field(120).optional().default(""),
  email: z.email().max(254).refine((v) => !/[\r\n]/.test(v)),
  consent: z.literal(true),
  website: z.literal("").optional().default(""),
});

export class ReceiptRefused extends Error {
  constructor(readonly code: "CONSENT" | "INVALID" | "NO_SHOP") { super(code); }
}

export async function shopReceiptLink(db: Queryable, shopId: string, secret: string): Promise<string | null> {
  const { rows } = await db.query<{ safety_receipt_key: string }>("select safety_receipt_key from shops where id = $1", [shopId]);
  return rows[0] ? receiptTokenFor(secret, rows[0].safety_receipt_key) : null;
}

/**
 * When the purge takes a shop's data, and its receipts with it: a real shop 7 days after it joined, a demo shop at
 * DEMO_SHOP_HOURS. The same windows as purgeOldOwnShops and purgeOldDemoShops, so every screen shows the date they act on.
 */
export function shopDataDeletedAfter(kind: string, createdAt: Date): Date {
  return new Date(createdAt.getTime() + (kind === "DEMO" ? DEMO_SHOP_HOURS * 3_600_000 : OWN_FILE_DAYS * 86_400_000));
}

export async function shopDeletesAfter(db: Queryable, shopId: string): Promise<Date | null> {
  const { rows } = await db.query<{ kind: string; created_at: Date }>("select kind, created_at from shops where id = $1", [shopId]);
  return rows[0] ? shopDataDeletedAfter(rows[0].kind, new Date(rows[0].created_at)) : null;
}

export async function receiptShop(db: Queryable, token: string, secret: string): Promise<{ id: string; name: string; kind: string; deletesAfter: Date } | null> {
  const key = receiptKeyFromToken(secret, token);
  if (!key) return null;
  const { rows } = await db.query<{ id: string; name: string; kind: string; created_at: Date }>("select id, name, kind, created_at from shops where safety_receipt_key = $1", [key]);
  const shop = rows[0];
  return shop ? { id: shop.id, name: shop.name, kind: shop.kind, deletesAfter: shopDataDeletedAfter(shop.kind, new Date(shop.created_at)) } : null;
}

/** Family input stays local, including its item words. No external clients are called here. */
export async function createReceipt(db: Db, shopId: string, raw: unknown, secret: string, now = new Date()): Promise<{ id: string; deleteToken: string }> {
  if (!raw || typeof raw !== "object" || !("consent" in raw) || raw.consent !== true) throw new ReceiptRefused("CONSENT");
  const parsed = receiptInput.safeParse(raw);
  if (!parsed.success) throw new ReceiptRefused("INVALID");
  const input = parsed.data;
  const deleteToken = randomBytes(32).toString("base64url");
  const encrypted = createContactCipher(secret, shopId).seal(input.email);
  return db.transaction(async (tx) => {
    const { rows } = await tx.query<{ id: string }>(
      `insert into safety_receipts (shop_id, item, brand, model, email_enc, delete_token_hash, created_at)
       select id, $2, $3, $4, $5, $6, $7 from shops where id = $1 returning id`,
      [shopId, input.item, input.brand || null, input.model || null, encrypted, hash(deleteToken), now.toISOString()],
    );
    if (!rows[0]) throw new ReceiptRefused("NO_SHOP");
    // The existing matcher commits through this transaction too: either the receipt and its check both save,
    // or neither does. No orphaned receipt whose deletion link the family never received.
    await runShopCheck({ ...tx, transaction: (fn) => fn(tx) }, shopId, { today: businessDay(now), onlyRecordId: rows[0].id });
    return { id: rows[0].id, deleteToken };
  });
}

export async function deleteReceipt(db: Queryable, token: string): Promise<boolean> {
  if (!/^[\w-]{43}$/.test(token)) return false;
  const { rows } = await db.query("delete from safety_receipts where delete_token_hash = $1 returning 1", [hash(token)]);
  return rows.length > 0;
}

export async function deleteShopReceipt(db: Queryable, shopId: string, id: string): Promise<boolean> {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) return false;
  const { rows } = await db.query("delete from safety_receipts where shop_id = $1 and id = $2 returning 1", [shopId, id]);
  return rows.length > 0;
}

/** A ceiling only: today a receipt goes with its shop's data long before this, on the date its page shows. */
export async function purgeReceipts(db: Queryable, now = new Date()): Promise<number> {
  const { rows } = await db.query("delete from safety_receipts where created_at + interval '3 years' <= $1::timestamptz + interval '1 hour' returning 1", [now.toISOString()]);
  return rows.length;
}
