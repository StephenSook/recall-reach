// Recall Replay: every recall loaded, in one run, against the demo catalog, with a clock. It uses the same seed and
// matcher as a demo shop, but makes no capture, so it spends nothing and anyone can run it again.
import { missingRecallYears } from "../cpsc/load";
import type { Db, Queryable } from "../db/types";
import { seedDemoShop } from "../demo/seed";
import type { PayPalClient } from "../paypal/client";

export const REPLAYS_KEPT = 20;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type ReplayOutcome = "MATCH" | "SCOPE_GAP" | "CLEARED" | "NOT_NEAR";

export interface ReplayRow {
  recallNumber: string;
  recallTitle: string;
  recallDate: string;
  outcome: ReplayOutcome;
  saleSplit: "NOTICE_ONLY" | "REVIEW" | "REFUND_ELIGIBLE" | null;
  itemTitle: string | null;
  reason: string | null;
}

export interface ReplayCounts {
  checked: number;
  matched: number;
  scopeGaps: number;
  cleared: number;
  notNear: number;
  noticeOnly: number;
  refundEligible: number;
}

export interface Replay {
  runId: string;
  ms: number;
  createdAt: string;
  counts: ReplayCounts & { unidentified: number };
  search: { windows: number; failedWindows: number; complete: boolean };
  /** Past years whose recalls hadn't fully loaded when this ran. */
  recallYearsMissing: number[];
  rows: ReplayRow[];
}

/** Replay keeps its own stated window: all of 2025 and 2026 so far. The shop check reaches further back. */
export const REPLAY_FROM = "2025-01-01";

/** Someone may arrive after a quiet week, so the hourly job keeps a run from the last day. */
export const REPLAY_FRESH_MS = 24 * 3_600_000;

const DIGEST_SQL = `encode(sha256(convert_to(string_agg(recall_number || ':' || raw_sha256, ',' order by recall_number), 'UTF8')), 'hex')`;

async function countsOf(db: Queryable, runId: string): Promise<ReplayCounts> {
  const { rows } = await db.query<Record<string, number>>(
    `select count(*)::int as checked,
       count(*) filter (where outcome = 'MATCH')::int as matched,
       count(*) filter (where outcome = 'SCOPE_GAP')::int as scope_gaps,
       count(*) filter (where outcome = 'CLEARED')::int as cleared,
       count(*) filter (where outcome = 'NOT_NEAR')::int as not_near,
       count(*) filter (where outcome = 'MATCH' and sale_split = 'NOTICE_ONLY')::int as notice_only,
       count(*) filter (where outcome = 'MATCH' and sale_split = 'REFUND_ELIGIBLE')::int as refund_eligible
     from replay_rows where run_id = $1`,
    [runId],
  );
  const c = rows[0];
  return { checked: c.checked, matched: c.matched, scopeGaps: c.scope_gaps, cleared: c.cleared, notNear: c.not_near, noticeOnly: c.notice_only, refundEligible: c.refund_eligible };
}

export async function runReplay(db: Db, client: PayPalClient, input: { today: string; now: Date; secret: string }): Promise<{ runId: string }> {
  const started = performance.now();
  // Before the recalls, so a year loading between the two reads is called missing, never claimed.
  const recallYearsMissing = await missingRecallYears(db, Number(REPLAY_FROM.slice(0, 4)), input.today);
  // Read first, so every recall this run reports was already there when its check began. One loading during the run
  // waits for the next run, instead of being reported as nothing near. Recalls are never deleted, so the check sees all of these.
  const read = await db.query<{ ids: number[]; digest: string }>(
    `select coalesce(array_agg(recall_id), '{}') as ids, ${DIGEST_SQL} as digest from recalls where recall_date >= $1::date`,
    [REPLAY_FROM],
  );
  const { ids, digest } = read.rows[0];
  const { shopId, run, search } = await seedDemoShop(db, client, { today: input.today, secret: input.secret, now: input.now, freshCaptures: false, recallsFrom: REPLAY_FROM });
  try {
    const ms = Math.max(1, Math.round(performance.now() - started));
    // All at once, so nobody can read a run with no rows yet, and one that fails part way can't pass for a fresh one.
    return await db.transaction(async (tx) => {
      const { rows } = await tx.query<{ id: string }>(
        `insert into replay_runs (ms, checked, matched, scope_gaps, cleared, not_near, notice_only, refund_eligible, unidentified, search_windows, failed_windows, search_complete, recalls_digest, recall_years_missing)
         values ($1, 0, 0, 0, 0, 0, 0, 0, $2, $3, $4, $5, $6, $7::int[]) returning id`,
        [ms, run.unidentifiedPayments, search?.windows ?? 0, search?.failedWindows.length ?? 0, search?.complete ?? false, digest, recallYearsMissing],
      );
      const runId = rows[0].id;
      // A recall's strongest outcome is what the replay reports for it. CLEARED means an item came near and was ruled out.
      await tx.query(
        `insert into replay_rows (run_id, recall_number, recall_title, recall_date, outcome, sale_split, item_title, reason)
         select distinct on (r.recall_id) $1::uuid, r.recall_number, r.title, r.recall_date, coalesce(m.verdict, 'NOT_NEAR'),
           case when m.verdict = 'MATCH' then m.sale_path end, coalesce(l.title, i.title), m.reason
         from recalls r
         left join recall_matches m on m.recall_id = r.recall_id and m.shop_id = $2
         left join order_lines l on l.id = m.order_line_id
         left join shop_items i on i.id = m.shop_item_id
         where r.recall_id = any($3::int[])
         order by r.recall_id,
           case m.verdict when 'MATCH' then 0 when 'SCOPE_GAP' then 1 when 'CLEARED' then 2 else 3 end,
           case m.strength when 'CONFIRMED' then 0 when 'BRAND' then 1 when 'PRODUCT_WORDS' then 2 else 3 end,
           case m.sale_path when 'REFUND_ELIGIBLE' then 0 when 'NOTICE_ONLY' then 1 else 2 end,
           l.title`,
        [runId, shopId, ids],
      );
      const c = await countsOf(tx, runId);
      await tx.query(
        "update replay_runs set checked = $2, matched = $3, scope_gaps = $4, cleared = $5, not_near = $6, notice_only = $7, refund_eligible = $8 where id = $1",
        [runId, c.checked, c.matched, c.scopeGaps, c.cleared, c.notNear, c.noticeOnly, c.refundEligible],
      );
      await tx.query("delete from replay_runs where id not in (select id from replay_runs order by created_at desc, id limit $1)", [REPLAYS_KEPT]);
      return { runId };
    });
  } finally {
    await db.query("delete from shops where id = $1", [shopId]);
  }
}

/**
 * Makes a new run if the newest good one is a day old. A run that couldn't read PayPal is dropped when there is a good
 * one to keep showing, and tried again at the next call, so a PayPal outage can't replace good numbers with a partial run.
 */
export async function refreshReplay(db: Db, run: () => Promise<{ runId: string }>, now: Date): Promise<"FRESH" | "RAN" | "DISCARDED"> {
  const { rows } = await db.query<{ at: string | Date | null }>("select max(created_at) as at from replay_runs where search_complete");
  const at = rows[0]?.at;
  if (at && now.getTime() - new Date(at).getTime() < REPLAY_FRESH_MS) return "FRESH";
  const { runId } = await run();
  const dropped = await db.query(
    "delete from replay_runs r where r.id = $1 and not r.search_complete and exists (select 1 from replay_runs o where o.id <> r.id and o.search_complete) returning 1",
    [runId],
  );
  return dropped.rows.length > 0 ? "DISCARDED" : "RAN";
}

interface RunRow {
  id: string;
  ms: number;
  checked: number;
  matched: number;
  scope_gaps: number;
  cleared: number;
  not_near: number;
  notice_only: number;
  refund_eligible: number;
  unidentified: number;
  search_windows: number;
  failed_windows: number;
  search_complete: boolean;
  recalls_digest: string;
  recall_years_missing: number[];
  created_at: string | Date;
}

const storedCounts = (r: RunRow): ReplayCounts => ({
  checked: r.checked,
  matched: r.matched,
  scopeGaps: r.scope_gaps,
  cleared: r.cleared,
  notNear: r.not_near,
  noticeOnly: r.notice_only,
  refundEligible: r.refund_eligible,
});

async function readRun(db: Queryable, runId: string): Promise<RunRow | null> {
  if (!UUID.test(runId)) return null;
  const { rows } = await db.query<RunRow>("select * from replay_runs where id = $1", [runId]);
  return rows[0] ?? null;
}

export async function loadReplay(db: Queryable, runId: string): Promise<Replay | null> {
  const run = await readRun(db, runId);
  if (!run) return null;
  const { rows } = await db.query<{ recall_number: string; recall_title: string; recall_date: string; outcome: ReplayOutcome; sale_split: ReplayRow["saleSplit"]; item_title: string | null; reason: string | null }>(
    `select recall_number, recall_title, recall_date, outcome, sale_split, item_title, reason from replay_rows where run_id = $1
     order by case outcome when 'MATCH' then 0 when 'SCOPE_GAP' then 1 when 'CLEARED' then 2 else 3 end, recall_date desc, recall_number desc`,
    [runId],
  );
  return {
    runId: run.id,
    ms: run.ms,
    createdAt: new Date(run.created_at).toISOString(),
    counts: { ...storedCounts(run), unidentified: run.unidentified },
    search: { windows: run.search_windows, failedWindows: run.failed_windows, complete: run.search_complete },
    recallYearsMissing: run.recall_years_missing,
    rows: rows.map((r) => ({ recallNumber: r.recall_number, recallTitle: r.recall_title, recallDate: r.recall_date, outcome: r.outcome, saleSplit: r.sale_split, itemTitle: r.item_title, reason: r.reason })),
  };
}

export async function latestReplay(db: Queryable): Promise<{ runId: string } | null> {
  const { rows } = await db.query<{ id: string }>("select id from replay_runs order by created_at desc, id limit 1");
  return rows[0] ? { runId: rows[0].id } : null;
}

/** The newest day of recalls in the latest run, for the public API. */
export async function latestRecallDay(db: Queryable) {
  const latest = await latestReplay(db);
  if (!latest) return null;
  const { rows } = await db.query<{ recall_number: string; recall_title: string; recall_date: string; outcome: ReplayOutcome; item_title: string | null; reason: string | null }>(
    `select recall_number, recall_title, recall_date::text as recall_date, outcome, item_title, reason from replay_rows
     where run_id = $1 and recall_date = (select max(recall_date) from replay_rows where run_id = $1) order by recall_number`,
    [latest.runId],
  );
  return {
    runId: latest.runId,
    recallDate: rows[0]?.recall_date ?? null,
    recalls: rows.map((r) => ({ recallNumber: r.recall_number, recallTitle: r.recall_title, outcome: r.outcome, itemTitle: r.item_title, reason: r.reason })),
  };
}

/** Recounts the headline numbers from the run's own rows, and says whether CPSC's records are still the ones it read. */
export async function proveReplay(db: Queryable, runId: string) {
  const run = await readRun(db, runId);
  if (!run) return null;
  const recomputed = await countsOf(db, runId);
  const stored = storedCounts(run);
  const { rows } = await db.query<{ digest: string }>(`select ${DIGEST_SQL} as digest from recalls where recall_date >= $1::date`, [REPLAY_FROM]);
  return {
    runId,
    ranAt: new Date(run.created_at).toISOString(),
    stored,
    recomputed,
    agree: JSON.stringify(stored) === JSON.stringify(recomputed),
    sameRecalls: rows[0].digest === run.recalls_digest,
    ms: run.ms,
    search: { windows: run.search_windows, failedWindows: run.failed_windows, complete: run.search_complete },
    recallYearsMissing: run.recall_years_missing,
  };
}
