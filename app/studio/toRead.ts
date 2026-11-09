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

export const recallPage = (recallNumber: string) => `/recall/${encodeURIComponent(recallNumber)}`;
