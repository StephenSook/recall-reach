import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fetchTestCert, paypalHeaders } from "../../test/paypalSigner";
import { testDb } from "../../test/pglite";
import { migrate } from "../db/migrate";
import { createRecordKey } from "../privacy/recordKey";
import { purgePayPalData } from "../privacy/retention";
import type { PayPalClient } from "./client";
import { readPayoutBatch, recordPayoutItemEvent } from "./payouts";
import { handleWebhookDelivery } from "./webhookHandler";

const WEBHOOK_ID = "TEST-WEBHOOK-ID";
const key = createRecordKey("test-record-key-secret-0123456789abcdef");
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
    handleWebhookDelivery({ rawBody: raw, headers, webhookId, db, recordKey: key, fetchCert: fetchTestCert });
  const rows = async () =>
    (await db.query<Record<string, unknown>>("select * from paypal_webhook_events order by event_id_hmac")).rows;

  describe("a payment past the refund window", () => {
    const item = (status: string) => Buffer.from(JSON.stringify({ id: `WH-P-${status}`, event_type: `PAYMENT.PAYOUTS-ITEM.${status}`, resource_type: "payouts_item", create_time: "2026-11-07T12:00:00.000Z", resource: { payout_batch_id: "BATCH-1", transaction_status: status } }));
    const statusNow = async () => (await db.query<{ status: string }>("select status from payouts")).rows[0].status;
    beforeEach(async () => {
      const { rows: shop } = await db.query<{ id: string }>("insert into shops (name, kind) values ('DEMO', 'DEMO') returning id");
      await db.query(
        `insert into payouts (shop_id, session_id, sample_key, receiver_enc, amount_cents, currency, status, batch_ref_hmac, expires_at)
         values ($1, 's', 'k', 'x', 100, 'USD', 'unconfirmed', $2, now())`,
        [shop[0].id, key("paypal-resource", "BATCH-1")],
      );
    });

    const deliverItem = (raw: Uint8Array, headers: Headers, onPayoutItem?: (resource: unknown, recordKey: typeof key) => Promise<unknown>) =>
      handleWebhookDelivery({ rawBody: raw, headers, webhookId: WEBHOOK_ID, db, recordKey: key, fetchCert: fetchTestCert, onPayoutItem });

    it("passes a verified item event on, with the record key, and never acts on its body itself", async () => {
      const raw = item("SUCCESS");
      const passed = vi.fn(async () => undefined);
      expect((await deliverItem(raw, paypalHeaders(raw, WEBHOOK_ID), passed)).status).toBe(200);
      expect(passed).toHaveBeenCalledWith({ payout_batch_id: "BATCH-1", transaction_status: "SUCCESS" }, key);
      expect(await statusNow()).toBe("unconfirmed");
      const again = item("FAILED");
      expect((await deliverItem(again, paypalHeaders(again, WEBHOOK_ID, "t-2"))).status).toBe(200);
      expect(await statusNow()).toBe("unconfirmed");
    });

    it("fails a delivery whose batch read names no status yet, and PayPal's redelivery settles it", async () => {
      const approval = (await db.query<{ request_id: string }>("select request_id from payouts")).rows[0].request_id;
      const answers: (string | null)[] = [null, "SUCCESS"];
      const onPayoutItem = (resource: unknown, k: typeof key) =>
        recordPayoutItemEvent(db, k, resource as never, async () => ({ status: answers.shift() ?? null, batchStatus: null, senderBatchId: approval, senderItemId: approval }));
      const raw = item("SUCCESS");
      await expect(deliverItem(raw, paypalHeaders(raw, WEBHOOK_ID), onPayoutItem)).rejects.toThrow(/no status/);
      expect(await statusNow()).toBe("unconfirmed");
      expect((await deliverItem(raw, paypalHeaders(raw, WEBHOOK_ID), onPayoutItem)).status).toBe(200);
      expect(await statusNow()).toBe("paid");
    });

    it.each([
      ["a batch it already knows", true],
      ["a send whose answer was lost, found by the approval the item carries", false],
    ])("fails a delivery while PayPal's batch read lists no item yet, and the redelivery settles it: %s", async (_about, known) => {
      const approval = (await db.query<{ request_id: string }>("select request_id from payouts")).rows[0].request_id;
      if (!known) await db.query("update payouts set batch_ref_hmac = null");
      const header = { sender_batch_header: { sender_batch_id: approval } };
      const pages = [{ batch_header: header, items: [] }, { batch_header: header, items: [{ transaction_status: "SUCCESS", payout_item: { sender_item_id: approval } }] }];
      const client = { request: async () => ({ status: 200, data: pages.shift() }) } as unknown as PayPalClient;
      const onPayoutItem = (resource: unknown, k: typeof key) => recordPayoutItemEvent(db, k, resource as never, readPayoutBatch(client));
      const raw = Buffer.from(
        JSON.stringify({ id: "WH-P-LOST", event_type: "PAYMENT.PAYOUTS-ITEM.SUCCEEDED", resource_type: "payouts_item", create_time: "2026-11-07T12:00:00.000Z", resource: { payout_batch_id: "BATCH-1", transaction_status: "SUCCESS", payout_item: { sender_item_id: approval } } }),
      );
      await expect(deliverItem(raw, paypalHeaders(raw, WEBHOOK_ID), onPayoutItem)).rejects.toThrow(/no status/);
      expect(await statusNow()).toBe("unconfirmed");
      expect((await deliverItem(raw, paypalHeaders(raw, WEBHOOK_ID), onPayoutItem)).status).toBe(200);
      expect(await statusNow()).toBe("paid");
      // A lost send learns its batch here, so the owner can read it back later. A known batch already has its refs from the send.
      if (!known) expect((await db.query<{ batch_id: string }>("select batch_id from paypal_payout_refs")).rows).toEqual([{ batch_id: "BATCH-1" }]);
    });

    it("ignores one whose signature fails", async () => {
      const passed = vi.fn(async () => undefined);
      const res = await deliverItem(item("SUCCESS"), paypalHeaders(item("FAILED"), WEBHOOK_ID), passed);
      expect(res.status).toBe(401);
      expect(passed).not.toHaveBeenCalled();
      expect(await statusNow()).toBe("unconfirmed");
    });
  });

  describe("a completed capture", () => {
    const event = (type: string, id = "WH-CAPTURE-1") => new TextEncoder().encode(JSON.stringify({ id, event_type: type, resource_type: "capture", create_time: "2026-11-06T14:59:50Z", resource: { id: "CAPTURE-1" } }));
    const send = (raw: Uint8Array, onCaptureCompleted: (id: string) => Promise<unknown>, transmission = "t-1") =>
      handleWebhookDelivery({ rawBody: raw, headers: paypalHeaders(raw, WEBHOOK_ID, transmission), webhookId: WEBHOOK_ID, db, recordKey: key, fetchCert: fetchTestCert, onCaptureCompleted });

    it("is passed on, by capture id, after it is verified and recorded", async () => {
      const seen = vi.fn(async () => (await rows()).length);
      expect((await send(event("PAYMENT.CAPTURE.COMPLETED"), seen)).status).toBe(200);
      expect(seen).toHaveBeenCalledWith("CAPTURE-1");
      await expect(seen.mock.results[0].value).resolves.toBe(1);
    });

    it("is not passed on when the signature fails", async () => {
      const seen = vi.fn(async () => undefined);
      const raw = event("PAYMENT.CAPTURE.COMPLETED");
      const res = await handleWebhookDelivery({ rawBody: raw, headers: paypalHeaders(event("PAYMENT.CAPTURE.DENIED"), WEBHOOK_ID), webhookId: WEBHOOK_ID, db, recordKey: key, fetchCert: fetchTestCert, onCaptureCompleted: seen });
      expect(res.status).toBe(401);
      expect(seen).not.toHaveBeenCalled();
    });

    it.each(["PAYMENT.CAPTURE.REFUNDED", "PAYMENT.CAPTURE.DENIED", "PAYMENT.CAPTURE.REVERSED"])("%s is not passed on", async (type) => {
      const seen = vi.fn(async () => undefined);
      await send(event(type), seen);
      expect(seen).not.toHaveBeenCalled();
    });

    it("is passed on again when PayPal delivers it again, so a failed attempt gets another try", async () => {
      const seen = vi.fn(async () => undefined);
      await send(event("PAYMENT.CAPTURE.COMPLETED"), seen, "t-1");
      await send(event("PAYMENT.CAPTURE.COMPLETED"), seen, "t-2");
      expect(seen).toHaveBeenCalledTimes(2);
    });

    it("fails the delivery if acting on it fails, so PayPal tries again", async () => {
      await expect(send(event("PAYMENT.CAPTURE.COMPLETED"), async () => Promise.reject(new Error("PayPal down")))).rejects.toThrow("PayPal down");
    });
  });

  describe("an event through the platform app, for a connected shop", () => {
    const PLATFORM_ID = "TEST-PLATFORM-WEBHOOK-ID";
    const raw = (type: string, resource: Record<string, unknown>, id = "WH-PLATFORM-1") => new TextEncoder().encode(JSON.stringify({ id, event_type: type, resource_type: "x", create_time: "2026-11-08T15:00:00Z", resource }));
    const send = (bytes: Uint8Array, signedFor: string, extra: Partial<Parameters<typeof handleWebhookDelivery>[0]> = {}) =>
      handleWebhookDelivery({ rawBody: bytes, headers: paypalHeaders(bytes, signedFor), webhookId: WEBHOOK_ID, db, recordKey: key, fetchCert: fetchTestCert, ...extra });

    it("is verified under the platform's webhook id when the demo's doesn't match, and recorded once", async () => {
      const bytes = raw("PAYMENT.CAPTURE.REFUNDED", { id: "R-P-1", status: "COMPLETED" });
      expect((await send(bytes, PLATFORM_ID)).status).toBe(401);
      expect((await send(bytes, PLATFORM_ID, { platform: { webhookId: PLATFORM_ID } })).status).toBe(200);
      expect(await rows()).toHaveLength(1);
    });

    it("keeps a connected shop's completed capture away from the demo's live catch", async () => {
      const seen = vi.fn(async () => undefined);
      const bytes = raw("PAYMENT.CAPTURE.COMPLETED", { id: "CAPTURE-SELLER-1" });
      expect((await send(bytes, PLATFORM_ID, { onCaptureCompleted: seen, platform: { webhookId: PLATFORM_ID } })).status).toBe(200);
      expect(seen).not.toHaveBeenCalled();
    });

    it("forgets the seller when PayPal says it took its consent back", async () => {
      const revoked = vi.fn(async () => undefined);
      const bytes = raw("MERCHANT.PARTNER-CONSENT.REVOKED", { merchant_id: "SELLERPAYER1" });
      await send(bytes, PLATFORM_ID, { platform: { webhookId: PLATFORM_ID, onConsentRevoked: revoked } });
      expect(revoked).toHaveBeenCalledWith("SELLERPAYER1");
    });

    it("forgets no seller for a revocation signed for the demo's app, or with a merchant id not in PayPal's form", async () => {
      const revoked = vi.fn(async () => undefined);
      await send(raw("MERCHANT.PARTNER-CONSENT.REVOKED", { merchant_id: "SELLERPAYER1" }, "WH-R-1"), WEBHOOK_ID, { platform: { webhookId: PLATFORM_ID, onConsentRevoked: revoked } });
      await send(raw("MERCHANT.PARTNER-CONSENT.REVOKED", { merchant_id: "../x" }, "WH-R-2"), PLATFORM_ID, { platform: { webhookId: PLATFORM_ID, onConsentRevoked: revoked } });
      expect(revoked).not.toHaveBeenCalled();
    });

    it("asks the platform app's own check, with the platform's webhook id", async () => {
      const demoCheck = vi.fn(async () => "SUCCESS" as const);
      const platformCheck = vi.fn(async () => "SUCCESS" as const);
      const bytes = raw("PAYMENT.CAPTURE.REFUNDED", { id: "R-P-2", status: "COMPLETED" }, "WH-PLATFORM-2");
      const res = await send(bytes, PLATFORM_ID, { checkWithPayPal: demoCheck, platform: { webhookId: PLATFORM_ID, checkWithPayPal: platformCheck } });
      await res.followUp?.();
      expect(demoCheck).not.toHaveBeenCalled();
      expect(platformCheck).toHaveBeenCalledWith(expect.anything(), PLATFORM_ID, bytes);
      expect((await rows())[0].paypal_check).toBe("SUCCESS");
    });
  });

  describe("after the purge has taken the event's row", () => {
    const capture = Buffer.from(JSON.stringify({ id: "WH-OLD", event_type: "PAYMENT.CAPTURE.COMPLETED", resource_type: "capture", resource: { id: "CAPTURE-OLD" } }));
    const later = () => Date.now() + 47 * 3_600_000;
    const at = (when: () => number, transmission: string, seen: (id: string) => Promise<unknown>) =>
      handleWebhookDelivery({ rawBody: capture, headers: paypalHeaders(capture, WEBHOOK_ID, transmission), webhookId: WEBHOOK_ID, db, recordKey: key, fetchCert: fetchTestCert, now: when, onCaptureCompleted: seen });

    it.each([
      ["the same transmission", "t-old"],
      ["a new transmission", "t-resend"],
    ])("a delivery sent again under %s stores nothing and acts on nothing", async (_name, transmission) => {
      const seen = vi.fn(async () => undefined);
      await at(Date.now, "t-old", seen);
      seen.mockClear();
      await purgePayPalData(db, new Date(later()));
      expect(await rows()).toHaveLength(0);

      expect(await at(later, transmission, seen)).toEqual({ status: 200, body: { received: true, duplicate: true } });
      expect(await rows()).toHaveLength(0);
      expect(seen).not.toHaveBeenCalled();
      expect((await db.query("select 1 from paypal_webhook_transmissions")).rows).toHaveLength(1);
    });

    it("isn't revived by a clock a little behind the one that ran the purge", async () => {
      const seen = vi.fn(async () => undefined);
      const first = Date.now();
      await at(() => first, "t-old", seen);
      seen.mockClear();
      const purgedAt = first + 46 * 3_600_000 + 60_000;
      await purgePayPalData(db, new Date(purgedAt));
      expect(await rows()).toHaveLength(0);

      expect(await at(() => purgedAt - 120_000, "t-old", seen)).toEqual({ status: 200, body: { received: true, duplicate: true } });
      expect(await rows()).toHaveLength(0);
      expect(seen).not.toHaveBeenCalled();
    });

    it("a delivery whose row is missing inside the window still goes through, so a crash between the two writes loses nothing", async () => {
      const seen = vi.fn(async () => undefined);
      await at(Date.now, "t-old", seen);
      await db.query("delete from paypal_webhook_events");
      seen.mockClear();

      expect(await at(Date.now, "t-old", seen)).toEqual({ status: 200, body: { received: true, duplicate: false } });
      expect(await rows()).toHaveLength(1);
      expect(seen).toHaveBeenCalledWith("CAPTURE-OLD");
    });
  });

  describe("a transmission sent again", () => {
    const same = { ...event, resource: { id: "ATTACKER-CHOSEN", status: "COMPLETED" } };

    it("is refused when its bytes differ, even under the same event id", async () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      try {
        await deliver(body, paypalHeaders(body, WEBHOOK_ID, "t-same"));
        const crafted = Buffer.from(JSON.stringify(same));
        expect((await deliver(crafted, paypalHeaders(crafted, WEBHOOK_ID, "t-same"))).status).toBe(401);
        expect(String(warn.mock.calls[0]?.[0])).not.toContain("ATTACKER-CHOSEN");
      } finally {
        warn.mockRestore();
      }
    });

    it("goes through when its bytes are the same", async () => {
      await deliver(body, paypalHeaders(body, WEBHOOK_ID, "t-same"));
      expect((await deliver(body, paypalHeaders(body, WEBHOOK_ID, "t-same"))).body).toEqual({ received: true, duplicate: true });
    });

    it("acts on nothing for a row kept from before the bytes were remembered, because it can't tell they match", async () => {
      const capture = Buffer.from(JSON.stringify({ id: "WH-LEGACY", event_type: "PAYMENT.CAPTURE.COMPLETED", resource_type: "capture", resource: { id: "CAPTURE-LEGACY" } }));
      const seen = vi.fn(async () => undefined);
      const send = () => handleWebhookDelivery({ rawBody: capture, headers: paypalHeaders(capture, WEBHOOK_ID, "t-legacy"), webhookId: WEBHOOK_ID, db, recordKey: key, fetchCert: fetchTestCert, onCaptureCompleted: seen });
      await send();
      await db.query("update paypal_webhook_transmissions set body_hmac = null");
      await db.query("delete from paypal_webhook_events");
      seen.mockClear();
      expect(await send()).toEqual({ status: 200, body: { received: true, duplicate: true } });
      expect(seen).not.toHaveBeenCalled();
      expect(await rows()).toHaveLength(0);
    });
  });

  describe("free text in a signed body", () => {
    it("refuses an event with an empty id: there would be nothing to tell it apart by", async () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      try {
        const raw = Buffer.from(JSON.stringify({ ...event, id: "" }));
        expect((await deliver(raw, paypalHeaders(raw, WEBHOOK_ID, "t-empty"))).status).toBe(401);
        expect(await rows()).toHaveLength(0);
      } finally {
        warn.mockRestore();
      }
    });

    it.each(["1", "Nov 5 2026 8pm", "2026-13-45T00:00:00Z", 12345])("stores no create time from %s, and still takes the delivery", async (createTime) => {
      const raw = Buffer.from(JSON.stringify({ ...event, create_time: createTime }));
      expect((await deliver(raw, paypalHeaders(raw, WEBHOOK_ID, "t-time"))).status).toBe(200);
      expect((await rows())[0].event_create_time).toBeNull();
    });

    it("keeps a create time in PayPal's form", async () => {
      await deliver(body, paypalHeaders(body, WEBHOOK_ID, "t-good-time"));
      expect((await rows())[0].event_create_time).not.toBeNull();
    });

    it("refuses an event type that isn't shaped like one, and keeps it out of the store and the log", async () => {
      const info = vi.spyOn(console, "info").mockImplementation(() => {});
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      try {
        const raw = Buffer.from(JSON.stringify({ ...event, event_type: "attacker@example.com wrote this" }));
        expect((await deliver(raw, paypalHeaders(raw, WEBHOOK_ID, "t-odd"))).status).toBe(400);
        expect(await rows()).toHaveLength(0);
        const lines = [...info.mock.calls, ...warn.mock.calls].map((c) => String(c[0])).join("\n");
        expect(lines).not.toContain("attacker@example.com");
      } finally {
        info.mockRestore();
        warn.mockRestore();
      }
    });

    it("stores no resource type that isn't shaped like one", async () => {
      const raw = Buffer.from(JSON.stringify({ ...event, resource_type: "attacker@example.com" }));
      expect((await deliver(raw, paypalHeaders(raw, WEBHOOK_ID, "t-odd"))).status).toBe(200);
      expect((await rows())[0].resource_type).toBeNull();
    });
  });

  it("logs delivery facts (new transmission? its age? duplicate?) but no raw PayPal id or time", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    // paypalHeaders signs transmission time 2026-11-05T20:00:00Z; the clock reads 7 s later.
    const now = () => Date.parse("2026-11-05T20:00:07Z");
    const at = (headers: Headers) =>
      handleWebhookDelivery({ rawBody: body, headers, webhookId: WEBHOOK_ID, db, recordKey: key, fetchCert: fetchTestCert, now });
    try {
      await at(paypalHeaders(body, WEBHOOK_ID, "transmission-1"));
      await at(paypalHeaders(body, WEBHOOK_ID, "transmission-2"));
      await at(paypalHeaders(body, WEBHOOK_ID, "transmission-1"));
      const lines = info.mock.calls.map((c) => String(c[0]));
      expect(lines).toEqual([
        "PayPal webhook accepted: type=PAYMENT.CAPTURE.REFUNDED app=demo transmission_new=true transmission_age_s=7 duplicate=false",
        "PayPal webhook accepted: type=PAYMENT.CAPTURE.REFUNDED app=demo transmission_new=true transmission_age_s=7 duplicate=true",
        "PayPal webhook accepted: type=PAYMENT.CAPTURE.REFUNDED app=demo transmission_new=false transmission_age_s=7 duplicate=true",
      ]);
      for (const raw of ["WH-TEST-1", "transmission-1", "transmission-2", "2026-11-05T20:00:00Z", "TEST-REFUND-1"]) {
        expect(lines.join("\n"), raw).not.toContain(raw);
      }
    } finally {
      info.mockRestore();
    }
  });

  it("does not log the transmission id when it refuses a replay", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      await deliver(body, paypalHeaders(body, WEBHOOK_ID, "transmission-1"));
      const other = Buffer.from(JSON.stringify({ ...event, id: "WH-REPLAYED" }));
      expect((await deliver(other, paypalHeaders(other, WEBHOOK_ID, "transmission-1"))).status).toBe(401);
      const lines = warn.mock.calls.map((c) => String(c[0])).join("\n");
      expect(lines).toMatch(/already used for another event/);
      expect(lines).not.toContain("transmission-1");
      expect(lines).not.toContain("WH-REPLAYED");
    } finally {
      warn.mockRestore();
    }
  });

  it("stores a verified event under an HMAC of its id and answers 200", async () => {
    const res = await deliver(body, paypalHeaders(body, WEBHOOK_ID));
    expect(res).toEqual({ status: 200, body: { received: true, duplicate: false } });
    expect(await rows()).toMatchObject([
      {
        event_id_hmac: key("paypal-event", "WH-TEST-1"),
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
    expect((await rows()).map((r) => r.event_id_hmac)).toEqual([key("paypal-event", "WH-TEST-1")]);
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
      recordKey: key,
      fetchCert: async () => {
        certFetches++;
        return fetchTestCert();
      },
    });
    expect(res.status).toBe(503);
    expect(certFetches).toBe(0);
    expect(await rows()).toEqual([]);
  });

  it("answers 503 without verifying when no record key secret is configured", async () => {
    let certFetches = 0;
    const res = await handleWebhookDelivery({
      rawBody: body,
      headers: paypalHeaders(body, WEBHOOK_ID),
      webhookId: WEBHOOK_ID,
      db,
      recordKey: null,
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

  it("keeps only an HMAC of the PayPal resource id, never the id or a plain hash of it", async () => {
    await deliver(body, paypalHeaders(body, WEBHOOK_ID));
    const [row] = await rows();
    expect(row.resource_id_hmac).toBe(key("paypal-resource", "TEST-REFUND-1"));
    const stored = JSON.stringify(row);
    expect(stored).not.toContain("TEST-REFUND-1");
    expect(stored).not.toContain(createHash("sha256").update("TEST-REFUND-1").digest("hex"));
  });

  // PayPal Developer Agreement 10.1.3 and 11.2: these tests fail if a payer field, an amount, or a
  // raw PayPal id (event, transmission or resource) reaches any stored column, or if a column is
  // added without review.
  it("stores no payer details, amounts or raw PayPal ids from a capture event", async () => {
    const capture = {
      id: "WH-CAPTURE-1",
      event_type: "PAYMENT.CAPTURE.COMPLETED",
      create_time: "2026-11-05T21:00:00Z",
      resource_type: "capture",
      resource: {
        id: "TEST-CAPTURE-9",
        amount: { currency_code: "USD", value: "73.19" },
        invoice_id: "TEST-INVOICE-77",
        payee: { email_address: "test-seller@example.com", merchant_id: "TESTMERCHANT1" },
        supplementary_data: { related_ids: { order_id: "TEST-ORDER-5" } },
      },
      payer: { email_address: "test-buyer@example.com", name: { given_name: "Testgiven", surname: "Testsurname" }, payer_id: "TESTPAYER1" },
    };
    const raw = Buffer.from(JSON.stringify(capture));
    expect((await deliver(raw, paypalHeaders(raw, WEBHOOK_ID, "TRANSMISSION-RAW-7"))).status).toBe(200);

    const stored = await db.query<{ row: string }>(
      `select row_to_json(e)::text as row from paypal_webhook_events e
       union all select row_to_json(t)::text from paypal_webhook_transmissions t`,
    );
    const everything = stored.rows.map((r) => r.row).join("\n");
    expect(stored.rows).toHaveLength(2);
    for (const value of [
      "test-buyer@example.com",
      "test-seller@example.com",
      "Testgiven",
      "Testsurname",
      "TESTPAYER1",
      "TESTMERCHANT1",
      "73.19",
      "WH-CAPTURE-1",
      "TRANSMISSION-RAW-7",
      "TEST-CAPTURE-9",
      "TEST-INVOICE-77",
      "TEST-ORDER-5",
    ]) {
      expect(everything, value).not.toContain(value);
    }
  });

  describe("PayPal's own check, after ours", () => {
    type Answer = "SUCCESS" | "FAILURE" | Error;
    const ask = (answer: Answer) =>
      vi.fn(async (_t: unknown, _id: string, _raw: Uint8Array) => {
        if (answer instanceof Error) throw answer;
        return answer;
      });
    const deliverAsking = (raw: Uint8Array, headers: Headers, checkWithPayPal: ReturnType<typeof ask>) =>
      handleWebhookDelivery({ rawBody: raw, headers, webhookId: WEBHOOK_ID, db, recordKey: key, fetchCert: fetchTestCert, checkWithPayPal });
    const recorded = async () => (await db.query<{ paypal_check: string | null; paypal_checked_at: unknown }>("select paypal_check, paypal_checked_at from paypal_webhook_events")).rows[0];

    it("asks only once the answer to PayPal is ready, with the exact bytes it sent, and records what PayPal says", async () => {
      const asked = ask("SUCCESS");
      const res = await deliverAsking(body, paypalHeaders(body, WEBHOOK_ID), asked);
      expect(res.status).toBe(200);
      expect(asked).not.toHaveBeenCalled();
      expect((await recorded()).paypal_check).toBeNull();
      await res.followUp?.();
      expect(asked).toHaveBeenCalledOnce();
      const [transmission, webhookId, raw] = asked.mock.calls[0];
      expect(webhookId).toBe(WEBHOOK_ID);
      expect(Buffer.from(raw).equals(body)).toBe(true);
      expect(transmission).toMatchObject({ transmissionSig: expect.any(String), certUrl: expect.any(String) });
      expect(await recorded()).toMatchObject({ paypal_check: "SUCCESS", paypal_checked_at: expect.anything() });
    });

    it("records a FAILURE, and has already answered 200: our own check is the gate", async () => {
      const res = await deliverAsking(body, paypalHeaders(body, WEBHOOK_ID), ask("FAILURE"));
      expect(res.status).toBe(200);
      await res.followUp?.();
      expect((await recorded()).paypal_check).toBe("FAILURE");
    });

    it("records that PayPal couldn't be asked, never a pass", async () => {
      const res = await deliverAsking(body, paypalHeaders(body, WEBHOOK_ID), ask(new Error("PayPal is down")));
      await res.followUp?.();
      expect((await recorded()).paypal_check).toBe("UNAVAILABLE");
    });

    it("never sends PayPal a delivery our check refused", async () => {
      const asked = ask("SUCCESS");
      const res = await deliverAsking(body, paypalHeaders(Buffer.from('{"id":"other"}'), WEBHOOK_ID), asked);
      expect(res.status).toBe(401);
      expect(res.followUp).toBeUndefined();
      expect(asked).not.toHaveBeenCalled();
    });

    it("asks about an event once, not again when PayPal delivers it again", async () => {
      await (await deliverAsking(body, paypalHeaders(body, WEBHOOK_ID), ask("SUCCESS"))).followUp?.();
      const again = await deliverAsking(body, paypalHeaders(body, WEBHOOK_ID, "TRANSMISSION-2"), ask("FAILURE"));
      expect(again.body).toMatchObject({ duplicate: true });
      expect(again.followUp).toBeUndefined();
      expect((await recorded()).paypal_check).toBe("SUCCESS");
    });
  });

  describe("a refund event", () => {
    it("keeps the refund's own status and amount, and nothing else from it", async () => {
      const refund = {
        id: "WH-REFUND-2",
        event_type: "PAYMENT.CAPTURE.REFUNDED",
        create_time: "2026-11-07T21:00:00Z",
        resource_type: "refund",
        resource: { id: "TEST-REFUND-2", status: "COMPLETED", amount: { currency_code: "USD", value: "90.00" }, note_to_payer: "TEST NOTE 27027", payer: { email_address: "test-payer@example.com", merchant_id: "TESTMERCHANT2" } },
      };
      const raw = Buffer.from(JSON.stringify(refund));
      expect((await deliver(raw, paypalHeaders(raw, WEBHOOK_ID))).status).toBe(200);
      const [row] = await rows();
      expect(row).toMatchObject({ resource_status: "COMPLETED", resource_amount_cents: 9000, resource_currency: "USD" });
      for (const value of ["test-payer@example.com", "TESTMERCHANT2", "TEST NOTE 27027", "TEST-REFUND-2", "WH-REFUND-2"]) expect(JSON.stringify(row), value).not.toContain(value);
    });

    it("keeps nothing it can't read exactly", async () => {
      const odd = { ...event, id: "WH-REFUND-3", resource: { id: "TEST-REFUND-3", status: "completed; drop table", amount: { currency_code: "usd", value: "1e3" } } };
      const raw = Buffer.from(JSON.stringify(odd));
      await deliver(raw, paypalHeaders(raw, WEBHOOK_ID));
      expect((await rows())[0]).toMatchObject({ resource_status: null, resource_amount_cents: null, resource_currency: null });
    });
  });

  it("has exactly the reviewed columns in the webhook tables", async () => {
    const { rows: cols } = await db.query<{ table_name: string; column_name: string }>(
      `select table_name, column_name from information_schema.columns
       where table_name in ('paypal_webhook_events', 'paypal_webhook_transmissions')
       order by table_name, ordinal_position`,
    );
    expect(cols.map((c) => `${c.table_name}.${c.column_name}`)).toEqual([
      "paypal_webhook_events.event_id_hmac",
      "paypal_webhook_events.event_type",
      "paypal_webhook_events.resource_type",
      "paypal_webhook_events.resource_id_hmac",
      "paypal_webhook_events.event_create_time",
      "paypal_webhook_events.verification_method",
      "paypal_webhook_events.received_at",
      "paypal_webhook_events.paypal_check",
      "paypal_webhook_events.paypal_checked_at",
      "paypal_webhook_events.resource_status",
      "paypal_webhook_events.resource_amount_cents",
      "paypal_webhook_events.resource_currency",
      "paypal_webhook_transmissions.transmission_id_hmac",
      "paypal_webhook_transmissions.event_id_hmac",
      "paypal_webhook_transmissions.received_at",
      "paypal_webhook_transmissions.body_hmac",
    ]);
  });
});
