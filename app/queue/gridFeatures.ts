// The small decisions behind the Enterprise tables, kept apart from the grid so they can be tested.

/**
 * A copy of the columns grouped by one of them, or none. Every groupable column says so outright, because the grid keeps a group
 * the new columns don't mention. The chosen one is hidden: each group row already says it.
 */
export function grouped<T extends { field?: unknown; enableRowGroup?: boolean }>(columns: T[], field: string | null): T[] {
  return columns.map((c) => (c.enableRowGroup ? { ...c, rowGroup: c.field === field, hide: c.field === field } : c));
}

export interface RefundTotal {
  count: number;
  usd: number;
  /** Refund-eligible sales with no price in dollars. They count, and aren't in the money figure. */
  unpriced: number;
}

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
  /** Sales priced in another currency. A listing nobody bought isn't one. */
  unpriced: number;
}

export function saleSum(rows: Iterable<{ saleId?: string | null; saleUsd?: number | null; soldOn?: string | null }>): SaleSum {
  let cents = 0;
  let unpriced = 0;
  for (const row of oneRowPerSale(rows)) {
    if (row.saleUsd !== null && row.saleUsd !== undefined) cents += Math.round(row.saleUsd * 100);
    else if (row.soldOn) unpriced++;
  }
  return { usd: cents / 100, unpriced };
}

const DOLLARS = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });
export const usd = (value: number | null | undefined) => (value === null || value === undefined ? "" : DOLLARS.format(value));

export const saleLabel = (sum: SaleSum) => (sum.unpriced > 0 ? `${usd(sum.usd)} + ${sum.unpriced} not in USD` : usd(sum.usd));

const NOT_EXPORTED = new Set(["open", "ag-Grid-SelectionColumn"]);
export const excelColumns = (columnIds: string[]) => columnIds.filter((id) => !NOT_EXPORTED.has(id));
