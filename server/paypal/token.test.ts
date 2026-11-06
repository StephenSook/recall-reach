import { createServer } from "node:net";
import { inspect } from "node:util";
import { describe, expect, it } from "vitest";
import { createTokenProvider, PAYPAL_SANDBOX_BASE } from "./token";

const CLIENT_ID = "test-client-id";
const CLIENT_SECRET = "test-client-secret-value";

/** A token endpoint stand-in: each call returns the next token with the given lifetime. */
function tokenEndpoint(expiresIn = 32400, status = 200) {
  const calls: { url: string; auth: string | null; body: string }[] = [];
  const fetchImpl = async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({
      url: String(input),
      auth: new Headers(init?.headers).get("authorization"),
      body: String(init?.body),
    });
    if (status !== 200) return new Response(JSON.stringify({ error: "invalid_client" }), { status });
    return Response.json({ access_token: `token-${calls.length}`, token_type: "Bearer", expires_in: expiresIn });
  };
  return { calls, fetchImpl: fetchImpl as typeof fetch };
}

function clock(start = 1_000_000) {
  let t = start;
  return { now: () => t, advance: (ms: number) => (t += ms) };
}

describe("createTokenProvider", () => {
  it("asks the sandbox token endpoint with client credentials", async () => {
    const ep = tokenEndpoint();
    const tokens = createTokenProvider({ clientId: CLIENT_ID, clientSecret: CLIENT_SECRET, fetchImpl: ep.fetchImpl });
    expect(await tokens.get()).toBe("token-1");
    expect(ep.calls[0].url).toBe(`${PAYPAL_SANDBOX_BASE}/v1/oauth2/token`);
    expect(ep.calls[0].auth).toBe(`Basic ${Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString("base64")}`);
    expect(ep.calls[0].body).toBe("grant_type=client_credentials");
  });

  it("reuses the token until 60 seconds before it expires, then fetches a new one", async () => {
    const ep = tokenEndpoint(3600);
    const c = clock();
    const tokens = createTokenProvider({ clientId: CLIENT_ID, clientSecret: CLIENT_SECRET, fetchImpl: ep.fetchImpl, now: c.now });
    expect(await tokens.get()).toBe("token-1");
    c.advance((3600 - 61) * 1000);
    expect(await tokens.get()).toBe("token-1");
    c.advance(2000);
    expect(await tokens.get()).toBe("token-2");
    expect(ep.calls).toHaveLength(2);
  });

  it("shares one request between callers that ask at the same time", async () => {
    const ep = tokenEndpoint();
    const tokens = createTokenProvider({ clientId: CLIENT_ID, clientSecret: CLIENT_SECRET, fetchImpl: ep.fetchImpl });
    const got = await Promise.all([tokens.get(), tokens.get(), tokens.get()]);
    expect(got).toEqual(["token-1", "token-1", "token-1"]);
    expect(ep.calls).toHaveLength(1);
  });

  it("fetches a fresh token after invalidate (used when PayPal answers 401)", async () => {
    const ep = tokenEndpoint();
    const tokens = createTokenProvider({ clientId: CLIENT_ID, clientSecret: CLIENT_SECRET, fetchImpl: ep.fetchImpl });
    await tokens.get();
    tokens.invalidate();
    expect(await tokens.get()).toBe("token-2");
  });

  it("throws without the client secret in the message when PayPal refuses", async () => {
    const ep = tokenEndpoint(3600, 401);
    const tokens = createTokenProvider({ clientId: CLIENT_ID, clientSecret: CLIENT_SECRET, fetchImpl: ep.fetchImpl });
    const err = await tokens.get().then(
      () => null,
      (e: unknown) => e as Error,
    );
    expect(err?.message).toMatch(/HTTP 401/);
    expect(err?.message).not.toContain(CLIENT_SECRET);
  });

  it("does not cache a failed request", async () => {
    let fail = true;
    const fetchImpl = (async () => {
      if (fail) {
        fail = false;
        return new Response("down", { status: 503 });
      }
      return Response.json({ access_token: "token-ok", expires_in: 3600 });
    }) as unknown as typeof fetch;
    const tokens = createTokenProvider({ clientId: CLIENT_ID, clientSecret: CLIENT_SECRET, fetchImpl });
    await expect(tokens.get()).rejects.toThrow(/HTTP 503/);
    expect(await tokens.get()).toBe("token-ok");
  });

  it("holds no credentials in the error when Node's own fetch can't connect", async () => {
    const closedPort = await new Promise<number>((resolve) => {
      const server = createServer().listen(0, "127.0.0.1", () => {
        const { port } = server.address() as { port: number };
        server.close(() => resolve(port));
      });
    });
    const fetchImpl = ((_input: unknown, init?: RequestInit) => fetch(`http://127.0.0.1:${closedPort}/`, init)) as typeof fetch;
    const err = await createTokenProvider({ clientId: CLIENT_ID, clientSecret: CLIENT_SECRET, fetchImpl })
      .get()
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TypeError);
    const basic = Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString("base64");
    for (const printed of [String(err), inspect(err, { depth: 10, showHidden: true }), JSON.stringify(err)]) {
      for (const secret of [CLIENT_ID, CLIENT_SECRET, basic]) expect(printed).not.toContain(secret);
    }
  });
});
