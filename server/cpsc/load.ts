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

const DAY_MS = 86_400_000;
/** The poll runs hourly, so being this far behind means an outage. The year then says it isn't fully held until it catches up. */
const RUNNING_YEAR_BEHIND_DAYS = 3;
const nextDay = (day: string) => new Date(Date.parse(`${day}T00:00:00Z`) + DAY_MS).toISOString().slice(0, 10);

interface HeldPull {
  range_field: string;
  range_start: string;
  range_end: string;
}

/** A pull from the year's first day, then polls with no gap between them from where it stopped, up to about today. */
function runningYearHeld(pulls: HeldPull[], year: number, today: string): boolean {
  const whole = pulls.filter((p) => p.range_field === "RecallDate" && p.range_start === `${year}-01-01`);
  if (whole.length === 0) return false;
  let reached = whole.map((p) => p.range_end).sort().at(-1) ?? "";
  const polls = pulls.filter((p) => p.range_field === "LastPublishDate").sort((a, b) => a.range_start.localeCompare(b.range_start));
  for (const poll of polls) {
    if (poll.range_start <= nextDay(reached) && poll.range_end > reached) reached = poll.range_end;
  }
  return Date.parse(today) - Date.parse(reached) <= RUNNING_YEAR_BEHIND_DAYS * DAY_MS;
}

/**
 * Years from `fromYear` that aren't held. A past year needs a whole-year pull that returned recalls. The running year needs
 * one from its first day that the poll has carried on from without a gap. An empty answer for a whole year is a bad answer,
 * and a partial pull doesn't count as loading a year.
 */
export async function missingRecallYears(db: Queryable, fromYear: number, today: string): Promise<number[]> {
  const { rows } = await db.query<HeldPull>(
    `select range_field, range_start::text as range_start, range_end::text as range_end from cpsc_pulls
     where (range_field = 'RecallDate' and status = 'ok' and fetched > 0) or (range_field = 'LastPublishDate' and status in ('ok', 'partial'))`,
  );
  const loaded = new Set(rows.filter((r) => r.range_field === "RecallDate").map((r) => `${r.range_start}..${r.range_end}`));
  const thisYear = Number(today.slice(0, 4));
  const missing: number[] = [];
  for (let year = fromYear; year < thisYear; year++) {
    if (!loaded.has(`${year}-01-01..${year}-12-31`)) missing.push(year);
  }
  if (thisYear >= fromYear && !runningYearHeld(rows, thisYear, today)) missing.push(thisYear);
  return missing;
}

/**
 * Pulls only the missing years. One year's failure is reported, the others still run, and it is tried again next time.
 * With a budget, no new year starts once it is spent, and those years are named as deferred.
 */
export async function loadMissingYears(
  db: Db,
  fromYear: number,
  today: string,
  deps: FetchDeps = {},
  opts: { budgetMs?: number } = {},
): Promise<{ pulls: PullSummary[]; failed: { year: number; error: string }[]; deferred: number[] }> {
  const started = Date.now();
  const pulls: PullSummary[] = [];
  const failed: { year: number; error: string }[] = [];
  const deferred: number[] = [];
  for (const year of await missingRecallYears(db, fromYear, today)) {
    if (opts.budgetMs !== undefined && Date.now() - started > opts.budgetMs) {
      deferred.push(year);
      continue;
    }
    try {
      const pull = await pullRecalls(db, yearRange(year, today), deps);
      if (pull.fetched === 0) failed.push({ year, error: "CPSC returned no recalls for this year" });
      else pulls.push(pull);
    } catch (err) {
      failed.push({ year, error: err instanceof Error ? err.message : String(err) });
    }
  }
  return { pulls, failed, deferred };
}
