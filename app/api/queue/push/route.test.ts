import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const session = vi.hoisted(() => ({ current: null as { shopId: string; sessionId: string } | null }));
vi.mock("@/server/web/http", async (original) => ({ ...(await original<typeof import("@/server/web/http")>()), currentSession: async () => session.current }));
vi.mock("@/server/db/pg", () => ({ getDb: () => ({}) }));
const register = vi.hoisted(() => vi.fn());
vi.mock("@/server/push/push", () => ({ registerPushToken: register }));

import { POST } from "./route";

const TOKEN = "ExponentPushToken[abc]";
const post = (over: { origin?: string; body?: string } = {}) =>
  POST(new Request("http://localhost/api/queue/push", { method: "POST", headers: { origin: over.origin ?? "http://localhost", "content-type": "application/x-www-form-urlencoded" }, body: over.body ?? new URLSearchParams({ token: TOKEN }).toString() }));

describe("POST /api/queue/push", () => {
  beforeEach(() => {
    session.current = { shopId: "shop-1", sessionId: "s" };
    register.mockReset();
    register.mockResolvedValue(true);
  });
  afterEach(() => vi.restoreAllMocks());

  it("ties the token to this session's shop, and to no other it's told about", async () => {
    const res = await post({ body: new URLSearchParams({ token: TOKEN, shopId: "someone-elses" }).toString() });
    expect(res.status).toBe(204);
    expect(register).toHaveBeenCalledWith(expect.anything(), "shop-1", TOKEN);
  });

  it("needs a shop's session", async () => {
    session.current = null;
    expect((await post()).status).toBe(401);
    expect(register).not.toHaveBeenCalled();
  });

  it("must come from a page on this site", async () => {
    expect((await post({ origin: "https://elsewhere.example" })).status).toBe(401);
    expect(register).not.toHaveBeenCalled();
  });

  it("refuses what isn't a push token", async () => {
    register.mockResolvedValue(false);
    expect((await post({ body: "token=nonsense" })).status).toBe(400);
  });

  it("refuses a body far too long to hold one, without reading it", async () => {
    expect((await post({ body: `token=${TOKEN}&more=${"x".repeat(1000)}` })).status).toBe(400);
    expect(register).not.toHaveBeenCalled();
  });

  it("logs no token when the database fails", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    register.mockRejectedValue(new Error(`failed on ${TOKEN}`));
    expect((await post()).status).toBe(503);
    expect(JSON.stringify(logged.mock.calls)).not.toContain("abc");
  });
});
