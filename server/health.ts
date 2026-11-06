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
  env: { PAYPAL_WEBHOOK_ID?: string; RECORD_HMAC_SECRET?: string; DEBUG?: string; NODE_DEBUG?: string },
  poll: RecallPollStatus = { lastPollAt: null, lastPollOk: null, dbTouched: null },
  now: Date = new Date(),
): Promise<Health> {
  const checkedAt = now.toISOString();
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
    const lastPoll = await db.query<{ status: string; finished_at: unknown }>(
      "select status, finished_at from cpsc_pulls where status <> 'running' and range_field = 'LastPublishDate' order by finished_at desc limit 1",
    );
    const polledAt = iso(lastPoll.rows[0]?.finished_at);
    const replay = await db.query<{ at: unknown }>("select max(created_at) as at from replay_runs");
    const lastRunAt = iso(replay.rows[0]?.at);
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
    return {
      ok: Object.values(checks).every(Boolean),
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
      paypal: { ...paypalBase, lastVerifiedWebhookAt: iso(webhook.rows[0]?.at) },
    };
  } catch (err) {
    console.error("health check: database query failed:", err instanceof Error ? err.message : err);
    return {
      ok: false,
      checkedAt,
      checks: { database: false, webhook: webhookOk, lastPull: false, purge: false, poll: pollOk, replay: false, logging: loggingOk },
      database: { ok: false },
      cpsc: null,
      poll,
      replay: { lastRunAt: null },
      paypal: { ...paypalBase, lastVerifiedWebhookAt: null },
    };
  }
}
