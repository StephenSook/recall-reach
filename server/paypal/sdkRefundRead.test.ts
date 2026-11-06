import { inspect } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createPayPalClient } from "./client";
import { refundReadsThroughServerSdk } from "./sdkRefundRead";

const SANDBOX_REFUND = "https://api-m.sandbox.paypal.com/v2/payments/refunds/R1";
const refund = { id: "R1", status: "COMPLETED", amount: { currency_code: "USD", value: "35.00" } };

/** The real SDK and the real axios, with only the network replaced. */
function network(answer: (signal: AbortSignal) => Response | Promise<Response>) {
  const calls: { url: string; method: string; authorization: string | null }[] = [];
  vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
    const req = input instanceof Request ? input : new Request(String(input), init);
    calls.push({ url: req.url, method: req.method, authorization: req.headers.get("authorization") });
    return answer(req.signal);
  });
  return calls;
}

/** As real fetch does: no answer, until the signal stops it. */
const hangsUntilAborted = (signal: AbortSignal) =>
  new Promise<Response>((_, reject) => {
    signal.addEventListener("abort", () => reject(signal.reason), { once: true });
  });

const read = (fetchImpl: typeof fetch, url = SANDBOX_REFUND, token = "tok") =>
  fetchImpl(url, { method: "GET", headers: { Authorization: `Bearer ${token}` } });

describe("refundReadsThroughServerSdk", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("reads a refund through the SDK, from the sandbox, with the token it was given, and asks for no other", async () => {
    const calls = network(() => Response.json(refund));
    const res = await read(refundReadsThroughServerSdk(vi.fn()));
    expect(res.status).toBe(200);
    expect(calls).toEqual([{ url: SANDBOX_REFUND, method: "GET", authorization: "Bearer tok" }]);
  });

  it("hands back PayPal's own words, so the same schema reads them", async () => {
    network(() => Response.json(refund));
    expect(await (await read(refundReadsThroughServerSdk(vi.fn()))).json()).toEqual(refund);
  });

  it.each([
    [404, { name: "RESOURCE_NOT_FOUND" }],
    [401, { name: "AUTHENTICATION_FAILURE" }],
    [422, { name: "UNPROCESSABLE_ENTITY", details: [{ issue: "SOME_ISSUE" }] }],
  ])("passes a %i through as an answer, so the client above treats it as it treats any other", async (status, body) => {
    network(() => Response.json(body, { status }));
    const res = await read(refundReadsThroughServerSdk(vi.fn()));
    expect(res.status).toBe(status);
    expect(await res.json()).toEqual(body);
  });

  it("doesn't retry by itself, because the client above already does and retries multiply", async () => {
    const calls = network(() => new Response("{}", { status: 503 }));
    const res = await read(refundReadsThroughServerSdk(vi.fn()));
    expect(res.status).toBe(503);
    expect(calls).toHaveLength(1);
  });

  it("has a real time limit, because the SDK's own default of 0 means none", async () => {
    network(hangsUntilAborted);
    const started = Date.now();
    await expect(read(refundReadsThroughServerSdk(vi.fn(), { timeoutMs: 100 }))).rejects.toThrow();
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it("stops when the caller's signal does", async () => {
    network(hangsUntilAborted);
    const stop = new AbortController();
    const pending = refundReadsThroughServerSdk(vi.fn())(SANDBOX_REFUND, { method: "GET", headers: { Authorization: "Bearer tok" }, signal: stop.signal });
    stop.abort();
    await expect(pending).rejects.toThrow();
  });

  it("leaves everything else to the next fetch: a refund being sent stays where it is", async () => {
    const calls = network(() => Response.json({}));
    const other = vi.fn(async () => new Response("other"));
    const through = refundReadsThroughServerSdk(other as typeof fetch);
    await through("https://api-m.sandbox.paypal.com/v2/payments/captures/C1/refund", { method: "POST", headers: { Authorization: "Bearer tok" }, body: "{}" });
    await through("https://api-m.sandbox.paypal.com/v2/payments/captures/C1", { method: "GET", headers: { Authorization: "Bearer tok" } });
    await through(SANDBOX_REFUND, { method: "POST", headers: { Authorization: "Bearer tok" } });
    expect(other).toHaveBeenCalledTimes(3);
    expect(calls).toEqual([]);
  });

  describe("when the call fails with no answer from PayPal", () => {
    const failing = async () => {
      vi.stubGlobal("fetch", async () => {
        throw new TypeError("fetch failed");
      });
      return read(refundReadsThroughServerSdk(vi.fn()), "https://api-m.sandbox.paypal.com/v2/payments/refunds/PRIVATE-REFUND-ID", "SECRET-TOKEN").catch((e: unknown) => e);
    };

    it("keeps the token and the refund id out of the error, however it gets printed", async () => {
      const err = await failing();
      expect(err).toBeInstanceOf(Error);
      for (const printed of [String(err), inspect(err, { depth: 10, showHidden: true }), JSON.stringify(err)]) {
        expect(printed).not.toContain("SECRET-TOKEN");
        expect(printed).not.toContain("PRIVATE-REFUND-ID");
      }
      expect((err as Error).cause).toBeUndefined();
    });

    it("is still a failure the client above retries", async () => {
      let tries = 0;
      vi.stubGlobal("fetch", async () => {
        tries++;
        throw new TypeError("fetch failed");
      });
      const client = createPayPalClient({ tokens: { get: async () => "tok", invalidate: () => {} }, fetchImpl: refundReadsThroughServerSdk(vi.fn()), sleep: async () => {} });
      await expect(client.request("GET", "/v2/payments/refunds/R1")).rejects.toThrow();
      expect(tries).toBe(3);
    });
  });

  it("won't read without a token", async () => {
    const calls = network(() => Response.json(refund));
    await expect(refundReadsThroughServerSdk(vi.fn())(SANDBOX_REFUND, { method: "GET" })).rejects.toThrow("token");
    expect(calls).toEqual([]);
  });

  describe("through the app's PayPal client", () => {
    const tokens = () => {
      let n = 0;
      return { get: async () => `tok-${++n}`, invalidate: vi.fn() };
    };

    it("reads the same as any other call", async () => {
      network(() => Response.json(refund));
      const client = createPayPalClient({ tokens: tokens(), fetchImpl: refundReadsThroughServerSdk(vi.fn()) });
      expect((await client.request("GET", "/v2/payments/refunds/R1")).data).toEqual(refund);
    });

    it("gets a fresh token after a 401, as it does everywhere", async () => {
      const answers = [Response.json({ name: "AUTHENTICATION_FAILURE" }, { status: 401 }), Response.json(refund)];
      const calls = network(() => answers.shift() as Response);
      const t = tokens();
      const client = createPayPalClient({ tokens: t, fetchImpl: refundReadsThroughServerSdk(vi.fn()) });
      expect((await client.request("GET", "/v2/payments/refunds/R1")).data).toEqual(refund);
      expect(t.invalidate).toHaveBeenCalledTimes(1);
      expect(calls.map((c) => c.authorization)).toEqual(["Bearer tok-1", "Bearer tok-2"]);
    });

    it("doesn't put a refund id in an error message, as with every other call", async () => {
      network(() => Response.json({ name: "RESOURCE_NOT_FOUND" }, { status: 404 }));
      const client = createPayPalClient({ tokens: tokens(), fetchImpl: refundReadsThroughServerSdk(vi.fn()) });
      const err = await client.request("GET", "/v2/payments/refunds/R1").catch((e: Error) => e);
      expect(err).toBeInstanceOf(Error);
      expect((err as Error).message).not.toContain("R1");
    });
  });
});
