import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fetchTestCert, paypalHeaders } from "../../test/paypalSigner";
import { testDb } from "../../test/pglite";
import { migrate } from "../db/migrate";
import { createRecordKey } from "../privacy/recordKey";
import { purgePayPalData } from "../privacy/retention";
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

    it("goes through for a row kept from before the bytes were remembered", async () => {
      await deliver(body, paypalHeaders(body, WEBHOOK_ID, "t-same"));
      await db.query("update paypal_webhook_transmissions set body_hmac = null");
      expect((await deliver(body, paypalHeaders(body, WEBHOOK_ID, "t-same"))).status).toBe(200);
    });
  });

  describe("free text in a signed body", () => {
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
        "PayPal webhook accepted: type=PAYMENT.CAPTURE.REFUNDED transmission_new=true transmission_age_s=7 duplicate=false",
        "PayPal webhook accepted: type=PAYMENT.CAPTURE.REFUNDED transmission_new=true transmission_age_s=7 duplicate=true",
        "PayPal webhook accepted: type=PAYMENT.CAPTURE.REFUNDED transmission_new=false transmission_age_s=7 duplicate=true",
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
      "paypal_webhook_transmissions.transmission_id_hmac",
      "paypal_webhook_transmissions.event_id_hmac",
      "paypal_webhook_transmissions.received_at",
      "paypal_webhook_transmissions.body_hmac",
    ]);
  });
});
