import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const session = vi.hoisted(() => ({ current: null as { shopId: string; sessionId: string } | null }));
vi.mock("@/server/web/http", async (original) => ({ ...(await original<typeof import("@/server/web/http")>()), currentSession: async () => session.current }));
vi.mock("@/server/db/pg", () => ({ getDb: () => ({}) }));
const check = vi.hoisted(() => vi.fn());
vi.mock("@/server/agent/checkRecord", () => ({ checkRecordWithClaude: check }));

import { POST } from "./route";

const post = (headers: Record<string, string> = { origin: "http://localhost" }) => {
  const body = new FormData();
  body.set("recordId", "00000000-0000-4000-8000-000000000001");
  return POST(new Request("http://localhost/api/queue/agent", { method: "POST", headers, body }));
};
const message = (res: Response) => new URL(res.headers.get("location") ?? "").searchParams.get("message");

describe("POST /api/queue/agent", () => {
  beforeEach(() => {
    session.current = { shopId: `shop-${Math.random()}`, sessionId: "s" };
    vi.stubEnv("ANTHROPIC_API_KEY", "key");
    vi.spyOn(console, "error").mockImplementation(() => {});
    check.mockReset();
    check.mockResolvedValue({ unavailable: false, overBudget: false, failedStatuses: [] });
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("refuses with no session", async () => {
    session.current = null;
    expect((await post()).status).toBe(401);
    expect(check).not.toHaveBeenCalled();
  });

  it("refuses a post from another site", async () => {
    expect((await post({ origin: "https://elsewhere.example" })).status).toBe(401);
    expect(check).not.toHaveBeenCalled();
  });

  it("goes back to the queue when it worked", async () => {
    const res = await post();
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("http://localhost/queue");
    expect(check).toHaveBeenCalledWith(expect.anything(), expect.anything(), expect.objectContaining({ shopId: session.current?.shopId, recordId: "00000000-0000-4000-8000-000000000001" }));
  });

  it("says Claude is unavailable with no key, and makes no call", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "");
    expect(message(await post())).toBe("Claude check unavailable. Everything else still works.");
    expect(check).not.toHaveBeenCalled();
  });

  it("says the same when the key is refused, and logs only the status", async () => {
    check.mockResolvedValue({ unavailable: true, overBudget: false, failedStatuses: [401] });
    expect(message(await post())).toBe("Claude check unavailable. Everything else still works.");
    expect(vi.mocked(console.error).mock.calls.flat().join(" ")).toContain("401");
  });

  it("says when the day's limit is reached", async () => {
    check.mockResolvedValue({ unavailable: false, overBudget: true, failedStatuses: [] });
    expect(message(await post())).toBe("Claude check has reached today's limit. Everything else still works.");
  });

  it("limits how often one shop can ask", async () => {
    let last = await post();
    for (let i = 0; i < 30; i++) last = await post();
    expect(message(last)).toBe("Too many checks. Try again in a while.");
  });
});
