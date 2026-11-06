// A shop checks its own order file. Real recalls against real sales, with no PayPal account connected, so nothing
// here can refund. Its data is deleted when the shop asks, and after seven days regardless.
import type { Db, Queryable } from "../db/types";
import { runShopCheck } from "../match/run";
import { createContactCipher } from "../privacy/contactCipher";
import { PAYPAL_PURGE_CUTOFF_HOURS } from "../privacy/retention";
import { parseShopExport } from "./shopExport";
import { createShop, storeOrderLines } from "./store";

export const MAX_FILE_BYTES = 5_000_000;
/** Each line is compared with every recall, so this keeps one file from holding up the shared service. */
export const MAX_LINES = 1000;
export const OWN_FILE_DAYS = 7;
const MAX_NAME = 80;

export type OwnFileCode = "NO_NAME" | "NOT_READABLE" | "EMPTY" | "TOO_MANY";

export class OwnFileRefused extends Error {
  constructor(readonly code: OwnFileCode) {
    super(code);
    this.name = "OwnFileRefused";
  }
}

export async function importOwnFile(
  db: Db,
  input: { shopName: string; csv: string; secret: string; today: string },
): Promise<{ shopId: string; lines: number; rejected: number }> {
  const name = input.shopName.trim().slice(0, MAX_NAME);
  if (!name) throw new OwnFileRefused("NO_NAME");
  // A header with no rows is an empty file, and the parser can't tell its format with no row to read.
  if (input.csv.split(/\r?\n/).filter((l) => l.trim()).length === 1 && input.csv.includes(",")) throw new OwnFileRefused("EMPTY");
  let parsed;
  try {
    parsed = parseShopExport(input.csv);
  } catch {
    throw new OwnFileRefused("NOT_READABLE");
  }
  if (parsed.lines.length === 0) throw new OwnFileRefused("EMPTY");
  if (parsed.lines.length > MAX_LINES) throw new OwnFileRefused("TOO_MANY");

  const shopId = await createShop(db, { name, kind: "REAL" });
  try {
    await storeOrderLines(db, shopId, parsed.lines, createContactCipher(input.secret, shopId), "Your order file");
    await runShopCheck(db, shopId, { today: input.today });
  } catch (err) {
    await db.query("delete from shops where id = $1", [shopId]);
    throw err;
  }
  return { shopId, lines: parsed.lines.length, rejected: parsed.rejected.length };
}

/** Everything about the shop goes with it. A demo shop is not anyone's data, and this leaves it. */
export async function deleteOwnShop(db: Queryable, shopId: string): Promise<boolean> {
  const { rows } = await db.query("delete from shops where id = $1 and kind = 'REAL' returning id", [shopId]);
  return rows.length > 0;
}

/**
 * A demo shop is a visit: its session ends after a day and nobody can reach it after that. It goes at the same hour as
 * the PayPal purge, so nothing it was built from can outlast the 48-hour rule, whichever table that ended up in.
 */
export const DEMO_SHOP_HOURS = PAYPAL_PURGE_CUTOFF_HOURS;

export async function purgeOldDemoShops(db: Queryable, now: Date = new Date()): Promise<number> {
  const { rows } = await db.query("delete from shops where kind = 'DEMO' and created_at < $1::timestamptz - make_interval(hours => $2) returning 1", [now.toISOString(), DEMO_SHOP_HOURS]);
  return rows.length;
}

export async function purgeOldOwnShops(db: Queryable, now: Date = new Date()): Promise<number> {
  const { rows } = await db.query("delete from shops where kind = 'REAL' and created_at < $1::timestamptz - make_interval(days => $2) returning id", [now.toISOString(), OWN_FILE_DAYS]);
  return rows.length;
}
