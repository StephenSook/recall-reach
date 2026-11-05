import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { testDb } from "../../test/pglite";
import { migrate } from "../db/migrate";
import { DATA_SOURCES, PAYPAL_RETENTION_HOURS, PAYPAL_SOURCED, purgePayPalData } from "./retention";

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

  it("leaves no PayPal-sourced row older than 48 hours after a purge, and keeps newer rows", async () => {
    expect(PAYPAL_RETENTION_HOURS).toBe(48);
    const now = new Date("2026-11-10T12:00:00Z");
    const hoursAgo = (h: number) => new Date(now.getTime() - h * 3_600_000).toISOString();
    await db.query(
      `insert into paypal_webhook_events (event_id_hmac, event_type, verification_method, received_at)
       values ('old', 'T', 'self', $1), ('edge', 'T', 'self', $2), ('new', 'T', 'self', $3)`,
      [hoursAgo(49), hoursAgo(47.9), hoursAgo(1)],
    );

    const purged = await purgePayPalData(db, now);
    expect(purged).toEqual({ paypal_webhook_events: 1 });

    for (const { table, receivedAt } of PAYPAL_SOURCED) {
      const { rows } = await db.query<{ n: string }>(
        `select count(*)::text as n from ${table} where ${receivedAt} < $1::timestamptz - interval '48 hours'`,
        [now.toISOString()],
      );
      expect(Number(rows[0].n), table).toBe(0);
    }
    const kept = await db.query<{ event_id_hmac: string }>("select event_id_hmac from paypal_webhook_events order by 1");
    expect(kept.rows.map((r) => r.event_id_hmac)).toEqual(["edge", "new"]);
  });
});
