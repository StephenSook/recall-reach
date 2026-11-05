import type { Queryable } from "../db/types";

/** Labels every table must carry as its comment, as "data-source: <label>" (see migration 0005). */
export const DATA_SOURCES = ["cpsc-public", "own", "paypal", "paypal-hmac"] as const;

/** PayPal Developer Agreement 10.1.3: transaction data is deleted within 48 hours of receipt. */
export const PAYPAL_RETENTION_HOURS = 48;

/**
 * The purge deletes at 47 hours because it runs on a schedule: a row just missed by one run waits
 * for the next. Cutoff plus the 15-minute interval stays under the 48-hour limit (a test walks it).
 */
export const PAYPAL_PURGE_CUTOFF_HOURS = 47;

/**
 * Every table labelled "data-source: paypal", with the column holding when this app received the
 * row. A test fails if this list and the labels ever disagree.
 */
export const PAYPAL_SOURCED: readonly { table: string; receivedAt: string }[] = [
  { table: "paypal_webhook_events", receivedAt: "received_at" },
];

/** Deletes PayPal-sourced rows older than the cutoff at `now`. Returns rows deleted per table. */
export async function purgePayPalData(db: Queryable, now: Date = new Date()): Promise<Record<string, number>> {
  const deleted: Record<string, number> = {};
  for (const { table, receivedAt } of PAYPAL_SOURCED) {
    const { rows } = await db.query(
      `delete from ${table} where ${receivedAt} < $1::timestamptz - make_interval(hours => $2) returning 1`,
      [now.toISOString(), PAYPAL_PURGE_CUTOFF_HOURS],
    );
    deleted[table] = rows.length;
  }
  return deleted;
}
