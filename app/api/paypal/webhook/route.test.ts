import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/server/db/pg", () => ({ getDb: () => ({}), getBillingDb: () => ({}) }));
const handle = vi.hoisted(() => vi.fn());
const later = vi.hoisted(() => vi.fn());
vi.mock("next/server", async (original) => ({ ...(await original<typeof import("next/server")>()), after: later }));
vi.mock("@/server/paypal/webhookHandler", async (original) => ({
  ...(await original<typeof import("@/server/paypal/webhookHandler")>()),
  handleWebhookDelivery: handle,
}));
const recorded = vi.hoisted(() => vi.fn(async () => true));
const reader = vi.hoisted(() => async () => "SUCCESS");
const readerFor = vi.hoisted(() => vi.fn(() => reader));
vi.mock("@/server/paypal/payouts", async (original) => ({
  ...(await original<typeof import("@/server/paypal/payouts")>()),
  recordPayoutItemEvent: recorded,
  payoutItemStatus: readerFor,
}));
vi.mock("@/server/paypal/callLog", () => ({ withCallLog: (_db: unknown, _shop: unknown, run: () => unknown) => run() }));
vi.mock("@/server/paypal/client", async (original) => ({ ...(await original<typeof import("@/server/paypal/client")>()), payPalClientFromEnv: () => ({ request: vi.fn() }) }));

import { MAX_WEBHOOK_BYTES } from "@/server/paypal/webhookHandler";
import { POST } from "./route";

const post = (body: string | Uint8Array = "{}") => POST(new Request("http://localhost/api/paypal/webhook", { method: "POST", body: body as BodyInit }));

describe("POST /api/paypal/webhook", () => {
  let logged: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    handle.mockReset();
    logged = vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("answers with what the handler decided", async () => {
    handle.mockResolvedValue({ status: 401, body: { error: "signature not verified" } });
    const res = await post();
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "signature not verified" });
  });

  it("asks PayPal's own check only after answering, and hands the handler a way to ask it", async () => {
    const followUp = vi.fn(async () => {});
    handle.mockResolvedValue({ status: 200, body: { received: true, duplicate: false }, followUp });
    later.mockReset();
    const res = await post();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ received: true, duplicate: false });
    expect(followUp).not.toHaveBeenCalled();
    expect(later).toHaveBeenCalledWith(followUp);
    expect(handle.mock.calls[0][0].checkWithPayPal).toEqual(expect.any(Function));
  });

  it("schedules nothing when the handler has nothing to ask", async () => {
    handle.mockResolvedValue({ status: 401, body: { error: "signature not verified" } });
    later.mockReset();
    await post();
    expect(later).not.toHaveBeenCalled();
  });

  it("hands the handler a payout step that reads the batch from PayPal before it records anything", async () => {
    handle.mockResolvedValue({ status: 200, body: { received: true, duplicate: false } });
    await post();
    const onPayoutItem = handle.mock.calls[0][0].onPayoutItem;
    expect(onPayoutItem).toEqual(expect.any(Function));
    const resource = { payout_batch_id: "BATCH-1", transaction_status: "SUCCESS" };
    const key = () => "hash";
    await onPayoutItem(resource, key);
    expect(readerFor).toHaveBeenCalledTimes(1);
    expect(recorded).toHaveBeenCalledWith(expect.anything(), key, resource, reader);
  });

  it("gives the handler the exact bytes it was sent, unparsed", async () => {
    handle.mockResolvedValue({ status: 200, body: { received: true, duplicate: false } });
    await post('{ "spaced":   "as sent" }');
    expect(Buffer.from(handle.mock.calls[0][0].rawBody).toString()).toBe('{ "spaced":   "as sent" }');
  });

  it("refuses an oversized body without passing it on", async () => {
    const res = await post(new Uint8Array(MAX_WEBHOOK_BYTES + 1));
    expect(res.status).toBe(413);
    expect(handle).not.toHaveBeenCalled();
  });

  it("answers 500 when handling fails, so PayPal tries again, and says nothing about why", async () => {
    handle.mockRejectedValue(new Error("connection to db.internal.example failed"));
    const res = await post();
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "internal error" });
    expect(logged).toHaveBeenCalled();
  });

  it("hands the handler the platform app's webhook id, its own check and a way to forget a seller, once it is set up", async () => {
    vi.stubEnv("PAYPAL_PLATFORM_WEBHOOK_ID", "PLATFORMHOOK1");
    vi.stubEnv("PAYPAL_PLATFORM_CLIENT_ID", "platform-client");
    vi.stubEnv("PAYPAL_PLATFORM_CLIENT_SECRET", "platform-secret");
    vi.stubEnv("PAYPAL_PARTNER_MERCHANT_ID", "PARTNER123");
    try {
      handle.mockResolvedValue({ status: 200, body: { received: true, duplicate: false } });
      await post();
      const platform = handle.mock.calls[0][0].platform;
      expect(platform.webhookId).toBe("PLATFORMHOOK1");
      expect(platform.checkWithPayPal).toEqual(expect.any(Function));
      expect(platform.onConsentRevoked).toEqual(expect.any(Function));
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("hands no platform app when none is set up", async () => {
    vi.stubEnv("PAYPAL_PLATFORM_WEBHOOK_ID", "");
    try {
      handle.mockResolvedValue({ status: 200, body: { received: true, duplicate: false } });
      await post();
      expect(handle.mock.calls[0][0].platform).toBeUndefined();
    } finally {
      vi.unstubAllEnvs();
    }
  });
});
