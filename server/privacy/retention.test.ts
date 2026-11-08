import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { testDb } from "../../test/pglite";
import { migrate } from "../db/migrate";
import { createShop } from "../import/store";
import { HEARTBEAT_TICKS, POLL_MS } from "../jobs/appJobs";
import {
  DATA_SOURCES,
  PAYPAL_PURGE_CUTOFF_HOURS,
  PAYPAL_RETENTION_HOURS,
  PAYPAL_SOURCED,
  purgePayPalData,
} from "./retention";

describe("PayPal data retention (Developer Agreement 10.1.3: 48 hours)", () => {
  let db: Awaited<ReturnType<typeof testDb>>;
  beforeEach(async () => {
    db = await testDb();
    await migrate(db);
  });
  afterEach(async () => {
    await db.close();
  });

  async function tableSources(): Promise<Record<string, string | null>> {
    const { rows } = await db.query<{ table_name: string; comment: string | null }>(
      `select c.relname as table_name, obj_description(c.oid, 'pg_class') as comment
       from pg_class c join pg_namespace n on n.oid = c.relnamespace
       where n.nspname = 'public' and c.relkind = 'r' and c.relname <> 'schema_migrations'
       order by c.relname`,
    );
    return Object.fromEntries(rows.map((r) => [r.table_name, r.comment]));
  }

  it("labels every table with where its data comes from", async () => {
    const sources = await tableSources();
    const unlabelled = Object.entries(sources).filter(([, c]) => !DATA_SOURCES.some((s) => c === `data-source: ${s}`));
    expect(unlabelled.map(([t]) => t)).toEqual([]);
  });

  it("purges exactly the tables labelled as holding PayPal data", async () => {
    const sources = await tableSources();
    const labelledPayPal = Object.entries(sources)
      .filter(([, c]) => c === "data-source: paypal")
      .map(([t]) => t)
      .sort();
    expect(PAYPAL_SOURCED.map((p) => p.table).sort()).toEqual(labelledPayPal);
    expect(labelledPayPal.length).toBeGreaterThan(0);
  });

  it("deletes rows at the 46-hour cutoff and keeps newer ones", async () => {
    expect(PAYPAL_RETENTION_HOURS).toBe(48);
    expect(PAYPAL_PURGE_CUTOFF_HOURS).toBe(46);
    const now = new Date("2026-11-10T12:00:00Z");
    const hoursAgo = (h: number) => new Date(now.getTime() - h * 3_600_000).toISOString();
    await db.query(
      `insert into paypal_webhook_events (event_id_hmac, event_type, verification_method, received_at)
       values ('old', 'T', 'self', $1), ('past-cutoff', 'T', 'self', $2), ('new', 'T', 'self', $3)`,
      [hoursAgo(49), hoursAgo(46.1), hoursAgo(45.9)],
    );
    expect(await purgePayPalData(db, now)).toEqual({ paypal_webhook_events: 2, paypal_payments: 0, paypal_calls: 0, paypal_payout_refs: 0, paypal_subscription_refs: 0, paypal_refund_refs: 0, live_catch_runs: 0, payout_statuses: 0, subscription_statuses: 0 });
    const kept = await db.query<{ event_id_hmac: string }>("select event_id_hmac from paypal_webhook_events");
    expect(kept.rows.map((r) => r.event_id_hmac)).toEqual(["new"]);
  });

  it("clears PayPal's status word from a payout at the cutoff, and keeps the shop's own record of it", async () => {
    const now = new Date("2026-11-08T12:00:00Z");
    const ago = (h: number) => new Date(now.getTime() - h * 3_600_000).toISOString();
    const shopId = await createShop(db, { name: "A shop", kind: "REAL" });
    await db.query(
      `insert into payouts (shop_id, session_id, sample_key, receiver_enc, amount_cents, currency, status, paypal_status, expires_at, updated_at)
       values ($1, 's', 'past-cutoff', 'x', 2400, 'USD', 'paid', 'SUCCESS', $4, $2), ($1, 's', 'newer', 'x', 2400, 'USD', 'paid', 'SUCCESS', $4, $3)`,
      [shopId, ago(46.1), ago(45.9), ago(-1)],
    );
    expect((await purgePayPalData(db, now)).payout_statuses).toBe(1);
    const { rows } = await db.query<{ sample_key: string; status: string; paypal_status: string | null }>("select sample_key, status, paypal_status from payouts order by sample_key");
    expect(rows).toEqual([
      { sample_key: "newer", status: "paid", paypal_status: "SUCCESS" },
      { sample_key: "past-cutoff", status: "paid", paypal_status: null },
    ]);
  });

  it("selects subscription rows with SKIP LOCKED so billing cannot block recall fetching", async () => {
    const query = vi.spyOn(db, "query");
    await purgePayPalData(db);
    const updates = query.mock.calls.filter(([sql]) => /update shop_subscriptions/i.test(sql));
    expect(updates).toHaveLength(1);
    expect(updates[0][0]).toMatch(/where shop_id in \(\s*select shop_id from shop_subscriptions\s+where \(status is not null or started_at is not null\) and updated_at < \$1::timestamptz - make_interval\(hours => \$2\)\s+for update skip locked\s*\) returning 1/i);
  });

  it("takes a live catch's seconds too: they were worked out from PayPal's capture time", async () => {
    const now = new Date("2026-11-10T12:00:00Z");
    const hoursAgo = (h: number) => new Date(now.getTime() - h * 3_600_000).toISOString();
    await db.query("insert into live_catch_runs (seconds, caught_at) values (1.5, $1), (2.5, $2)", [hoursAgo(47), hoursAgo(45)]);
    expect((await purgePayPalData(db, now)).live_catch_runs).toBe(1);
    const kept = await db.query<{ seconds: string }>("select seconds::text as seconds from live_catch_runs");
    expect(kept.rows.map((r) => r.seconds)).toEqual(["2.5"]);
  });

  it("never lets a PayPal-sourced row reach 48 hours, at any moment on the real purge schedule", async () => {
    // Walks a clock across 60 hours at the job's real interval, with rows arriving between runs.
    // An hourly purge at a 48-hour cutoff failed here: a row could live about 49 hours.
    const LIMIT_MS = PAYPAL_RETENTION_HOURS * 3_600_000;
    const PURGE_MS = POLL_MS * HEARTBEAT_TICKS;
    const t0 = Date.parse("2026-11-10T00:00:00Z");
    let arrivals = 0;
    for (let tick = t0; tick <= t0 + 60 * 3_600_000; tick += PURGE_MS) {
      const arrivedAt = new Date(tick + 1000).toISOString(); // just after a run: the longest wait
      await db.query(
        `insert into paypal_webhook_events (event_id_hmac, event_type, verification_method, received_at)
         values ($1, 'T', 'self', $2)`,
        [`row-${arrivals++}`, arrivedAt],
      );
      await purgePayPalData(db, new Date(tick));
      for (const { table, receivedAt } of PAYPAL_SOURCED) {
        const justBeforeNextRun = new Date(tick + PURGE_MS - 1).toISOString();
        const { rows } = await db.query<{ oldest_ms: string | null }>(
          `select (extract(epoch from ($1::timestamptz - min(${receivedAt}))) * 1000)::text as oldest_ms from ${table}`,
          [justBeforeNextRun],
        );
        expect(Number(rows[0].oldest_ms ?? 0), table).toBeLessThan(LIMIT_MS);
      }
    }
    expect(arrivals).toBe(61);
  });
});
