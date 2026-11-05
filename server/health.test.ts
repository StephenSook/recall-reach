import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { fetchTestCert, paypalHeaders } from "../test/paypalSigner";
import { testDb } from "../test/pglite";
import { pullRecalls } from "./cpsc/pull";
import { migrate } from "./db/migrate";
import type { Queryable } from "./db/types";
import { getHealth } from "./health";
import { handleWebhookDelivery } from "./paypal/webhookHandler";

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

  it("reports an empty but reachable database", async () => {
    const health = await getHealth(db, {});
    expect(health).toMatchObject({
      ok: true,
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
      fetchCert: fetchTestCert,
    });

    const health = await getHealth(db, { PAYPAL_WEBHOOK_ID: WEBHOOK_ID });
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
