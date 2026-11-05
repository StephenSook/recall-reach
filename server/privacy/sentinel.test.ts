import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fetchTestCert, paypalHeaders } from "../../test/paypalSigner";
import { testDb } from "../../test/pglite";
import { migrate } from "../db/migrate";
import { handleWebhookDelivery } from "../paypal/webhookHandler";
import { appJobs } from "../jobs/appJobs";
import { createRecordKey } from "./recordKey";

// Recognizable PayPal values, one per kind of data PayPal returns.
const SENTINELS = {
  eventId: "WH-SENTINEL-EVENT",
  captureId: "SENTINEL-CAPTURE-ID",
  orderId: "SENTINEL-ORDER-ID",
  invoice: "SENTINEL-INVOICE",
  payerEmail: "sentinel-buyer@example.com",
  payerName: "Sentinelgiven",
  amount: "8675.30",
  item: "Sentinel Item Name",
  created: "2026-11-05T21:00:00Z",
};
const event = {
  id: SENTINELS.eventId,
  event_type: "PAYMENT.CAPTURE.COMPLETED",
  create_time: SENTINELS.created,
  resource_type: "capture",
  resource: {
    id: SENTINELS.captureId,
    invoice_id: SENTINELS.invoice,
    amount: { currency_code: "USD", value: SENTINELS.amount },
    supplementary_data: { related_ids: { order_id: SENTINELS.orderId } },
    items: [{ name: SENTINELS.item }],
  },
  payer: { email_address: SENTINELS.payerEmail, name: { given_name: SENTINELS.payerName } },
};

describe("PayPal values never reach logs", () => {
  let db: Awaited<ReturnType<typeof testDb>>;
  const lines: string[] = [];
  beforeEach(async () => {
    db = await testDb();
    await migrate(db);
    lines.length = 0;
    for (const level of ["log", "info", "warn", "error", "debug"] as const) {
      vi.spyOn(console, level).mockImplementation((...args: unknown[]) => {
        lines.push(args.map(String).join(" "));
      });
    }
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await db.close();
  });

  it("logs none of them on an accepted delivery, a forged one, a replay or a purge", async () => {
    const webhookId = "TEST-WEBHOOK-ID";
    const deliver = (raw: Buffer, headers: Headers) =>
      handleWebhookDelivery({
        rawBody: raw,
        headers,
        webhookId,
        db,
        recordKey: createRecordKey("test-record-key-secret-0123456789abcdef"),
        fetchCert: fetchTestCert,
      });
    const body = Buffer.from(JSON.stringify(event));
    expect((await deliver(body, paypalHeaders(body, webhookId, "t-1"))).status).toBe(200);

    const forged = Buffer.from(JSON.stringify({ ...event, id: "WH-FORGED" }));
    expect((await deliver(forged, paypalHeaders(body, webhookId, "t-2"))).status).toBe(401);

    const replay = Buffer.from(JSON.stringify({ ...event, id: "WH-REPLAY" }));
    expect((await deliver(replay, paypalHeaders(replay, webhookId, "t-1"))).status).toBe(401);

    const cpsc = (async () => new Response("[]", { status: 200 })) as unknown as typeof fetch;
    await appJobs(db, { fetchImpl: cpsc })[0].run(); // the first tick is a heartbeat, which purges

    expect(lines.length).toBeGreaterThanOrEqual(4); // the logging path really ran
    const everything = lines.join("\n");
    for (const [kind, value] of Object.entries(SENTINELS)) {
      expect(everything, kind).not.toContain(value);
    }
  });
});
