import { recallCountsByYear } from "./cpsc/load";
import type { Queryable } from "./db/types";
import type { RecallPollStatus } from "./jobs/appJobs";

export interface Health {
  ok: boolean;
  checkedAt: string;
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
  paypal: {
    /** Webhook certificates are accepted only from PayPal sandbox hosts (server/paypal/webhooks.ts). */
    environment: "sandbox";
    webhookConfigured: boolean;
    lastVerifiedWebhookAt: string | null;
  };
}

const iso = (value: unknown): string | null =>
  value instanceof Date ? value.toISOString() : typeof value === "string" ? new Date(value).toISOString() : null;

/** Public status for /api/health. Never includes secrets or database error text. */
export async function getHealth(
  db: Queryable,
  env: { PAYPAL_WEBHOOK_ID?: string },
  poll: RecallPollStatus = { lastPollAt: null, lastPollOk: null, dbTouched: null },
): Promise<Health> {
  const checkedAt = new Date().toISOString();
  const paypalBase = { environment: "sandbox" as const, webhookConfigured: Boolean(env.PAYPAL_WEBHOOK_ID) };
  try {
    const byYear = await recallCountsByYear(db);
    const pulls = await db.query<Record<string, unknown>>(
      `select id, status, range_field, range_start, range_end, finished_at
       from cpsc_pulls where status <> 'running' order by finished_at desc limit 1`,
    );
    const webhook = await db.query<{ at: unknown }>("select max(received_at) as at from paypal_webhook_events");
    const p = pulls.rows[0];
    return {
      ok: true,
      checkedAt,
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
              finishedAt: iso(p.finished_at) ?? "",
            }
          : null,
      },
      poll,
      paypal: { ...paypalBase, lastVerifiedWebhookAt: iso(webhook.rows[0]?.at) },
    };
  } catch (err) {
    console.error("health check: database query failed:", err instanceof Error ? err.message : err);
    return {
      ok: false,
      checkedAt,
      database: { ok: false },
      cpsc: null,
      poll,
      paypal: { ...paypalBase, lastVerifiedWebhookAt: null },
    };
  }
}
