import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fetchTestCert, paypalHeaders } from "../test/paypalSigner";
import { testDb } from "../test/pglite";
import { pullRecalls } from "./cpsc/pull";
import { migrate } from "./db/migrate";
import type { Queryable } from "./db/types";
import { getHealth } from "./health";
import { handleWebhookDelivery } from "./paypal/webhookHandler";
import { createRecordKey } from "./privacy/recordKey";

const fixtureText = readFileSync(
  new URL("../test/fixtures/cpsc/recalls_2026-10-01_to_2026-11-05.json", import.meta.url),
  "utf8",
);
const WEBHOOK_ID = "TEST-WEBHOOK-ID-SECRET-LOOKING";

describe("getHealth", () => {
  let db: Awaited<ReturnType<typeof testDb>>;
  const replayed = (at: string) =>
    db.query(
      `insert into replay_runs (ms, checked, matched, scope_gaps, cleared, not_near, notice_only, refund_eligible, unidentified, search_windows, failed_windows, search_complete, recalls_digest, created_at)
       values (1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, true, 'x', $1::timestamptz)`,
      [at],
    );
  beforeEach(async () => {
    db = await testDb();
    await migrate(db);
  });
  afterEach(async () => {
    await db.close();
  });

  it("reports an empty but reachable database, and isn't ok with nothing configured", async () => {
    const health = await getHealth(db, {});
    expect(health).toMatchObject({
      ok: false,
      checks: { database: true, webhook: false, lastPull: false, purge: true, poll: true, replay: false },
      database: { ok: true },
      cpsc: { recalls: 0, byYear: {}, lastPull: null },
      paypal: { environment: "sandbox", webhookConfigured: false, lastVerifiedWebhookAt: null },
    });
  });

  it("reports stored recalls, the last pull and the last verified webhook", async () => {
    const fetchImpl = async () =>
      new Response(fixtureText, { status: 200, headers: { "content-type": "application/json" } });
    await pullRecalls(db, { field: "RecallDate", start: "2026-10-01", end: "2026-11-05" }, {
      fetchImpl: fetchImpl as typeof fetch,
    });
    const body = Buffer.from(JSON.stringify({ id: "WH-1", event_type: "PAYMENT.CAPTURE.REFUNDED" }));
    await handleWebhookDelivery({
      rawBody: body,
      headers: paypalHeaders(body, WEBHOOK_ID),
      webhookId: WEBHOOK_ID,
      db,
      recordKey: createRecordKey("test-record-key-secret-0123456789abcdef"),
      fetchCert: fetchTestCert,
    });

    await replayed(new Date().toISOString());
    await db.query("insert into cpsc_pulls (range_field, range_start, range_end, status, finished_at) values ('LastPublishDate', '2026-11-05', '2026-11-06', 'ok', now() - interval '1 minute')");
    const health = await getHealth(db, { PAYPAL_WEBHOOK_ID: WEBHOOK_ID, RECORD_HMAC_SECRET: "r".repeat(32) });
    expect(health.ok).toBe(true);
    expect(health.cpsc).toMatchObject({
      recalls: 55,
      byYear: { 2026: 55 },
      lastPull: { status: "ok", rangeField: "RecallDate", rangeStart: "2026-10-01", rangeEnd: "2026-11-05" },
    });
    expect(health.cpsc?.lastPull?.finishedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(health.paypal.webhookConfigured).toBe(true);
    expect(health.paypal.lastVerifiedWebhookAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  describe("what ok means", () => {
    const SECRET = "r".repeat(32);
    const env = { PAYPAL_WEBHOOK_ID: WEBHOOK_ID, RECORD_HMAC_SECRET: SECRET };
    const NOW = new Date("2026-11-06T12:00:00Z");
    const pulled = (status: string, finished = "2026-11-06T11:30:00Z") =>
      db.query("insert into cpsc_pulls (range_field, range_start, range_end, status, finished_at) values ('LastPublishDate', '2026-11-05', '2026-11-06', $1, $2::timestamptz)", [status, finished]);
    const check = (poll?: Parameters<typeof getHealth>[2]) => getHealth(db, env, poll, NOW);

    it("is ok when every named check passes", async () => {
      await pulled("ok");
      await replayed("2026-11-06T02:00:00Z");
      expect(await check()).toMatchObject({ ok: true, checks: { database: true, webhook: true, lastPull: true, purge: true, poll: true, replay: true, logging: true }, replay: { lastRunAt: "2026-11-06T02:00:00.000Z" } });
    });

    describe("when only CPSC is failing", () => {
      const allElseWell = () => replayed("2026-11-06T02:00:00Z");

      it("names CPSC, when it started and the last good read, and isn't ok", async () => {
        await allElseWell();
        await pulled("ok", "2026-11-06T08:00:00Z");
        await pulled("failed", "2026-11-06T10:00:00Z");
        await pulled("failed", "2026-11-06T11:30:00Z");
        expect(await check()).toMatchObject({
          ok: false,
          degraded: { source: "CPSC", since: "2026-11-06T10:00:00.000Z", lastGoodAt: "2026-11-06T08:00:00.000Z" },
        });
      });

      it("counts an error row stored as a partial read, from before that was fixed", async () => {
        await allElseWell();
        await pulled("ok", "2026-11-06T08:00:00Z");
        await pulled("partial", "2026-11-06T11:00:00Z");
        expect((await check()).degraded?.source).toBe("CPSC");
      });

      it("counts a poll that has only just failed, using its own time", async () => {
        await allElseWell();
        await pulled("ok");
        const poll = { lastPollAt: "2026-11-06T11:45:00.000Z", lastPollOk: false, dbTouched: false };
        expect(await check(poll)).toMatchObject({ ok: false, degraded: { source: "CPSC", since: "2026-11-06T11:45:00.000Z" } });
      });

      it("isn't CPSC when our own job has stopped: the last read is simply old", async () => {
        await allElseWell();
        await pulled("ok", "2026-11-06T02:00:00Z");
        expect(await check()).toMatchObject({ ok: false, degraded: null });
      });

      it("isn't CPSC when the last failure is old too, because nothing has tried since", async () => {
        await allElseWell();
        await pulled("failed", "2026-11-06T02:00:00Z");
        expect(await check()).toMatchObject({ ok: false, degraded: null });
      });

      it("isn't only CPSC when something of ours is off as well", async () => {
        await pulled("failed");
        expect(await check()).toMatchObject({ ok: false, checks: { replay: false }, degraded: null });
      });

      it("is nothing when all is well", async () => {
        await allElseWell();
        await pulled("ok");
        expect(await check()).toMatchObject({ ok: true, degraded: null });
      });
    });

    describe("Claude's last good answer", () => {
      const allElseWell = async () => {
        await pulled("ok");
        await replayed("2026-11-06T02:00:00Z");
      };
      const answered = (at: string) => db.query("insert into claude_pings (last_ok_at) values ($1)", [at]);

      it("says when, and that it's fresh, without being part of ok", async () => {
        await allElseWell();
        await answered("2026-11-05T10:00:00Z");
        expect(await check()).toMatchObject({ ok: true, claude: { lastOkAt: "2026-11-05T10:00:00.000Z", fresh: true } });
      });

      it("goes stale after 2 days, and ok stays true", async () => {
        await allElseWell();
        await answered("2026-11-03T10:00:00Z");
        expect(await check()).toMatchObject({ ok: true, claude: { fresh: false } });
      });

      it("isn't fresh with no answer on record", async () => {
        await allElseWell();
        expect(await check()).toMatchObject({ ok: true, claude: { lastOkAt: null, fresh: false } });
      });
    });

    describe("the market search", () => {
      const swept = async (status: "ok" | "failed", at: string, recallNumber: string) => {
        const fetchImpl = async () => new Response(fixtureText, { status: 200, headers: { "content-type": "application/json" } });
        await pullRecalls(db, { field: "RecallDate", start: "2026-10-01", end: "2026-11-05" }, { fetchImpl: fetchImpl as typeof fetch });
        await db.query(
          "insert into recall_sweeps (recall_id, recall_sha256, query, status, listings, searched_at) select recall_id, raw_sha256, 'q', $1, '[]'::jsonb, $2::timestamptz from recalls where recall_number = $3",
          [status, at, recallNumber],
        );
      };
      const allElseWell = async () => {
        await pulled("ok");
        await replayed("2026-11-06T02:00:00Z");
      };

      it("says when it last worked", async () => {
        await allElseWell();
        await swept("ok", "2026-11-05T10:00:00Z", "27072");
        expect(await check()).toMatchObject({ ok: true, market: { lastOkAt: "2026-11-05T10:00:00.000Z", fresh: true } });
      });

      it("stays fresh through the wait for a 7-day refresh", async () => {
        await allElseWell();
        await swept("ok", new Date(NOW.getTime() - 7.9 * 86_400_000).toISOString(), "27072");
        expect(await check()).toMatchObject({ ok: true, market: { fresh: true } });
      });

      it("goes stale past 8 days, without calling the app down", async () => {
        await allElseWell();
        await swept("ok", new Date(NOW.getTime() - 8.1 * 86_400_000).toISOString(), "27072");
        expect(await check()).toMatchObject({ ok: true, market: { fresh: false } });
      });

      it("doesn't count a search that failed", async () => {
        await allElseWell();
        await swept("ok", new Date(NOW.getTime() - 9 * 86_400_000).toISOString(), "27072");
        await swept("failed", new Date(NOW.getTime() - 3_600_000).toISOString(), "27040");
        expect(await check()).toMatchObject({ ok: true, market: { fresh: false } });
      });

      it("doesn't call the app down when only this query fails", async () => {
        await allElseWell();
        const error = vi.spyOn(console, "error").mockImplementation(() => {});
        try {
          const flaky: Queryable = {
            exec: (sql) => db.exec(sql),
            query: async (sql: string, params?: unknown[]) => {
              if (sql.includes("recall_sweeps")) throw new Error("statement timeout");
              return db.query(sql, params) as never;
            },
          };
          expect(await getHealth(flaky, env, undefined, NOW)).toMatchObject({ ok: true, checks: { database: true }, market: { lastOkAt: null, fresh: false } });
        } finally {
          error.mockRestore();
        }
      });

      it("isn't fresh with no search yet", async () => {
        await allElseWell();
        expect(await check()).toMatchObject({ ok: true, market: { lastOkAt: null, fresh: false } });
      });
    });

    it("isn't, without the webhook id or a usable record key", async () => {
      await pulled("ok");
      expect((await getHealth(db, { RECORD_HMAC_SECRET: SECRET }, undefined, NOW)).checks?.webhook).toBe(false);
      expect((await getHealth(db, { PAYPAL_WEBHOOK_ID: WEBHOOK_ID }, undefined, NOW)).checks?.webhook).toBe(false);
      expect((await getHealth(db, { PAYPAL_WEBHOOK_ID: WEBHOOK_ID, RECORD_HMAC_SECRET: "short" }, undefined, NOW)).checks?.webhook).toBe(false);
    });

    it("isn't, when the last pull failed or is old", async () => {
      await pulled("failed");
      expect((await check()).checks?.lastPull).toBe(false);
      await pulled("ok", "2026-11-06T08:00:00Z");
      await db.query("delete from cpsc_pulls where status = 'failed'");
      expect((await check()).checks?.lastPull).toBe(false);
    });

    it("isn't, when PayPal data has outlived the purge", async () => {
      await pulled("ok");
      const shop = await db.query<{ id: string }>("insert into shops (name, kind) values ('x', 'DEMO') returning id");
      await db.query("insert into paypal_payments (shop_id, order_id, received_at) values ($1, 'O', $2::timestamptz)", [shop.rows[0].id, "2026-11-04T00:00:00Z"]);
      expect(await check()).toMatchObject({ ok: false, checks: { purge: false } });
    });

    it("isn't, when a history load finishing later hides a poll that went wrong", async () => {
      await pulled("partial", "2026-11-06T11:20:00Z");
      await db.query("insert into cpsc_pulls (range_field, range_start, range_end, status, finished_at) values ('RecallDate', '2025-01-01', '2025-12-31', 'ok', '2026-11-06T11:30:00Z')");
      expect((await check()).checks.lastPull).toBe(false);
    });

    it("isn't, on a history load alone: only the poll keeps recalls current", async () => {
      await db.query("insert into cpsc_pulls (range_field, range_start, range_end, status, finished_at) values ('RecallDate', '2025-01-01', '2025-12-31', 'ok', '2026-11-06T11:30:00Z')");
      expect((await check()).checks.lastPull).toBe(false);
    });

    it("isn't, when a demo shop has outlived the purge", async () => {
      await pulled("ok");
      await db.query("insert into shops (name, kind, created_at) values ('x', 'DEMO', $1::timestamptz)", ["2026-11-04T00:00:00Z"]);
      expect(await check()).toMatchObject({ ok: false, checks: { purge: false } });
    });

    it("isn't, when the newest Replay is two days old or there is none: a judge would find it stale", async () => {
      await pulled("ok");
      expect((await check()).checks?.replay).toBe(false);
      await replayed("2026-11-04T10:00:00Z");
      expect(await check()).toMatchObject({ ok: false, checks: { replay: false } });
    });

    it("isn't, when DEBUG is set: the toolkit's debug logger would print a capture id", async () => {
      await pulled("ok");
      await replayed("2026-11-06T02:00:00Z");
      const health = await getHealth(db, { ...env, DEBUG: "*" }, undefined, NOW);
      expect(health).toMatchObject({ ok: false, checks: { logging: false, database: true, webhook: true, lastPull: true, purge: true, poll: true, replay: true } });
      expect((await getHealth(db, { ...env, DEBUG: "" }, undefined, NOW)).checks.logging).toBe(true);
      expect((await getHealth(db, { ...env, NODE_DEBUG: "fetch" }, undefined, NOW)).checks.logging).toBe(false);
    });

    it("says so about DEBUG when the database is down too", async () => {
      const broken: Queryable = {
        query: async () => {
          throw new Error("unreachable");
        },
        exec: async () => {
          throw new Error("unreachable");
        },
      };
      expect((await getHealth(broken, { ...env, DEBUG: "*" }, undefined, NOW)).checks.logging).toBe(false);
      expect((await getHealth(broken, env, undefined, NOW)).checks.logging).toBe(true);
    });

    it("isn't, when the last poll failed", async () => {
      await pulled("ok");
      expect((await check({ lastPollAt: NOW.toISOString(), lastPollOk: false, dbTouched: true })).checks?.poll).toBe(false);
    });

    it("keeps saying when a webhook was last verified after the purge has run", async () => {
      await pulled("ok");
      const body = Buffer.from(JSON.stringify({ id: "WH-OLD", event_type: "PAYMENT.CAPTURE.REFUNDED" }));
      await handleWebhookDelivery({ rawBody: body, headers: paypalHeaders(body, WEBHOOK_ID), webhookId: WEBHOOK_ID, db, recordKey: createRecordKey(SECRET), fetchCert: fetchTestCert });
      await db.query("delete from paypal_webhook_events");
      expect((await check()).paypal.lastVerifiedWebhookAt).toMatch(/^\d{4}-/);
    });
  });

  it("reports the in-memory recall poll, including when the database is unreachable", async () => {
    const poll = { lastPollAt: "2026-11-05T22:00:00.000Z", lastPollOk: true, dbTouched: false };
    expect((await getHealth(db, {}, poll)).poll).toEqual(poll);
    const broken: Queryable = {
      query: async () => {
        throw new Error("down");
      },
      exec: async () => {},
    };
    expect((await getHealth(broken, {}, poll)).poll).toEqual(poll);
  });

  it("never includes the webhook id itself", async () => {
    const health = await getHealth(db, { PAYPAL_WEBHOOK_ID: WEBHOOK_ID });
    expect(JSON.stringify(health)).not.toContain(WEBHOOK_ID);
  });

  it("reports not ok, without the database error text, when the database is unreachable", async () => {
    const broken: Queryable = {
      query: async () => {
        throw new Error("connect ECONNREFUSED db.internal.example:5432");
      },
      exec: async () => {
        throw new Error("unreachable");
      },
    };
    const health = await getHealth(broken, {});
    expect(health).toMatchObject({ ok: false, database: { ok: false }, cpsc: null });
    expect(JSON.stringify(health)).not.toContain("ECONNREFUSED");
  });
});
