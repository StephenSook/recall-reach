import { describe, expect, it } from "vitest";
import { createPayPalClient, PayPalApiError } from "./client";
import { PAYPAL_SANDBOX_BASE, type TokenProvider } from "./token";

type Reply = Response | Error;

function fakeTokens(): TokenProvider & { invalidations: number } {
  let n = 1;
  const t = {
    invalidations: 0,
    get: async () => `token-${n}`,
    invalidate: () => {
      t.invalidations++;
      n++;
    },
  };
  return t;
}

function scripted(replies: Reply[]) {
  const calls: { url: string; method: string; headers: Headers; body: string | undefined }[] = [];
  const sleeps: number[] = [];
  const fetchImpl = async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({
      url: String(input),
      method: init?.method ?? "GET",
      headers: new Headers(init?.headers),
      body: init?.body === undefined ? undefined : String(init.body),
    });
    const next = replies.shift();
    if (!next) throw new Error("no scripted reply left");
    if (next instanceof Error) throw next;
    return next;
  };
  const tokens = fakeTokens();
  const client = createPayPalClient({
    tokens,
    fetchImpl: fetchImpl as typeof fetch,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
  });
  return { client, calls, sleeps, tokens };
}

const ok = (body: unknown, status = 200) => Response.json(body, { status });
const fail = (status: number, body: unknown = { name: "ERROR", details: [{ issue: "SOMETHING" }], debug_id: "dbg1" }) =>
  Response.json(body, { status });

describe("PayPal client", () => {
  it("calls the sandbox with a bearer token, JSON body, query and PayPal-Request-Id", async () => {
    const s = scripted([ok({ id: "R1" }, 201)]);
    const res = await s.client.request("POST", "/v2/payments/captures/CAP1/refund", {
      body: { note_to_payer: "n" },
      requestId: "req-1",
      query: { a: "1" },
    });
    expect(res).toEqual({ status: 201, data: { id: "R1" } });
    expect(s.calls[0].url).toBe(`${PAYPAL_SANDBOX_BASE}/v2/payments/captures/CAP1/refund?a=1`);
    expect(s.calls[0].headers.get("authorization")).toBe("Bearer token-1");
    expect(s.calls[0].headers.get("content-type")).toBe("application/json");
    expect(s.calls[0].headers.get("paypal-request-id")).toBe("req-1");
    expect(s.calls[0].body).toBe(JSON.stringify({ note_to_payer: "n" }));
  });

  it("refreshes the token once on 401 and retries with the new token", async () => {
    const s = scripted([fail(401), ok({ fine: true })]);
    expect((await s.client.request("GET", "/v2/checkout/orders/O1")).data).toEqual({ fine: true });
    expect(s.tokens.invalidations).toBe(1);
    expect(s.calls.map((c) => c.headers.get("authorization"))).toEqual(["Bearer token-1", "Bearer token-2"]);
  });

  it("gives up after a second 401", async () => {
    const s = scripted([fail(401), fail(401)]);
    await expect(s.client.request("GET", "/v2/checkout/orders/O1")).rejects.toThrow(/401/);
    expect(s.calls).toHaveLength(2);
  });

  it("retries a GET on 503 with backoff and gives up after three attempts", async () => {
    const s = scripted([fail(503), fail(502), fail(500)]);
    await expect(s.client.request("GET", "/v1/reporting/transactions")).rejects.toThrow(/PayPal 500/);
    expect(s.calls).toHaveLength(3);
    expect(s.sleeps).toEqual([500, 1000]);
  });

  it("retries a POST that carries a PayPal-Request-Id (PayPal deduplicates it)", async () => {
    const s = scripted([new TypeError("fetch failed"), ok({ id: "R1" }, 201)]);
    const res = await s.client.request("POST", "/v2/payments/captures/CAP1/refund", { body: {}, requestId: "req-1" });
    expect(res.data).toEqual({ id: "R1" });
    expect(s.calls.map((c) => c.headers.get("paypal-request-id"))).toEqual(["req-1", "req-1"]);
  });

  it("never retries a POST without a PayPal-Request-Id", async () => {
    const s = scripted([fail(503), ok({})]);
    await expect(s.client.request("POST", "/v2/checkout/orders", { body: {} })).rejects.toThrow(/PayPal 503/);
    expect(s.calls).toHaveLength(1);
  });

  it("never retries a PATCH, even with a PayPal-Request-Id: a repeated patch could apply twice", async () => {
    const s = scripted([fail(503), ok({})]);
    await expect(s.client.request("PATCH", "/v2/checkout/orders/O1", { body: [], requestId: "req-1" })).rejects.toThrow(/PayPal 503/);
    expect(s.calls).toHaveLength(1);
  });

  it("does not retry a 422 and reports PayPal's issue and debug id", async () => {
    const s = scripted([
      fail(422, { name: "UNPROCESSABLE_ENTITY", details: [{ issue: "CAPTURE_FULLY_REFUNDED" }], debug_id: "abc123" }),
    ]);
    const err = await s.client.request("POST", "/v2/payments/captures/CAP1/refund", { body: {}, requestId: "r" }).catch((e) => e);
    expect(err).toBeInstanceOf(PayPalApiError);
    expect(err).toMatchObject({ status: 422, issue: "CAPTURE_FULLY_REFUNDED", debugId: "abc123" });
    expect(s.calls).toHaveLength(1);
  });

  it("never puts a raw PayPal id or debug id in the error message, which ends up in logs", async () => {
    const s = scripted([fail(422, { name: "UNPROCESSABLE_ENTITY", details: [{ issue: "REFUND_AMOUNT_EXCEEDED" }], debug_id: "debug-raw-99" })]);
    const err = await s.client.request("POST", "/v2/payments/captures/6LJ47309WP1325443/refund", { body: {}, requestId: "r" }).catch((e) => e);
    expect(err.message).toBe("PayPal 422 on POST /v2/payments/captures/:id/refund: REFUND_AMOUNT_EXCEEDED");
    expect(err.path).toBe("/v2/payments/captures/:id/refund");
    expect(JSON.stringify({ message: err.message, path: err.path })).not.toContain("6LJ47309WP1325443");
    expect(err.message).not.toContain("debug-raw-99");
  });

  it("refuses a path that is not a PayPal API path", async () => {
    const s = scripted([]);
    await expect(s.client.request("GET", "https://evil.example/x")).rejects.toThrow(/path/);
    expect(s.calls).toHaveLength(0);
  });
});
