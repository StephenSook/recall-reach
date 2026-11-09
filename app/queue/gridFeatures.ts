// The small decisions behind the Enterprise tables, kept apart from the grid so they can be tested.

/** A copy of the columns grouped by one of them. It's hidden there because each group row already says it. */
export function grouped<T extends { field?: unknown }>(columns: T[], field: string | null): T[] {
  if (!field) return columns;
  return columns.map((c) => (c.field === field ? { ...c, rowGroup: true, hide: true } : c));
}

export interface RefundTotal {
  count: number;
  usd: number;
  /** Refund-eligible sales with no price in dollars. They count, and aren't in the money figure. */
  unpriced: number;
}

export function refundTotal(rows: Iterable<{ refundEligible?: boolean; saleUsd?: number | null }>): RefundTotal {
  let count = 0;
  let cents = 0;
  let unpriced = 0;
  for (const row of rows) {
    if (!row.refundEligible) continue;
    count++;
    if (row.saleUsd === null || row.saleUsd === undefined) unpriced++;
    else cents += Math.round(row.saleUsd * 100);
  }
  return { count, usd: cents / 100, unpriced };
}

const DOLLARS = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });
export const usd = (value: number | null | undefined) => (value === null || value === undefined ? "" : DOLLARS.format(value));

const NOT_EXPORTED = new Set(["open", "ag-Grid-SelectionColumn"]);
export const excelColumns = (columnIds: string[]) => columnIds.filter((id) => !NOT_EXPORTED.has(id));
