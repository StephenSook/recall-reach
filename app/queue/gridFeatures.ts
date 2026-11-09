// The small decisions behind the Enterprise tables, kept apart from the grid so they can be tested.

/**
 * A copy of the columns grouped by one of them, or none. Every groupable column says so outright, because the grid keeps a group
 * the new columns don't mention. The chosen one is hidden: each group row already says it.
 */
export function grouped<T extends { field?: unknown }>(columns: T[], field: string | null, groupable: readonly string[]): T[] {
  return columns.map((c) => (groupable.includes(String(c.field)) ? { ...c, rowGroup: c.field === field, hide: c.field === field } : c));
}

export interface RefundTotal {
  count: number;
  usd: number;
  /** Refund-eligible sales with no price in dollars. They count, and aren't in the money figure. */
  unpriced: number;
}

const UNIDENTIFIED = "UNIDENTIFIED";

/** A group row has no data of its own, so what it may carry depends on what's under it. */
export const onlyUnidentified = (rows: readonly { verdict?: string }[]) => rows.length > 0 && rows.every((r) => r.verdict === UNIDENTIFIED);

export const hasSaleWithNoUsdPrice = (rows: readonly { soldOn?: string | null; saleUsd?: number | null; verdict?: string }[]) =>
  rows.some((r) => r.soldOn && r.saleUsd === null && r.verdict !== UNIDENTIFIED);

/** One row per sale: a sale that matches two recalls is two rows, and can only be refunded once. */
function oneRowPerSale<T extends { saleId?: string | null }>(rows: Iterable<T>): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const row of rows) {
    if (row.saleId) {
      if (seen.has(row.saleId)) continue;
      seen.add(row.saleId);
    }
    out.push(row);
  }
  return out;
}

export function refundTotal(rows: Iterable<{ saleId?: string | null; refundEligible?: boolean; saleUsd?: number | null }>): RefundTotal {
  let cents = 0;
  let unpriced = 0;
  const eligible = oneRowPerSale([...rows].filter((r) => r.refundEligible));
  for (const row of eligible) {
    if (row.saleUsd === null || row.saleUsd === undefined) unpriced++;
    else cents += Math.round(row.saleUsd * 100);
  }
  return { count: eligible.length, usd: cents / 100, unpriced };
}

export interface SaleSum {
  usd: number;
  /** Sales with no price to count: another currency, or an order that couldn't be read in full. A listing nobody bought isn't one. */
  unpriced: number;
}

export function saleSum(rows: Iterable<{ saleId?: string | null; saleUsd?: number | null; soldOn?: string | null; verdict?: string }>): SaleSum {
  let cents = 0;
  let unpriced = 0;
  for (const row of oneRowPerSale([...rows].filter((r) => r.verdict !== UNIDENTIFIED))) {
    if (row.saleUsd !== null && row.saleUsd !== undefined) cents += Math.round(row.saleUsd * 100);
    else if (row.soldOn) unpriced++;
  }
  return { usd: cents / 100, unpriced };
}

const DOLLARS = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });
export const usd = (value: number | null | undefined) => (value === null || value === undefined ? "" : DOLLARS.format(value));

export const saleLabel = (sum: SaleSum) => (sum.unpriced > 0 ? `${usd(sum.usd)} + ${sum.unpriced} with no USD price` : usd(sum.usd));

const NO_USD_PRICE = "No USD price";
type SaleRow = { soldOn?: string | null; verdict?: string } | undefined;
const isTotal = (value: unknown): value is { unpriced: number; toString(): string; toNumber(): number } => value !== null && typeof value === "object" && "toNumber" in value;

/** What the Sale column says: a group's total in words, dollars on a sale, and never a blank where a price was left out. */
export function saleCellWords(value: unknown, row: SaleRow): string {
  if (isTotal(value)) return value.toString();
  if (value === null || value === undefined) return row?.soldOn && row.verdict !== UNIDENTIFIED ? NO_USD_PRICE : "";
  return usd(value as number);
}

/** The same for Excel. Numbers stay numbers so they add up, and a total that left a sale out keeps saying so. */
export function saleForExport(value: unknown, row: SaleRow): unknown {
  if (isTotal(value)) return value.unpriced > 0 ? value.toString() : value.toNumber();
  if ((value === null || value === undefined) && row?.soldOn && row.verdict !== UNIDENTIFIED) return NO_USD_PRICE;
  return value;
}

/** What a cell copies as. A payment nobody could identify is PayPal's record, not the shop's, so it doesn't leave by copying either. */
export function copiedCell(columnId: string, value: unknown, row: ({ verdict?: string } & SaleRow) | undefined): unknown {
  if (row?.verdict === UNIDENTIFIED) return "";
  return columnId === "saleUsd" ? saleCellWords(value, row) : value;
}

/** Sales by recall is the one chart where each sale counts once, so nothing else can be picked in the chart's own panel. */
export function chartRole(field: string): "category" | "series" | "excluded" {
  if (field === "recallNumber") return "category";
  return field === "saleUsd" ? "series" : "excluded";
}

const NOT_EXPORTED = new Set(["open", "ag-Grid-SelectionColumn"]);
export const excelColumns = (columnIds: string[]) => columnIds.filter((id) => !NOT_EXPORTED.has(id));
