// Which recalls on the dashboard an owner should open first: the rules' matches, then the ones they couldn't settle.

export interface RecallRow {
  recallNumber: string;
  title: string;
  outcome: string;
}

const RANK = new Map([
  ["Matched", 0],
  ["Can't tell yet", 1],
]);

export function recallsToRead(rows: readonly RecallRow[]): RecallRow[] {
  return rows.filter((r) => RANK.has(r.outcome)).sort((a, b) => (RANK.get(a.outcome) ?? 0) - (RANK.get(b.outcome) ?? 0) || b.recallNumber.localeCompare(a.recallNumber, "en", { numeric: true }));
}

/** Null when the query failed. A failed query comes back with no rows, and that must not read as nothing to open. */
export function rowsFrom(result: { rows: Record<string, unknown>[]; metadata?: { error?: unknown } }, keys: { recall: string; title: string; outcome: string }): RecallRow[] | null {
  if (result.metadata?.error) return null;
  return result.rows.map((row) => ({ recallNumber: String(row[keys.recall]), title: String(row[keys.title]), outcome: String(row[keys.outcome]) }));
}

export const recallPage = (recallNumber: string) => `/recall/${encodeURIComponent(recallNumber)}`;
