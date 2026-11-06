// The only place text for Claude is read. CPSC's text, and the shop's own words about an item: its title,
// its SKU, and a listing's description. Nothing about a sale, a buyer or a payment is selected here.
import { createHash } from "node:crypto";
import type { RecallProduct } from "../cpsc/schema";
import type { Queryable } from "../db/types";
import { publicText, shopOwnedText, type AllowedValue } from "./boundary";

export interface Snapshot {
  /** What Claude reads. */
  text: AllowedValue;
  /** Where a quote about this text must come from. */
  quotable: string[];
  sha256: string;
}

/** A hash input is JSON, so free text cannot run one field into the next. */
const hash = (fields: unknown) => createHash("sha256").update(JSON.stringify(fields)).digest("hex");

const pub = (value: string | null) => (value ? publicText(value) : null);
const own = (value: string | null) => (value ? shopOwnedText(value) : null);

export async function readRecall(db: Queryable, recallId: number): Promise<(Snapshot & { number: string; sha256: string }) | null> {
  const { rows } = await db.query<{
    recall_number: string;
    title: string;
    description: string;
    products: RecallProduct[];
    hazards: string[];
    remedies: string[];
    raw_sha256: string;
  }>("select recall_number, title, description, products, hazards, remedies, raw_sha256 from recalls where recall_id = $1", [recallId]);
  const r = rows[0];
  if (!r) return null;
  return {
    number: r.recall_number,
    sha256: r.raw_sha256,
    text: {
      recall_number: publicText(r.recall_number),
      title: publicText(r.title),
      description: publicText(r.description),
      products: r.products.map((p) => ({ name: publicText(p.name), model: pub(p.model), type: pub(p.type) })),
      hazards: r.hazards.map(publicText),
      remedies: r.remedies.map(publicText),
    },
    quotable: [r.title, r.description, ...r.products.flatMap((p) => [p.name, p.model, p.type ?? ""]), ...r.hazards, ...r.remedies].filter(Boolean),
  };
}

export type RecordKind = "order_line" | "shop_item";
export interface ShopRecord {
  kind: RecordKind;
  id: string;
}

/**
 * A sold line says little. The shop's listing with the same SKU can say more, so it counts as this item's
 * text. A listing with another SKU, or none, is another item.
 */
export async function readItem(db: Queryable, shopId: string, record: ShopRecord): Promise<(Snapshot & { title: string }) | null> {
  const table = record.kind === "order_line" ? "order_lines" : "shop_items";
  const description = record.kind === "order_line" ? "''" : "description";
  const { rows } = await db.query<{ title: string; sku: string | null; description: string }>(
    `select title, sku, ${description} as description from ${table} where id = $1 and shop_id = $2`,
    [record.id, shopId],
  );
  const item = rows[0];
  if (!item) return null;
  const linked = item.sku
    ? (
        await db.query<{ title: string; description: string }>(
          `select title, description from shop_items where shop_id = $1 and sku = $2 and id <> $3 order by title, description`,
          [shopId, item.sku, record.id],
        )
      ).rows
    : [];
  return {
    title: item.title,
    sha256: hash([item.title, item.sku, item.description, linked]),
    text: {
      title: shopOwnedText(item.title),
      sku: own(item.sku),
      description: own(item.description),
      listings_with_this_sku: linked.map((l) => ({ title: shopOwnedText(l.title), description: own(l.description) })),
    },
    quotable: [item.title, item.sku ?? "", item.description, ...linked.flatMap((l) => [l.title, l.description])].filter(Boolean),
  };
}

const SEARCH_LIMIT = 5;
const MIN_SIMILARITY = 0.3;

/** The shop's own items whose words are nearest the query, one row per different title. */
export async function searchItems(db: Queryable, shopId: string, query: string): Promise<{ record: ShopRecord; text: { title: AllowedValue; sku: AllowedValue } }[]> {
  const { rows } = await db.query<ShopRecord & { title: string; sku: string | null }>(
    `select distinct on (score, title) kind, id, title, sku from (
       select 'order_line' as kind, id, title, sku, word_similarity($2, title || ' ' || coalesce(sku, '')) as score
       from order_lines where shop_id = $1
       union all
       select 'shop_item', id, title, sku, word_similarity($2, title || ' ' || coalesce(sku, '') || ' ' || description)
       from shop_items where shop_id = $1
     ) found
     where score >= $3
     order by score desc, title, id
     limit $4`,
    [shopId, query, MIN_SIMILARITY, SEARCH_LIMIT],
  );
  return rows.map((r) => ({ record: { kind: r.kind, id: r.id }, text: { title: shopOwnedText(r.title), sku: own(r.sku) } }));
}
