import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/server/db/pg", () => ({ getDb: () => ({}) }));
const handle = vi.hoisted(() => vi.fn());
vi.mock("@/server/paypal/webhookHandler", async (original) => ({
  ...(await original<typeof import("@/server/paypal/webhookHandler")>()),
  handleWebhookDelivery: handle,
}));

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
});
