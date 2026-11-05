import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fetchTestCert, paypalHeaders } from "../../test/paypalSigner";
import { testDb } from "../../test/pglite";
import { migrate } from "../db/migrate";
import { handleWebhookDelivery } from "./webhookHandler";

const WEBHOOK_ID = "TEST-WEBHOOK-ID";
const event = {
  id: "WH-TEST-1",
  event_type: "PAYMENT.CAPTURE.REFUNDED",
  create_time: "2026-11-05T20:00:01.000Z",
  resource_type: "refund",
  resource: { id: "TEST-REFUND-1", status: "COMPLETED" },
};
const body = Buffer.from(JSON.stringify(event));

describe("handleWebhookDelivery", () => {
  let db: Awaited<ReturnType<typeof testDb>>;
  beforeEach(async () => {
    db = await testDb();
    await migrate(db);
  });
  afterEach(async () => {
    await db.close();
  });

  const deliver = (raw: Uint8Array, headers: Headers, webhookId: string | undefined = WEBHOOK_ID) =>
    handleWebhookDelivery({ rawBody: raw, headers, webhookId, db, fetchCert: fetchTestCert });
  const rows = async () =>
    (await db.query<Record<string, unknown>>("select * from paypal_webhook_events order by event_id")).rows;

  it("logs each accepted delivery's event, transmission id and transmission time", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    try {
      await deliver(body, paypalHeaders(body, WEBHOOK_ID, "transmission-1"));
      await deliver(body, paypalHeaders(body, WEBHOOK_ID, "transmission-2"));
      const lines = info.mock.calls.map((c) => String(c[0]));
      expect(lines).toEqual([
        "PayPal webhook accepted: event=WH-TEST-1 type=PAYMENT.CAPTURE.REFUNDED transmission=transmission-1 transmission_time=2026-11-05T20:00:00Z duplicate=false",
        "PayPal webhook accepted: event=WH-TEST-1 type=PAYMENT.CAPTURE.REFUNDED transmission=transmission-2 transmission_time=2026-11-05T20:00:00Z duplicate=true",
      ]);
    } finally {
      info.mockRestore();
    }
  });

  it("stores a verified event and answers 200", async () => {
    const res = await deliver(body, paypalHeaders(body, WEBHOOK_ID));
    expect(res).toEqual({ status: 200, body: { received: true, duplicate: false } });
    expect(await rows()).toMatchObject([
      {
        event_id: "WH-TEST-1",
        event_type: "PAYMENT.CAPTURE.REFUNDED",
        resource_type: "refund",
        verification_method: "self",
      },
    ]);
  });

  it("acknowledges a repeat delivery as a duplicate and keeps one row", async () => {
    await deliver(body, paypalHeaders(body, WEBHOOK_ID));
    const res = await deliver(body, paypalHeaders(body, WEBHOOK_ID));
    expect(res).toEqual({ status: 200, body: { received: true, duplicate: true } });
    expect(await rows()).toHaveLength(1);
  });

  it("treats a retry of the same event in a new transmission as a duplicate", async () => {
    await deliver(body, paypalHeaders(body, WEBHOOK_ID, "transmission-1"));
    const res = await deliver(body, paypalHeaders(body, WEBHOOK_ID, "transmission-2"));
    expect(res).toEqual({ status: 200, body: { received: true, duplicate: true } });
    expect(await rows()).toHaveLength(1);
  });

  it("refuses a transmission id reused for a different event (CRC32 replay)", async () => {
    // PayPal signs only a CRC32 of the body, so a captured transmission could be re-sent with a
    // crafted body whose CRC matches. Signing the second body under the same transmission id
    // stands in for that collision.
    await deliver(body, paypalHeaders(body, WEBHOOK_ID, "transmission-1"));
    const other = Buffer.from(JSON.stringify({ ...event, id: "WH-REPLAYED", event_type: "PAYMENT.CAPTURE.COMPLETED" }));
    const res = await deliver(other, paypalHeaders(other, WEBHOOK_ID, "transmission-1"));
    expect(res.status).toBe(401);
    expect((await rows()).map((r) => r.event_id)).toEqual(["WH-TEST-1"]);
  });

  it("answers 401 to a forged delivery and stores nothing", async () => {
    const forged = Buffer.from(JSON.stringify({ ...event, id: "WH-FORGED" }));
    const res = await deliver(forged, paypalHeaders(body, WEBHOOK_ID));
    expect(res.status).toBe(401);
    expect(await rows()).toEqual([]);
  });

  it("answers 503 without verifying when no webhook id is configured", async () => {
    let certFetches = 0;
    const res = await handleWebhookDelivery({
      rawBody: body,
      headers: paypalHeaders(body, WEBHOOK_ID),
      webhookId: undefined,
      db,
      fetchCert: async () => {
        certFetches++;
        return fetchTestCert();
      },
    });
    expect(res.status).toBe(503);
    expect(certFetches).toBe(0);
    expect(await rows()).toEqual([]);
  });

  it("refuses a body over 1 MB with 413", async () => {
    const huge = Buffer.alloc(1_048_577, 0x20);
    const res = await deliver(huge, paypalHeaders(huge, WEBHOOK_ID));
    expect(res.status).toBe(413);
  });

  it("keeps only a hash of the PayPal resource id", async () => {
    await deliver(body, paypalHeaders(body, WEBHOOK_ID));
    const [row] = await rows();
    expect(row.resource_id_sha256).toBe(createHash("sha256").update("TEST-REFUND-1").digest("hex"));
    expect(JSON.stringify(row)).not.toContain("TEST-REFUND-1");
  });
});
