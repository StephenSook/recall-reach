// CPSC's product safety warnings. When a company can't be found or won't cooperate, CPSC warns instead of recalling: no recall
// and no remedy. Kept apart from recalls, so they reach no recall count, no Replay and no refund. A warning is notice only.
import { createHash } from "node:crypto";
import { parse } from "csv-parse/sync";
import type { Queryable } from "../db/types";
import { verdictFor } from "../match/verdict";

export const WARNINGS_URL = "https://www.cpsc.gov/s3fs-public/recall-data/product_safety_warning_listing.csv";
/** The file has no page per warning, so a card links to CPSC's list and names the warning's number. */
export const WARNINGS_PAGE = "https://www.cpsc.gov/Warnings";

/** 382 rows when first measured, 2026-11-06. A file much shorter than that isn't the list. */
const MIN_ROWS = 100;
const READ_EVERY_MS = 20 * 3_600_000;
const TIMEOUT_MS = 60_000;

export class WarningsUnreadable extends Error {}

export interface Warning {
  number: string;
  /** YYYY-MM-DD */
  warnedOn: string;
  title: string;
  product: string;
  description: string;
  hazard: string;
  consumerAction: string;
  soldAt: string;
}

const dayOf = (text: string): string | null => {
  const at = Date.parse(`${text.trim()} UTC`);
  return Number.isNaN(at) ? null : new Date(at).toISOString().slice(0, 10);
};

/** Verifies the content, never the status: an error page can come with a 200. */
export function parseWarningsCsv(text: string): Warning[] {
  if (!text.replace(/^﻿/, "").startsWith('"Product Safety Warning Number"')) throw new WarningsUnreadable("that isn't CPSC's warnings file");
  let records: Record<string, string>[];
  try {
    records = parse(text, { bom: true, columns: true, skip_empty_lines: true, relax_column_count: true });
  } catch {
    throw new WarningsUnreadable("CPSC's warnings file could not be parsed");
  }
  const rows: Warning[] = [];
  for (const r of records) {
    const number = r["Product Safety Warning Number"]?.trim();
    const warnedOn = dayOf(r["Product Safety Warning Date"] ?? "");
    if (!number || !warnedOn) continue;
    rows.push({
      number,
      warnedOn,
      title: r["Product Safety Warning Title"] ?? "",
      product: r["Name of product"] ?? "",
      description: r["Description"] ?? "",
      hazard: r["Hazard Description"] ?? "",
      consumerAction: r["Consumer Action"] ?? "",
      soldAt: r["Sold At"] ?? "",
    });
  }
  if (rows.length < MIN_ROWS) throw new WarningsUnreadable(`CPSC's warnings file had only ${rows.length} rows`);
  return rows;
}

export async function storeWarnings(db: Queryable, warnings: Warning[]): Promise<void> {
  for (const w of warnings) {
    const sha = createHash("sha256").update(JSON.stringify(w)).digest("hex");
    await db.query(
      `insert into safety_warnings (warning_number, warned_on, title, product, description, hazard, consumer_action, sold_at, raw_sha256)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       on conflict (warning_number) do update set warned_on = excluded.warned_on, title = excluded.title, product = excluded.product,
         description = excluded.description, hazard = excluded.hazard, consumer_action = excluded.consumer_action, sold_at = excluded.sold_at, raw_sha256 = excluded.raw_sha256
       where safety_warnings.raw_sha256 is distinct from excluded.raw_sha256`,
      [w.number, w.warnedOn, w.title, w.product, w.description, w.hazard, w.consumerAction, w.soldAt, sha],
    );
  }
}

/** CPSC says the list updates weekly. Read daily, so a new warning waits a day at most. A failure holds on to what's here. */
export async function refreshWarnings(db: Queryable, opts: { now: Date; fetchImpl?: typeof fetch }): Promise<"READ" | "FRESH"> {
  const { rows } = await db.query<{ ok_at: unknown }>("select ok_at from safety_warning_reads");
  if (rows[0] && opts.now.getTime() - new Date(rows[0].ok_at as string).getTime() < READ_EVERY_MS) return "FRESH";
  let res: Response;
  try {
    res = await (opts.fetchImpl ?? fetch)(WARNINGS_URL, { signal: AbortSignal.timeout(TIMEOUT_MS), headers: { "user-agent": "RecallReachBot" } });
  } catch (err) {
    throw new WarningsUnreadable(`no answer: ${err instanceof Error ? err.name : "unknown error"}`);
  }
  if (!res.ok) throw new WarningsUnreadable(`CPSC answered ${res.status}`);
  await storeWarnings(db, parseWarningsCsv(await res.text()));
  await db.query(
    "insert into safety_warning_reads (only_row, ok_at) values (true, $1) on conflict (only_row) do update set ok_at = excluded.ok_at",
    [opts.now.toISOString()],
  );
  return "READ";
}

export async function warningCount(db: Queryable): Promise<number> {
  const { rows } = await db.query<{ n: string }>("select count(*)::text as n from safety_warnings");
  return Number(rows[0].n);
}

export async function lastWarningRead(db: Queryable): Promise<string | null> {
  const { rows } = await db.query<{ ok_at: unknown }>("select ok_at from safety_warning_reads");
  return rows[0] ? new Date(rows[0].ok_at as string).toISOString() : null;
}

/** First words of CPSC's product names that describe a product rather than name a maker. Measured on 19,271 real listing titles. */
const NOT_A_MAKER = new Set(["kids", "kid", "magic", "hair", "top", "style", "squishy", "glow", "bright", "bubble", "sunny", "life", "certain", "summer", "baby", "infant", "toddler", "children", "childrens", "light", "lights", "led", "mini", "portable", "electric", "battery", "rechargeable", "wooden", "plastic", "soft", "the"]);

const wordsOf = (text: string) => text.toLowerCase().split(/[^a-z0-9+]+/).filter(Boolean);

/** A name only: letters, not a word CPSC's other warnings use to describe a product, and not on the list above. */
export function makerOf(product: string, usedToDescribe: ReadonlySet<string>): string | null {
  const first = wordsOf(product)[0];
  if (!first || !/^[a-z+]+$/.test(first) || NOT_A_MAKER.has(first) || usedToDescribe.has(first)) return null;
  // A short name only counts in capitals, like XZV. Anything else that short is a word.
  if (first.length < 4 && !/^[A-Z]{3}\b/.test(product.trim())) return null;
  return first;
}

/** Words that appear after the first in any warning's product name. A maker's name comes first. */
export function descriptiveWords(products: string[]): Set<string> {
  const found = new Set<string>();
  for (const product of products) for (const word of wordsOf(product).slice(1)) found.add(word);
  return found;
}

/**
 * The matcher reads a brand from a recall's title, and a warning's title is worded differently, so this says it the matcher's
 * way: the product name's first word as the maker. A warning needs the maker and the product both, because with no recall and
 * no remedy, a loose match would only frighten a family.
 */
export function nearWarning(w: Pick<Warning, "product" | "description">, title: string, maker: string): boolean {
  if (!wordsOf(title).includes(maker)) return false;
  const { verdict, strength } = verdictFor({ title: `${maker} Recalls ${w.product}`, description: w.description, products: [{ name: w.product, model: "", type: null, units: null }], retailers: [] }, { title });
  return verdict !== "CLEARED" && (strength === "BRAND" || strength === "CONFIRMED");
}

/** Adds what these titles came near, and says how many it added. Only ever adds, and touches no recall row. */
export async function checkTitlesAgainstWarnings(db: Queryable, shopId: string, titles: string[]): Promise<number> {
  if (titles.length === 0) return 0;
  const { rows } = await db.query<{ warning_number: string; product: string; description: string }>("select warning_number, product, description from safety_warnings");
  const describing = descriptiveWords(rows.map((r) => r.product));
  const named = rows.flatMap((w) => {
    const maker = makerOf(w.product, describing);
    return maker ? [{ ...w, maker }] : [];
  });
  let added = 0;
  for (const title of new Set(titles)) {
    for (const w of named) {
      if (!nearWarning(w, title, w.maker)) continue;
      const saved = await db.query(
        "insert into safety_warning_matches (shop_id, warning_number, item_title) values ($1, $2, $3) on conflict do nothing returning 1",
        [shopId, w.warning_number, title],
      );
      added += saved.rows.length;
    }
  }
  return added;
}

/** Everything this shop has called an item, against what's held. A failure here is never the shop's check failing. */
export async function checkShopAgainstWarnings(db: Queryable, shopId: string): Promise<void> {
  try {
    const { rows } = await db.query<{ title: string }>(
      "select title from order_lines where shop_id = $1 union select title from shop_items where shop_id = $1",
      [shopId],
    );
    await checkTitlesAgainstWarnings(db, shopId, rows.map((r) => r.title));
  } catch (err) {
    console.error("warning check skipped:", err instanceof Error ? err.name : "unknown error");
  }
}

/** New warnings reach shops that already had their check. Demo shops have only their labelled sample. */
export async function checkStoredShopsAgainstWarnings(db: Queryable): Promise<void> {
  const { rows } = await db.query<{ id: string }>("select id from shops where kind = 'REAL'");
  for (const { id } of rows) await checkShopAgainstWarnings(db, id);
}

export type ShopWarning = Warning & { itemTitle: string };

export async function readWarningsFor(db: Queryable, shopId: string): Promise<ShopWarning[]> {
  const { rows } = await db.query<{ warning_number: string; warned_on: unknown; title: string; product: string; description: string; hazard: string; consumer_action: string; sold_at: string; item_title: string }>(
    `select w.warning_number, w.warned_on::text as warned_on, w.title, w.product, w.description, w.hazard, w.consumer_action, w.sold_at, m.item_title
     from safety_warning_matches m join safety_warnings w on w.warning_number = m.warning_number
     where m.shop_id = $1 order by w.warned_on desc, m.item_title`,
    [shopId],
  );
  return rows.map((r) => ({
    number: r.warning_number,
    warnedOn: String(r.warned_on),
    title: r.title,
    product: r.product,
    description: r.description,
    hazard: r.hazard,
    consumerAction: r.consumer_action,
    soldAt: r.sold_at,
    itemTitle: r.item_title,
  }));
}
