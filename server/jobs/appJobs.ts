import { fetchRecalls, type FetchDeps } from "../cpsc/fetch";
import { loadMissingYears } from "../cpsc/load";
import { recordPull, snapshotHash } from "../cpsc/pull";
import type { Db } from "../db/types";
import { purgeOldDemoShops, purgeOldOwnShops } from "../import/ownFile";
import { checkStoredShops, SWEEP_BUDGET_MS, type SweepSummary } from "../match/sweep";
import { purgePayPalData } from "../privacy/retention";
import { cpscPollRange, MAX_CATCHUP_DAYS, type Job } from "./scheduler";

export const POLL_MS = 15 * 60_000;
/** Every 4th poll (hourly) is a heartbeat: it writes even if nothing changed, and purges PayPal data. */
export const HEARTBEAT_TICKS = 4;
/** A job past its deadline is released while it may still be running, so its parts must fit inside it. */
const JOB_DEADLINE_MS = 10 * 60_000;
const JOB_BUDGET_MS = 8 * 60_000;
/** Past years don't need the poll's patience: what doesn't load now is tried again in an hour. */
const BACKFILL_TIMEOUT_MS = 20_000;
const BACKFILL_BUDGET_MS = 2 * 60_000;

export interface RecallPollStatus {
  lastPollAt: string | null;
  lastPollOk: boolean | null;
  dbTouched: boolean | null;
  /** The last check of stored shops against new recalls. Counts only: no shop is named here. */
  sweep?: SweepSummary | null;
  sweepOk?: boolean | null;
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
export function appJobs(db: Db, deps: FetchDeps & { now?: () => Date; refreshReplay?: (at: Date) => Promise<string>; refreshSafety?: (at: Date) => Promise<string>; pingClaude?: (at: Date) => Promise<string>; sweepMarket?: (at: Date) => Promise<{ searched: number; failed: number; left: number }>; maxShopsPerSweep?: number; backfillFromYear?: number; backfillBudgetMs?: number } = {}): Job[] {
  const now = deps.now ?? (() => new Date());
  let ticks = 0;
  let lastHash: string | null = null;
  // Where the last good poll reached. Read once from the database (the first tick writes anyway),
  // then kept here so a CPSC outage can be caught up without waking the database.
  let polledThrough: string | null | undefined;

  // Set by each heartbeat and cleared only by a purge that worked, so a failed purge is retried on
  // the next tick instead of waiting an hour. Its margin under 48 hours is what that hour would use.
  let purgeOwed = false;
  // Set when a check of stored shops ran out of its turn, so the rest don't wait for the next heartbeat.
  let sweepOwed = false;

  const poll = async () => {
    const started = Date.now();
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
        await purgeOldOwnShops(db, at);
        await purgeOldDemoShops(db, at);
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
    const changed = hash !== null && hash !== lastHash;
    const touchDb = heartbeat || changed || sweepOwed;

    let writeError: unknown = null;
    if (touchDb) {
      try {
        await recordPull(db, range, async () => {
          if (payload) return payload;
          throw fetchError;
        });
        if (hash) {
          lastHash = hash;
          polledThrough = range.end;
        }
      } catch (err) {
        // A failed fetch is already recorded by recordPull and raised below.
        if (err !== fetchError) writeError = err;
      }
    } else if (payload) {
      polledThrough = range.end; // the same answer as the one already stored
    }

    // Past years that aren't all here. The first tick after a deploy is a heartbeat, so they load straight away, and a
    // failed year is tried again each hour. Nothing waits for another deploy: the repo freezes, and CPSC can have a bad day.
    let loaded = "";
    if (heartbeat && deps.backfillFromYear !== undefined) {
      try {
        const { pulls, failed, deferred } = await loadMissingYears(
          db,
          deps.backfillFromYear,
          at.toISOString().slice(0, 10),
          { ...deps, timeoutMs: deps.timeoutMs ?? BACKFILL_TIMEOUT_MS },
          { budgetMs: deps.backfillBudgetMs ?? BACKFILL_BUDGET_MS },
        );
        for (const f of failed) console.warn(`cpsc-load: recall year ${f.year} did not load: ${f.error}`);
        if (pulls.length > 0) loaded = `, loaded ${pulls.length} ${pulls.length === 1 ? "year" : "years"} (${pulls.reduce((n, p) => n + p.inserted, 0)} new)`;
        if (deferred.length > 0) loaded += `, ${deferred.length} ${deferred.length === 1 ? "year" : "years"} left for the next hour`;
      } catch (err) {
        console.warn(`cpsc-load: could not load past years: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    // Only when the database is awake anyway, so a quiet poll stays off it. The first tick after a deploy is a heartbeat,
    // which is what catches recalls the deploy loaded. A failed shop is tried again on the next touched tick.
    const earlier = holder.__recallReachPoll;
    let sweep = earlier?.sweep ?? null;
    let sweepOk = earlier?.sweepOk ?? null;
    let sweepError: unknown = null;
    if (touchDb) {
      try {
        sweep = await checkStoredShops(db, {
          now: at,
          maxShops: deps.maxShopsPerSweep,
          budgetMs: Math.max(0, Math.min(SWEEP_BUDGET_MS, JOB_BUDGET_MS - (Date.now() - started))),
        });
        sweepOk = true;
        sweepOwed = sweep.shopsWaiting > 0;
      } catch (err) {
        sweepError = err;
        sweepOk = false;
        console.error(`recall check of stored shops failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    // On the heartbeat, so it shares a wake-up that is happening anyway. A failure here says nothing about CPSC.
    let replay: string | null = null;
    let replayError: unknown = null;
    if (heartbeat && deps.refreshReplay && Date.now() - started < JOB_BUDGET_MS) {
      try {
        replay = await deps.refreshReplay(at);
      } catch (err) {
        replayError = err;
        console.error(`replay refresh failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    // Under a second, moves no money and calls no model. It only runs once a day.
    let safety: string | null = null;
    let safetyError: unknown = null;
    if (heartbeat && deps.refreshSafety && Date.now() - started < JOB_BUDGET_MS) {
      try {
        safety = await deps.refreshSafety(at);
      } catch (err) {
        safetyError = err;
        console.error(`safety checks failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    // Also on the heartbeat, and cached, so nobody reading a result ever waits on it or runs into its limit.
    let market: { searched: number; failed: number; left: number } | null = null;
    let marketError: unknown = null;
    if (heartbeat && deps.sweepMarket && Date.now() - started < JOB_BUDGET_MS) {
      try {
        market = await deps.sweepMarket(at);
      } catch (err) {
        marketError = err;
        console.error(`market search failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    // Also on the heartbeat, and it keeps its own day. It says why it failed, never what the answer held.
    let claude: string | null = null;
    let claudeError: unknown = null;
    if (heartbeat && deps.pingClaude && Date.now() - started < JOB_BUDGET_MS) {
      try {
        claude = await deps.pingClaude(at);
      } catch (err) {
        claudeError = err;
        console.error(`Claude daily call failed: ${err instanceof Error ? err.name : "unknown error"}`);
      }
    }

    holder.__recallReachPoll = { lastPollAt: at.toISOString(), lastPollOk: fetchError === null, dbTouched: touchDb, sweep, sweepOk };
    const why = heartbeat ? " (heartbeat)" : changed ? " (changed)" : touchDb ? " (shops waiting)" : "";
    const fetched = payload ? `fetched ${payload.length}` : "fetch failed";
    console.info(
      `cpsc-poll ${range.start}..${range.end}: ${fetched}, db=${touchDb ? `touched${why}` : "untouched"}` +
        (purged ? `, purged ${JSON.stringify(purged)}` : "") +
        loaded +
        (touchDb && sweep && sweep.shopsChecked > 0 ? `, checked ${sweep.shopsChecked} ${sweep.shopsChecked === 1 ? "shop" : "shops"} against new recalls` : "") +
        (touchDb && sweep && sweep.shopsFailed > 0 ? `, ${sweep.shopsFailed} failed` : "") +
        (touchDb && sweep && sweep.shopsWaiting > 0 ? `, ${sweep.shopsWaiting} waiting` : "") +
        (replay && replay !== "FRESH" ? `, replay ${replay.toLowerCase()}` : "") +
        (safety && safety !== "FRESH" ? `, safety ${safety.toLowerCase()}` : "") +
        (market ? `, market searched ${market.searched}, ${market.left} left${market.failed > 0 ? `, ${market.failed} failed` : ""}` : "") +
        (claude && claude !== "NOT_DUE" ? `, claude ${claude.toLowerCase()}` : ""),
    );

    const failure = fetchError ?? writeError ?? purgeError ?? sweepError ?? replayError ?? safetyError ?? marketError ?? claudeError;
    if (failure) throw failure;
  };

  return [{ name: "cpsc-poll", everyMs: POLL_MS, deadlineMs: JOB_DEADLINE_MS, run: poll }];
}
