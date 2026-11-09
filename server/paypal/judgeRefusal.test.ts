import { afterEach, describe, expect, it, vi } from "vitest";
import fixture from "@/test/fixtures/paypal/refund-time-limit.json";
import { judgeRefusal } from "./judgeRefusal";
import { PAYPAL_SANDBOX_BASE } from "./token";

const env = { NODE_ENV: "test" as const, PAYPAL_CLIENT_ID: "client", PAYPAL_CLIENT_SECRET: "secret" };
const CAPTURE = "OLD-CAPTURE";
const captureIds = async () => [CAPTURE];
const captureUrl = `${PAYPAL_SANDBOX_BASE}/v2/payments/captures/${CAPTURE}`;
const token = () => Response.json({ access_token: "token", expires_in: 300 });
const capture = (status = "REFUNDED") => Response.json({ id: CAPTURE, status });
const late = () => Response.json(fixture.body, { status: fixture.status });
const network = () => vi.fn<typeof fetch>().mockResolvedValueOnce(token()).mockResolvedValueOnce(capture()).mockResolvedValueOnce(late());

afterEach(() => vi.unstubAllEnvs());

describe("the judge's sandbox refusal", () => {
  it("reads PayPal's current capture before sending exactly one cent and the mock header", async () => {
    const fetchImpl = network();
    const result = await judgeRefusal({ env, captureIds, fetchImpl });
    expect(result).toMatchObject({ status: 422, expected: true, details: fixture.body.details });
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(fetchImpl.mock.calls[0]).toEqual([`${PAYPAL_SANDBOX_BASE}/v1/oauth2/token`, expect.objectContaining({ redirect: "error" })]);
    expect(fetchImpl.mock.calls[1]).toEqual([captureUrl, expect.objectContaining({ method: "GET", cache: "no-store", redirect: "error", signal: expect.any(AbortSignal) })]);
    const [url, init] = fetchImpl.mock.calls[2];
    expect(url).toBe(`${captureUrl}/refund`);
    expect(init).toMatchObject({ method: "POST", redirect: "error", headers: {
      Authorization: "Bearer token",
      "PayPal-Mock-Response": JSON.stringify({ mock_application_codes: "REFUND_TIME_LIMIT_EXCEEDED" }),
      "PayPal-Request-Id": expect.any(String),
    } });
    expect(JSON.parse(String(init?.body))).toEqual({ amount: { value: "0.01", currency_code: "USD" } });
    expect(JSON.stringify(result)).not.toMatch(/DEBUG|OLD-CAPTURE|debug_id|links|access_token/);
  });

  it.each(["https://api-m.paypal.com", `${PAYPAL_SANDBOX_BASE}/`, `${PAYPAL_SANDBOX_BASE}.example.org`, "http://api-m.sandbox.paypal.com"])("refuses base %s before any network call", async (baseUrl) => {
    const fetchImpl = network();
    expect(await judgeRefusal({ env, captureIds, fetchImpl, baseUrl })).toMatchObject({ expected: false, status: null, message: "This test only runs on PayPal's sandbox." });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it.each(["COMPLETED", "PARTIALLY_REFUNDED", "PENDING", "refunded", undefined])("never sends a refund when PayPal reports %s", async (status) => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValueOnce(token()).mockResolvedValueOnce(Response.json({ status }));
    expect(await judgeRefusal({ env, captureIds, fetchImpl })).toMatchObject({ expected: false, message: expect.stringContaining("No refund request was sent") });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(fetchImpl.mock.calls.filter(([url]) => String(url).endsWith("/refund"))).toEqual([]);
  });

  it("does not trust a REFUNDED field on an HTTP error", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValueOnce(token()).mockResolvedValueOnce(Response.json({ status: "REFUNDED" }, { status: 500 }));
    expect(await judgeRefusal({ env, captureIds, fetchImpl })).toMatchObject({ status: 500, expected: false });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("never sends a refund after the capture read times out or cannot be parsed", async () => {
    for (const read of [Promise.reject(new Error("capture timeout")), Promise.resolve(new Response("not JSON"))]) {
      const fetchImpl = vi.fn<typeof fetch>().mockResolvedValueOnce(token()).mockImplementationOnce(() => read);
      expect((await judgeRefusal({ env, captureIds, fetchImpl })).expected).toBe(false);
      expect(fetchImpl).toHaveBeenCalledTimes(2);
    }
  });

  it("does not follow a redirected token request or send any capture request", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValueOnce(new Response(null, { status: 302, headers: { location: "https://example.org" } }));
    expect((await judgeRefusal({ env, captureIds, fetchImpl })).expected).toBe(false);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl.mock.calls[0][1]?.redirect).toBe("error");
  });

  it("keeps a token refusal's HTTP status without calling it a timeout", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValueOnce(new Response(null, { status: 503 }));
    expect(await judgeRefusal({ env, captureIds, fetchImpl })).toMatchObject({ expected: false, status: 503, message: expect.stringContaining("did not return a usable answer") });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("awaits the capture check before a refund can start", async () => {
    let finish!: (response: Response) => void;
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValueOnce(token()).mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; })).mockResolvedValueOnce(late());
    const result = judgeRefusal({ env, captureIds, fetchImpl });
    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(2));
    finish(capture());
    expect((await result).expected).toBe(true);
  });

  it("uses a fresh request id and the mock header on every press", async () => {
    const fetchImpl = network().mockResolvedValueOnce(token()).mockResolvedValueOnce(capture()).mockResolvedValueOnce(late());
    await judgeRefusal({ env, captureIds, fetchImpl });
    await judgeRefusal({ env, captureIds, fetchImpl });
    const posts = fetchImpl.mock.calls.filter(([url]) => String(url).endsWith("/refund"));
    const ids = posts.map(([, init]) => {
      const headers = new Headers(init?.headers);
      expect(headers.get("PayPal-Mock-Response")).toBe('{"mock_application_codes":"REFUND_TIME_LIMIT_EXCEEDED"}');
      expect(headers.get("PayPal-Request-Id")).toMatch(/^[a-f0-9-]{36}$/);
      return headers.get("PayPal-Request-Id");
    });
    expect(new Set(ids).size).toBe(2);
  });

  it.each([422, 500, 201])("shows an unexpected HTTP %s answer without claiming the late-refund refusal", async (status) => {
    const details = [{ issue: "CAPTURE_FULLY_REFUNDED", description: "Capture has been fully refunded." }];
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValueOnce(token()).mockResolvedValueOnce(capture()).mockResolvedValueOnce(Response.json({ details }, { status }));
    expect(await judgeRefusal({ env, captureIds, fetchImpl })).toEqual({ status, expected: false, details, message: expect.stringContaining("Unexpected answer") });
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it("does not call a 5xx with the expected code a successful test", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValueOnce(token()).mockResolvedValueOnce(capture()).mockResolvedValueOnce(Response.json(fixture.body, { status: 500 }));
    expect(await judgeRefusal({ env, captureIds, fetchImpl })).toMatchObject({ status: 500, expected: false });
  });

  it("reports a timeout without retrying or leaking the error's URL", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValueOnce(token()).mockResolvedValueOnce(capture()).mockRejectedValueOnce(new Error(`timeout: ${captureUrl}`));
    expect(await judgeRefusal({ env, captureIds, fetchImpl })).toMatchObject({ expected: false, status: null, message: "PayPal didn't answer. The late-refund test could not be completed." });
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it("keeps the received HTTP status if PayPal sends an unreadable body", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValueOnce(token()).mockResolvedValueOnce(capture()).mockResolvedValueOnce(new Response("not json OLD-CAPTURE", { status: 503 }));
    expect(await judgeRefusal({ env, captureIds, fetchImpl })).toMatchObject({ expected: false, status: 503, details: [], message: expect.stringContaining("did not return a usable answer") });
  });

  it("removes ids even if PayPal repeats them in its description", async () => {
    const body = { debug_id: "debug-private", id: "refund-private", details: [{ issue: "UNEXPECTED", description: "OLD-CAPTURE refund-private debug-private 9AB12345CD6789012" }] };
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValueOnce(token()).mockResolvedValueOnce(capture()).mockResolvedValueOnce(Response.json(body, { status: 422 }));
    const result = await judgeRefusal({ env, captureIds, fetchImpl });
    expect(result.details[0].description).toBe("[hidden] [hidden] [hidden] [hidden]");
  });

  it("refuses with nothing to test before any network call when no refunded sale is on record", async () => {
    const fetchImpl = network();
    expect(await judgeRefusal({ env, fetchImpl, captureIds: async () => [] })).toMatchObject({ expected: false, status: null, message: expect.stringContaining("No refund request was sent") });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("refuses before any network call when our refund records can't be read", async () => {
    const fetchImpl = network();
    expect(await judgeRefusal({ env, fetchImpl, captureIds: async () => { throw new Error("db down"); } })).toMatchObject({ expected: false, status: null });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("skips malformed ids from the records and never builds a URL from them", async () => {
    const fetchImpl = network();
    expect((await judgeRefusal({ env, fetchImpl, captureIds: async () => ["../other/refund", "CAP?query=1", "CAP#fragment"] })).expected).toBe(false);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("uses the newest candidate PayPal reports as REFUNDED, and sends nothing for the others", async () => {
    const fetchImpl = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(token())
      .mockResolvedValueOnce(Response.json({ id: "NEWER", status: "PARTIALLY_REFUNDED" }))
      .mockResolvedValueOnce(capture())
      .mockResolvedValueOnce(late());
    const result = await judgeRefusal({ env, fetchImpl, captureIds: async () => ["NEWER", CAPTURE] });
    expect(result.expected).toBe(true);
    const posts = fetchImpl.mock.calls.filter(([url]) => String(url).endsWith("/refund"));
    expect(posts.map(([url]) => url)).toEqual([`${captureUrl}/refund`]);
    expect(JSON.stringify(result)).not.toMatch(/NEWER|OLD-CAPTURE/);
  });

  it("sends nothing when no candidate is fully refunded at PayPal", async () => {
    const fetchImpl = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(token())
      .mockResolvedValueOnce(Response.json({ status: "COMPLETED" }))
      .mockResolvedValueOnce(Response.json({ status: "PARTIALLY_REFUNDED" }));
    expect(await judgeRefusal({ env, fetchImpl, captureIds: async () => ["A1", "B2"] })).toMatchObject({ expected: false, message: expect.stringContaining("No refund request was sent") });
    expect(fetchImpl.mock.calls.filter(([url]) => String(url).endsWith("/refund"))).toEqual([]);
  });
});
