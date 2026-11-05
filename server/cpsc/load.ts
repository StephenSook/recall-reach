import type { Db, Queryable } from "../db/types";
import type { FetchDeps, RecallRange } from "./fetch";
import { pullRecalls, type PullSummary } from "./pull";

/** The RecallDate range for a calendar year, ending today if the year is still running. */
export function yearRange(year: number, today: string): RecallRange {
  const start = `${year}-01-01`;
  if (start > today) throw new Error(`year ${year} has not started (today is ${today})`);
  const yearEnd = `${year}-12-31`;
  return { field: "RecallDate", start, end: yearEnd < today ? yearEnd : today };
}

/** Number of stored recalls per recall year. */
export async function recallCountsByYear(db: Queryable): Promise<Record<number, number>> {
  const { rows } = await db.query<{ year: number; n: string }>(
    "select extract(year from recall_date)::integer as year, count(*)::text as n from recalls group by 1 order by 1",
  );
  return Object.fromEntries(rows.map((r) => [Number(r.year), Number(r.n)]));
}

/** Pulls whole recall years one after another, then reports what is stored per year. */
export async function loadYears(
  db: Db,
  years: number[],
  today: string,
  deps: FetchDeps = {},
): Promise<{ pulls: PullSummary[]; countsByYear: Record<number, number> }> {
  const pulls: PullSummary[] = [];
  for (const year of years) pulls.push(await pullRecalls(db, yearRange(year, today), deps));
  return { pulls, countsByYear: await recallCountsByYear(db) };
}
