import { lastClaudeAnswer } from "./agent/claude";
import { lastWarningRead, warningCount } from "./warnings/warnings";
import { recallCountsByYear } from "./cpsc/load";
import type { Queryable } from "./db/types";
import type { RecallPollStatus } from "./jobs/appJobs";
import { createRecordKey } from "./privacy/recordKey";
import { PAYPAL_RETENTION_HOURS, PAYPAL_SOURCED } from "./privacy/retention";

const PAST_THE_RULE = "$1::timestamptz - make_interval(hours => $2)";
const OVERDUE = [
  ...PAYPAL_SOURCED.map(({ table, receivedAt }) => `exists (select 1 from ${table} where ${receivedAt} < ${PAST_THE_RULE})`),
  // A demo shop is built from PayPal's answers, so it goes by the same rule.
  `exists (select 1 from shops where kind = 'DEMO' and created_at < ${PAST_THE_RULE})`,
].join(" or ");

export interface Health {
  ok: boolean;
  checkedAt: string;
  /** The commit this answer came from, as Render reports it. Null when not on Render. */
  build: string | null;
  /** What ok is made of. It is true only when every one of these is. */
  checks: {
    database: boolean;
    /** The webhook id is set and the record key works, so a delivery can be verified and recorded. */
    webhook: boolean;
    /** The last finished poll of CPSC worked and isn't old: the heartbeat writes one hourly. A history load says nothing about it. */
    lastPull: boolean;
    /** No PayPal row or demo shop has outlived the 48-hour rule, so the purge is running. */
    purge: boolean;
    /** The background poll's last run didn't fail. */
    poll: boolean;
    /** Replay has a run from the last two days: the hourly job keeps one from the last day. */
    replay: boolean;
    /** DEBUG and NODE_DEBUG are unset. With them set, libraries can print PayPal's URLs, ids included, and logs outlive the 48-hour rule. */
    logging: boolean;
  };
  database: { ok: boolean };
  cpsc: {
    recalls: number;
    byYear: Record<number, number>;
    lastPull: {
      id: number;
      status: string;
      rangeField: string;
      rangeStart: string;
      rangeEnd: string;
      finishedAt: string;
    } | null;
  } | null;
  /** The background poll's last run, held in memory: a quiet poll never touches the database. */
  poll: RecallPollStatus;
  replay: { lastRunAt: string | null };
  /**
   * The search of the wider market (Channel3). Not part of ok: it feeds one side page, whose rows carry their own dates,
   * and a free tier going quiet is not the app being down.
   */
  market: { lastOkAt: string | null; fresh: boolean };
  /**
   * Set when CPSC is the only thing failing. ok stays false, because recalls aren't arriving, but this site still works from
   * the recalls it holds, so /api/health answers 200 and names CPSC. An old read with no failure is our job stopping, so it isn't this.
   */
  degraded: { source: "CPSC"; since: string | null; lastGoodAt: string | null } | null;
  /** CPSC's warnings file, apart from recalls. Not part of ok. Fresh means read in the last 8 days: CPSC updates it weekly. */
  warnings: { count: number; lastOkAt: string | null; fresh: boolean };
  /** Claude's last good answer. Not part of ok: everything else works without it. The probe fails on it, so nobody finds out from a judge. */
  claude: { lastOkAt: string | null; fresh: boolean };
  paypal: {
    /** Webhook certificates are accepted only from PayPal sandbox hosts (server/paypal/webhooks.ts). */
    environment: "sandbox";
    webhookConfigured: boolean;
    lastVerifiedWebhookAt: string | null;
  };
}

/** Two hourly heartbeats and a margin. */
const MAX_PULL_AGE_MS = 2.5 * 3_600_000;
const MAX_REPLAY_AGE_MS = 48 * 3_600_000;
/** Each recall is searched again after 7 days and nothing is due until then, so a healthy search can go quiet for most of a week. */
const MAX_MARKET_AGE_MS = 8 * 86_400_000;
const MAX_CLAUDE_AGE_MS = 2 * 86_400_000;
const MAX_WARNINGS_AGE_MS = 8 * 86_400_000;

/** Its own try, so this query failing can't call the rest of the app down. */
async function lastClaudeAnswerOrNull(db: Queryable): Promise<string | null> {
  try {
    return await lastClaudeAnswer(db);
  } catch (err) {
    console.error("health check: Claude query failed:", err instanceof Error ? err.message : err);
    return null;
  }
}

async function lastMarketSearch(db: Queryable): Promise<string | null> {
  try {
    const { rows } = await db.query<{ at: unknown }>("select max(searched_at) as at from recall_sweeps where status = 'ok'");
    return iso(rows[0]?.at);
  } catch (err) {
    console.error("health check: market query failed:", err instanceof Error ? err.message : err);
    return null;
  }
}

function recordKeyWorks(secret: string | undefined): boolean {
  if (!secret) return false;
  try {
    createRecordKey(secret);
    return true;
  } catch {
    return false;
  }
}

const iso = (value: unknown): string | null =>
  value instanceof Date ? value.toISOString() : typeof value === "string" ? new Date(value).toISOString() : null;

/** Public status for /api/health. Never includes secrets or database error text. */
export async function getHealth(
  db: Queryable,
  env: { PAYPAL_WEBHOOK_ID?: string; RECORD_HMAC_SECRET?: string; DEBUG?: string; NODE_DEBUG?: string; RENDER_GIT_COMMIT?: string },
  poll: RecallPollStatus = { lastPollAt: null, lastPollOk: null, dbTouched: null },
  now: Date = new Date(),
): Promise<Health> {
  const checkedAt = now.toISOString();
  const build = env.RENDER_GIT_COMMIT?.slice(0, 7) || null;
  const webhookOk = Boolean(env.PAYPAL_WEBHOOK_ID) && recordKeyWorks(env.RECORD_HMAC_SECRET);
  const pollOk = poll.lastPollOk !== false;
  const loggingOk = !env.DEBUG && !env.NODE_DEBUG;
  const paypalBase = { environment: "sandbox" as const, webhookConfigured: webhookOk };
  try {
    const byYear = await recallCountsByYear(db);
    const pulls = await db.query<Record<string, unknown>>(
      `select id, status, range_field, range_start, range_end, finished_at
       from cpsc_pulls where status <> 'running' order by finished_at desc limit 1`,
    );
    // The purge takes the event rows, so this table is what remembers when one was last verified.
    const webhook = await db.query<{ at: unknown }>("select max(received_at) as at from paypal_webhook_transmissions");
    const overdue = await db.query<{ any: boolean }>(
      `select ${OVERDUE} as any`,
      [checkedAt, PAYPAL_RETENTION_HOURS],
    );
    const lastPoll = await db.query<{ status: string; finished_at: unknown; error: string | null }>(
      "select status, finished_at, error from cpsc_pulls where status <> 'running' and range_field = 'LastPublishDate' order by finished_at desc limit 1",
    );
    const polledAt = iso(lastPoll.rows[0]?.finished_at);
    const outage = await db.query<{ last_good: unknown; since: unknown }>(
      `with good as (select max(finished_at) as at from cpsc_pulls where range_field = 'LastPublishDate' and status = 'ok')
       select (select at from good) as last_good,
              (select min(finished_at) from cpsc_pulls where range_field = 'LastPublishDate' and status not in ('ok', 'running')
               and finished_at > coalesce((select at from good), '-infinity'::timestamptz)) as since`,
    );
    const replay = await db.query<{ at: unknown }>("select max(created_at) as at from replay_runs");
    const lastRunAt = iso(replay.rows[0]?.at);
    const marketOkAt = await lastMarketSearch(db);
    const claudeOkAt = await lastClaudeAnswerOrNull(db);
    const warningsRead = { count: await warningCount(db), lastOkAt: await lastWarningRead(db) };
    const p = pulls.rows[0];
    const pulledAt = p ? iso(p.finished_at) : null;
    const checks = {
      database: true,
      webhook: webhookOk,
      lastPull: lastPoll.rows[0]?.status === "ok" && polledAt !== null && now.getTime() - Date.parse(polledAt) <= MAX_PULL_AGE_MS,
      purge: !overdue.rows[0]?.any,
      poll: pollOk,
      replay: lastRunAt !== null && now.getTime() - Date.parse(lastRunAt) <= MAX_REPLAY_AGE_MS,
      logging: loggingOk,
    };
    const recent = (at: string | null) => at !== null && now.getTime() - Date.parse(at) <= MAX_PULL_AGE_MS;
    const lastStatus = lastPoll.rows[0]?.status;
    // A failed row can be our own write failing after CPSC answered. Only CPSC's own errors, which all say so, count as CPSC.
    const cpscSaidSo = lastStatus === "partial" || (lastStatus === "failed" && lastPoll.rows[0]?.error?.startsWith("CPSC ") === true);
    const cpscFailing = (poll.lastPollOk === false && recent(poll.lastPollAt)) || (cpscSaidSo && recent(polledAt));
    const oursOff = Object.entries(checks).some(([name, on]) => !on && name !== "lastPull" && name !== "poll");
    const allOk = Object.values(checks).every(Boolean);
    return {
      ok: allOk,
      build,
      degraded: !allOk && cpscFailing && !oursOff ? { source: "CPSC", since: iso(outage.rows[0]?.since) ?? poll.lastPollAt, lastGoodAt: iso(outage.rows[0]?.last_good) } : null,
      checkedAt,
      checks,
      database: { ok: true },
      cpsc: {
        recalls: Object.values(byYear).reduce((a, b) => a + b, 0),
        byYear,
        lastPull: p
          ? {
              id: Number(p.id),
              status: String(p.status),
              rangeField: String(p.range_field),
              rangeStart: String(p.range_start),
              rangeEnd: String(p.range_end),
              finishedAt: pulledAt ?? "",
            }
          : null,
      },
      poll,
      replay: { lastRunAt },
      market: { lastOkAt: marketOkAt, fresh: marketOkAt !== null && now.getTime() - Date.parse(marketOkAt) <= MAX_MARKET_AGE_MS },
      claude: { lastOkAt: claudeOkAt, fresh: claudeOkAt !== null && now.getTime() - Date.parse(claudeOkAt) <= MAX_CLAUDE_AGE_MS },
      warnings: { ...warningsRead, fresh: warningsRead.lastOkAt !== null && now.getTime() - Date.parse(warningsRead.lastOkAt) <= MAX_WARNINGS_AGE_MS },
      paypal: { ...paypalBase, lastVerifiedWebhookAt: iso(webhook.rows[0]?.at) },
    };
  } catch (err) {
    console.error("health check: database query failed:", err instanceof Error ? err.message : err);
    return {
      ok: false,
      build,
      degraded: null,
      checkedAt,
      checks: { database: false, webhook: webhookOk, lastPull: false, purge: false, poll: pollOk, replay: false, logging: loggingOk },
      database: { ok: false },
      cpsc: null,
      poll,
      replay: { lastRunAt: null },
      market: { lastOkAt: null, fresh: false },
      claude: { lastOkAt: null, fresh: false },
      warnings: { count: 0, lastOkAt: null, fresh: false },
      paypal: { ...paypalBase, lastVerifiedWebhookAt: null },
    };
  }
}
