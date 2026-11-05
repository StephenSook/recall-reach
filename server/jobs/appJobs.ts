import { fetchRecalls, type FetchDeps } from "../cpsc/fetch";
import { recordPull, snapshotHash } from "../cpsc/pull";
import type { Db } from "../db/types";
import { purgePayPalData } from "../privacy/retention";
import { cpscPollRange, MAX_CATCHUP_DAYS, type Job } from "./scheduler";

export const POLL_MS = 15 * 60_000;
/** Every 4th poll (hourly) is a heartbeat: it writes even if nothing changed, and purges PayPal data. */
export const HEARTBEAT_TICKS = 4;

export interface RecallPollStatus {
  lastPollAt: string | null;
  lastPollOk: boolean | null;
  dbTouched: boolean | null;
}

// On globalThis because Next.js can load instrumentation and route handlers as separate module
// graphs in one process. This is what lets /api/health show the last poll without a database call.
const holder = globalThis as typeof globalThis & { __recallReachPoll?: RecallPollStatus };

export function recallPollStatus(): RecallPollStatus {
  return holder.__recallReachPoll ?? { lastPollAt: null, lastPollOk: null, dbTouched: null };
}

async function lastPolledThrough(db: Db): Promise<string | null> {
  const { rows } = await db.query<{ range_end: string }>(
    `select range_end from cpsc_pulls
     where range_field = 'LastPublishDate' and status in ('ok', 'partial')
     order by range_end desc limit 1`,
  );
  return rows[0]?.range_end ?? null;
}

/**
 * The one background job. Neon's free plan has 100 CU-hours a month and the compute stays awake 5
 * minutes after any activity, so a query every 15 minutes would keep it awake around the clock and
 * eventually take the whole app down. A quiet poll is therefore HTTP only: the database is touched
 * when CPSC's answer differs from the last one held in memory, and on the hourly heartbeat, which
 * also runs the PayPal purge so both share one wake-up.
 */
export function appJobs(db: Db, deps: FetchDeps & { now?: () => Date } = {}): Job[] {
  const now = deps.now ?? (() => new Date());
  let ticks = 0;
  let lastHash: string | null = null;
  // Where the last good poll reached. Read once from the database (the first tick writes anyway),
  // then kept here so a CPSC outage can be caught up without waking the database.
  let polledThrough: string | null | undefined;

  // Set by each heartbeat and cleared only by a purge that worked, so a failed purge is retried on
  // the next tick instead of waiting an hour. Its margin under 48 hours is what that hour would use.
  let purgeOwed = false;

  const poll = async () => {
    const heartbeat = ticks % HEARTBEAT_TICKS === 0;
    ticks++;
    const at = now();

    // First, so nothing about CPSC's response or its latency can skip or delay it.
    if (heartbeat) purgeOwed = true;
    let purged: Record<string, number> | null = null;
    let purgeError: unknown = null;
    if (purgeOwed) {
      try {
        purged = await purgePayPalData(db, at);
        purgeOwed = false;
      } catch (err) {
        purgeError = err;
      }
    }

    if (polledThrough === undefined) {
      polledThrough = await lastPolledThrough(db);
      const covered = polledThrough ? Date.parse(`${polledThrough}T00:00:00Z`) : null;
      if (covered !== null && at.getTime() - covered > MAX_CATCHUP_DAYS * 86_400_000) {
        console.warn(
          `cpsc-poll: the last good pull ended ${polledThrough}, past the ${MAX_CATCHUP_DAYS}-day catch-up cap; ` +
            "run pnpm load:recalls to fill the gap",
        );
      }
    }
    const range = cpscPollRange(at, polledThrough);

    let payload: unknown[] | null = null;
    let fetchError: unknown = null;
    let hash: string | null = null;
    try {
      const fetched = await fetchRecalls(range, deps);
      hash = snapshotHash(fetched);
      payload = fetched;
    } catch (err) {
      fetchError = err;
    }
    if (payload) polledThrough = range.end;
    const changed = hash !== null && hash !== lastHash;
    const touchDb = heartbeat || changed;

    let writeError: unknown = null;
    if (touchDb) {
      try {
        await recordPull(db, range, async () => {
          if (payload) return payload;
          throw fetchError;
        });
        if (hash) lastHash = hash;
      } catch (err) {
        // A failed fetch is already recorded by recordPull and raised below.
        if (err !== fetchError) writeError = err;
      }
    }

    holder.__recallReachPoll = { lastPollAt: at.toISOString(), lastPollOk: fetchError === null, dbTouched: touchDb };
    const why = heartbeat ? " (heartbeat)" : changed ? " (changed)" : "";
    const fetched = payload ? `fetched ${payload.length}` : "fetch failed";
    console.info(
      `cpsc-poll ${range.start}..${range.end}: ${fetched}, db=${touchDb ? `touched${why}` : "untouched"}` +
        (purged ? `, purged ${JSON.stringify(purged)}` : ""),
    );

    const failure = fetchError ?? writeError ?? purgeError;
    if (failure) throw failure;
  };

  return [{ name: "cpsc-poll", everyMs: POLL_MS, deadlineMs: 10 * 60_000, run: poll }];
}
