import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/server/db/pg", () => ({ getDb: () => ({}) }));
const record = vi.hoisted(() => vi.fn());
vi.mock("@/server/match/sellerAnswers", () => ({ recordSellerAnswer: record }));
const session = vi.hoisted(() => vi.fn());
vi.mock("@/server/web/http", async (real) => ({ ...(await real<typeof import("@/server/web/http")>()), currentSession: session, fromThisSite: (r: Request) => r.headers.get("origin") === "https://site.test" }));

import { POST } from "./route";

const MATCH = "00000000-0000-4000-8000-000000000001";
const post = (body: string, origin = "https://site.test") =>
  POST(new Request("https://site.test/api/queue/answers", { method: "POST", body, headers: { origin, "content-type": "application/x-www-form-urlencoded" } }));

describe("POST /api/queue/answers", () => {
  afterEach(() => {
    record.mockReset();
    session.mockReset();
  });

  it("saves it for the signed-in shop and goes back to that card, open", async () => {
    session.mockResolvedValue({ shopId: "shop-1", sessionId: "s" });
    record.mockResolvedValue(true);
    const res = await post(`matchId=${MATCH}&answer=DIFFERENT_PRODUCT`);
    expect(record).toHaveBeenCalledWith({}, { shopId: "shop-1", matchId: MATCH, answer: "DIFFERENT_PRODUCT" });
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toMatch(new RegExp(`/queue\\?answered=${MATCH}#sale-${MATCH}$`));
  });

  it("wants a session", async () => {
    session.mockResolvedValue(null);
    expect((await post(`matchId=${MATCH}&answer=SAME_PRODUCT`)).status).toBe(401);
    expect(record).not.toHaveBeenCalled();
  });

  it("wants it to come from this site", async () => {
    session.mockResolvedValue({ shopId: "shop-1", sessionId: "s" });
    expect((await post(`matchId=${MATCH}&answer=SAME_PRODUCT`, "https://elsewhere.test")).status).toBe(401);
    expect(record).not.toHaveBeenCalled();
  });

  it("says no to what it can't save, and doesn't send the browser anywhere it named", async () => {
    session.mockResolvedValue({ shopId: "shop-1", sessionId: "s" });
    record.mockResolvedValue(false);
    const res = await post("matchId=https://elsewhere.test&answer=SAME_PRODUCT");
    expect(res.status).toBe(400);
    expect(res.headers.get("location")).toBeNull();
  });

  it("refuses a long body without reading on", async () => {
    session.mockResolvedValue({ shopId: "shop-1", sessionId: "s" });
    expect((await post(`matchId=${"x".repeat(2000)}`)).status).toBe(400);
    expect(record).not.toHaveBeenCalled();
  });

  it("says try again if the database fails", async () => {
    session.mockResolvedValue({ shopId: "shop-1", sessionId: "s" });
    record.mockRejectedValue(new Error("down"));
    expect((await post(`matchId=${MATCH}&answer=SAME_PRODUCT`)).status).toBe(503);
  });
});
