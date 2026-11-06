import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
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
      checks: { database: true, webhook: false, lastPull: false, purge: true, poll: true },
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
      expect(await check()).toMatchObject({ ok: true, checks: { database: true, webhook: true, lastPull: true, purge: true, poll: true } });
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
