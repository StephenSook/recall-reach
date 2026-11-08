import { inspect } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createPayPalClient, PayPalApiError, payPalClientFromEnv } from "./client";
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

  it("sends a body given as text exactly as given, so bytes PayPal signed aren't rewritten", async () => {
    const s = scripted([ok({ verification_status: "SUCCESS" })]);
    const raw = '{"webhook_event":{"id":"WH-1",  "note":"caf\u00e9 \\u00e9"}}';
    await s.client.request("POST", "/v1/notifications/verify-webhook-signature", { rawJson: raw });
    expect(s.calls[0].body).toBe(raw);
    expect(s.calls[0].headers.get("content-type")).toBe("application/json");
  });

  it("sends headers the client was made with on every request, such as acting for a connected shop", async () => {
    const seen: Headers[] = [];
    const client = createPayPalClient({
      tokens: fakeTokens(),
      headers: { "PayPal-Auth-Assertion": "eyJhbGciOiJub25lIn0.eyJpc3MiOiJ4In0." },
      fetchImpl: (async (_url: string, init?: RequestInit) => {
        seen.push(new Headers(init?.headers));
        return ok({});
      }) as typeof fetch,
    });
    await client.request("GET", "/v2/payments/captures/CAP1");
    await client.request("POST", "/v2/payments/captures/CAP1/refund", { body: {}, requestId: "r1" });
    for (const h of seen) expect(h.get("paypal-auth-assertion")).toBe("eyJhbGciOiJub25lIn0.eyJpc3MiOiJ4In0.");
    expect(seen[1].get("paypal-request-id")).toBe("r1");
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

  describe("when a call gets no answer from PayPal", () => {
    const holdsTheRequest = () =>
      Object.assign(new Error("Network Error on /v2/payments/refunds/PRIVATE-ID"), {
        config: { url: "/v2/payments/refunds/PRIVATE-ID", headers: { Authorization: "Bearer SECRET-TOKEN" } },
        cause: new Error("SECRET-TOKEN"),
      });

    it.each([
      ["a read, after its retries", "GET", {}, 3],
      ["a send with no request id, which is not retried", "POST", { body: {} }, 1],
    ] as const)("%s leaves with fixed words, whatever the layer below threw", async (_about, method, options, calls) => {
      const s = scripted([holdsTheRequest(), holdsTheRequest(), holdsTheRequest()]);
      const err = await s.client.request(method, "/v2/payments/refunds/PRIVATE-ID", options).catch((e: unknown) => e);
      expect(s.calls).toHaveLength(calls);
      expect((err as Error).message).toBe("PayPal gave no answer");
      expect((err as Error).cause).toBeUndefined();
      for (const printed of [String(err), inspect(err, { depth: 10, showHidden: true }), JSON.stringify(err)]) {
        expect(printed).not.toContain("SECRET-TOKEN");
        expect(printed).not.toContain("PRIVATE-ID");
      }
    });

    it.each([
      ["isn't JSON", () => new Response("PRIVATE-ORDER-DATA", { status: 200 })],
      [
        "breaks off while it is read",
        () =>
          new Response(
            new ReadableStream({
              start(controller) {
                controller.error(new Error("PRIVATE-ORDER-DATA"));
              },
            }),
            { status: 200 },
          ),
      ],
    ])("an answer that %s leaves with fixed words, not the bytes", async (_about, answer) => {
      const s = scripted([answer()]);
      const err = await s.client.request("GET", "/v2/checkout/orders/O1").catch((e: unknown) => e);
      expect(s.calls).toHaveLength(1);
      expect((err as Error).message).toBe("PayPal's answer could not be read");
      expect((err as Error).cause).toBeUndefined();
      expect(inspect(err, { depth: 10, showHidden: true })).not.toContain("PRIVATE-ORDER-DATA");
    });

    it("keeps PayPal's own answer when the last try got one", async () => {
      const s = scripted([holdsTheRequest(), fail(503), fail(500)]);
      const err = await s.client.request("GET", "/v2/payments/refunds/PRIVATE-ID").catch((e: unknown) => e);
      expect(err).toBeInstanceOf(PayPalApiError);
      expect((err as PayPalApiError).uncertain).toBe(true);
    });
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
    const err = await s.client.request("POST", "/v2/payments/captures/9AB12345CD6789012/refund", { body: {}, requestId: "r" }).catch((e) => e);
    expect(err.message).toBe("PayPal 422 on POST /v2/payments/captures/:id/refund: REFUND_AMOUNT_EXCEEDED");
    expect(err.path).toBe("/v2/payments/captures/:id/refund");
    expect(JSON.stringify({ message: err.message, path: err.path })).not.toContain("9AB12345CD6789012");
    expect(err.message).not.toContain("debug-raw-99");
  });

  it("marks a refusal that follows an unanswered attempt, because that attempt may have acted", async () => {
    const s = scripted([new TypeError("network down"), fail(422)]);
    const err = await s.client.request("POST", "/v2/x", { requestId: "r1" }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PayPalApiError);
    expect((err as PayPalApiError).uncertain).toBe(true);
  });

  it("does not mark a refusal on the first attempt", async () => {
    const s = scripted([fail(422)]);
    const err = await s.client.request("POST", "/v2/x", { requestId: "r1" }).catch((e: unknown) => e);
    expect((err as PayPalApiError).uncertain).toBe(false);
  });

  it("does not count a token refresh as an unanswered attempt", async () => {
    const s = scripted([fail(401), fail(422)]);
    const err = await s.client.request("POST", "/v2/x", { requestId: "r1" }).catch((e: unknown) => e);
    expect((err as PayPalApiError).status).toBe(422);
    expect((err as PayPalApiError).uncertain).toBe(false);
  });

  it.each([
    ["/v2/payments/captures/ABCDEFGH/refund", "/v2/payments/captures/:id/refund"],
    ["/v2/payments/captures/ABCDEFGH", "/v2/payments/captures/:id"],
    ["/v2/payments/refunds/ABCDEFGH", "/v2/payments/refunds/:id"],
    ["/v2/checkout/orders/ABCDEFGH", "/v2/checkout/orders/:id"],
    ["/v1/reporting/transactions", "/v1/reporting/transactions"],
    ["/v1/customer/partners/ABCDEFGH/merchant-integrations", "/v1/customer/partners/:id/merchant-integrations"],
    ["/v1/customer/partners/ABCDEFGH/merchant-integrations/ABCDEFGH", "/v1/customer/partners/:id/merchant-integrations/:id"],
  ])("hides an id by where it sits, whatever it is made of: %s", (path, template) => {
    const err = new PayPalApiError(422, "GET", path);
    expect(err.path).toBe(template);
    expect(err.message).not.toContain("ABCDEFGH");
  });

  describe("a request with a last moment to begin", () => {
    afterEach(() => {
      vi.restoreAllMocks();
    });

    it("cuts a read that is still in flight at its abortAfter, instead of waiting out the 60 s timeout", async () => {
      const client = createPayPalClient({
        tokens: fakeTokens(),
        fetchImpl: ((_url: string, init?: RequestInit) =>
          new Promise((_resolve, reject) => init?.signal?.addEventListener("abort", () => reject(init.signal?.reason ?? new Error("aborted"))))) as typeof fetch,
      });
      const started = Date.now();
      const deadline = started + 80;
      await expect(client.request("GET", "/v1/reporting/transactions", { notAfter: deadline, abortAfter: deadline })).rejects.toThrow();
      expect(Date.now() - started).toBeLessThan(2_000);
    });

    it("sends nothing once that moment has passed", async () => {
      const s = scripted([ok({})]);
      await expect(s.client.request("POST", "/v2/x", { requestId: "r1", notAfter: Date.now() - 1 })).rejects.toThrow(/too late/);
      expect(s.calls).toHaveLength(0);
    });

    it("stops retrying once that moment has passed, and the outcome stays unknown", async () => {
      const replies: Reply[] = [new TypeError("network down"), ok({ id: "second" })];
      const s = scripted(replies);
      const start = Date.now();
      const notAfter = start + 1000;
      vi.spyOn(Date, "now").mockImplementation(() => (s.calls.length === 0 ? start : start + 5000));
      const err = await s.client.request("POST", "/v2/x", { requestId: "r1", notAfter }).catch((e: unknown) => e);
      expect(s.calls).toHaveLength(1);
      expect(err).toBeInstanceOf(Error);
      expect(err).not.toBeInstanceOf(PayPalApiError);
    });

    it("checks again after getting a token, because that can take a while too", async () => {
      const calls: string[] = [];
      const start = Date.now();
      const client = createPayPalClient({
        tokens: {
          get: async () => {
            vi.spyOn(Date, "now").mockReturnValue(start + 5000);
            return "t";
          },
          invalidate: () => {},
        },
        fetchImpl: (async (input: string) => {
          calls.push(String(input));
          return Response.json({});
        }) as unknown as typeof fetch,
        sleep: async () => {},
      });
      await expect(client.request("POST", "/v2/x", { requestId: "r1", notAfter: start + 1000 })).rejects.toThrow(/too late/);
      expect(calls).toEqual([]);
    });

    it("goes ahead while there is time", async () => {
      const s = scripted([ok({ id: "fine" })]);
      await expect(s.client.request("POST", "/v2/x", { requestId: "r1", notAfter: Date.now() + 60_000 })).resolves.toMatchObject({ data: { id: "fine" } });
    });
  });

  it("refuses a path that is not a PayPal API path", async () => {
    const s = scripted([]);
    await expect(s.client.request("GET", "https://evil.example/x")).rejects.toThrow(/path/);
    expect(s.calls).toHaveLength(0);
  });
});

describe("payPalClientFromEnv", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  // Measured 2026-11-05: `security ... -w | pbcopy` carries a newline, and PayPal answers 401 to it.
  it("drops whitespace around pasted credentials before asking PayPal for a token", async () => {
    const auth: (string | null)[] = [];
    vi.stubGlobal("fetch", async (_url: unknown, init?: RequestInit) => {
      auth.push(new Headers(init?.headers).get("Authorization"));
      return Response.json({ access_token: "t", expires_in: 3600 });
    });
    const client = payPalClientFromEnv({ PAYPAL_CLIENT_ID: "the-id\n", PAYPAL_CLIENT_SECRET: " the-secret \r\n" } as unknown as NodeJS.ProcessEnv);
    await client.request("GET", "/v2/payments/captures/CAP-1");
    expect(auth[0]).toBe(`Basic ${Buffer.from("the-id:the-secret").toString("base64")}`);
  });

  it("treats a value that is only whitespace as not set", () => {
    expect(() => payPalClientFromEnv({ PAYPAL_CLIENT_ID: "\n", PAYPAL_CLIENT_SECRET: "x" } as unknown as NodeJS.ProcessEnv)).toThrow(/must be set/);
  });
});
