import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fixture from "@/test/fixtures/paypal/refund-time-limit.json";
import { getDb } from "@/server/db/pg";
import { agentClientFromEnv } from "@/server/agent/claude";
import { POST } from "./route";

const clock = vi.hoisted(() => ({ now: 0 }));
// Read-only: a select on our refund records is the one query allowed; anything else throws.
const database = vi.hoisted(() => ({
  query: vi.fn(async (sql: string) => {
    if (!/^\s*select\b/i.test(sql) || /\b(insert|update|delete|alter|drop|truncate)\b/i.test(sql)) throw new Error("Only a select is allowed");
    return { rows: [{ capture_id: "OLD-CAPTURE" }] };
  }),
  exec: vi.fn(),
  transaction: vi.fn(),
}));
vi.mock("@/server/db/pg", () => ({ getDb: vi.fn(() => database) }));
vi.mock("@/server/agent/claude", () => ({ agentClientFromEnv: vi.fn() }));
vi.mock("@/server/web/rateLimit", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/server/web/rateLimit")>();
  return { ...actual, createRateLimiter: (opts: Parameters<typeof actual.createRateLimiter>[0]) => actual.createRateLimiter({ ...opts, now: () => clock.now }) };
});

const press = (ip = "203.0.113.1", headers: Record<string, string> = {}) => POST(new Request("http://localhost/api/judge/late-refund", {
  method: "POST", headers: { origin: "http://localhost", "true-client-ip": ip, ...headers },
}));

beforeEach(() => {
  clock.now += 3_600_001;
  vi.stubEnv("RENDER_EXTERNAL_URL", "");
  vi.stubEnv("PAYPAL_CLIENT_ID", "client");
  vi.stubEnv("PAYPAL_CLIENT_SECRET", "secret");
  vi.stubGlobal("fetch", vi.fn<typeof fetch>().mockImplementation(async (input) => {
    const url = String(input);
    if (url.endsWith("/token")) return Response.json({ access_token: "token", expires_in: 300 });
    if (url.endsWith("/refund")) return Response.json(fixture.body, { status: fixture.status });
    return Response.json({ status: "REFUNDED" });
  }));
});
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.clearAllMocks(); });

describe("POST /api/judge/late-refund", () => {
  it("returns PayPal's refusal after one read of our refund records, with no writes and no model", async () => {
    const answer = await press();
    expect(answer.status).toBe(200);
    expect(answer.headers.get("cache-control")).toBe("no-store");
    expect(await answer.json()).toMatchObject({ status: fixture.status, expected: true, details: fixture.body.details });
    expect(getDb).toHaveBeenCalled();
    expect(database.query).toHaveBeenCalledTimes(1);
    expect(String(database.query.mock.calls[0][0])).toMatch(/^\s*select\b[\s\S]*paypal_refund_refs[\s\S]*status = 'refunded'/i);
    expect(database.exec).not.toHaveBeenCalled();
    expect(database.transaction).not.toHaveBeenCalled();
    expect(agentClientFromEnv).not.toHaveBeenCalled();
  });

  it.each([null, "null", "https://other.example"])("refuses Origin %s before any network call", async (origin) => {
    const answer = await POST(new Request("http://localhost/api/judge/late-refund", { method: "POST", headers: origin === null ? {} : { origin } }));
    expect(answer.status).toBe(403);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("allows five presses per visitor and rejects the sixth without a network call", async () => {
    for (let i = 0; i < 5; i++) expect((await press()).status).toBe(200);
    vi.mocked(fetch).mockClear();
    const answer = await press("203.0.113.1", { "x-forwarded-for": "198.51.100.8" });
    expect(answer.status).toBe(429);
    expect(await answer.json()).toEqual({ error: "Too many tries. Try again in an hour." });
    expect(fetch).not.toHaveBeenCalled();
    clock.now += 3_600_001;
    expect((await press()).status).toBe(200);
  });

  it("allows sixty presses overall and rejects the sixty-first without a network call", async () => {
    for (let i = 1; i <= 60; i++) expect((await press(`192.0.2.${i}`)).status).toBe(200);
    vi.mocked(fetch).mockClear();
    expect((await press("192.0.2.61")).status).toBe(429);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("fails closed if the host cannot identify a visitor", async () => {
    vi.stubEnv("RENDER_EXTERNAL_URL", "https://recall.example");
    const answer = await POST(new Request("http://localhost/api/judge/late-refund", { method: "POST", headers: { origin: "https://recall.example" } }));
    expect(answer.status).toBe(429);
    expect(fetch).not.toHaveBeenCalled();
  });
});
