import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const session = vi.hoisted(() => ({ current: null as { shopId: string; sessionId: string } | null }));
vi.mock("@/server/web/http", async (original) => ({ ...(await original<typeof import("@/server/web/http")>()), currentSession: async () => session.current }));
vi.mock("@/server/db/pg", () => ({ getDb: () => ({}) }));
const prepare = vi.hoisted(() => vi.fn());
vi.mock("@/server/notice/store", async (original) => ({ ...(await original<typeof import("@/server/notice/store")>()), prepareNotice: prepare }));

import { NoticeRefused } from "@/server/notice/store";
import { POST } from "./route";

const post = (...ids: string[]) => {
  const body = new FormData();
  for (const id of ids) body.append("matchId", id);
  return POST(new Request("http://localhost/api/queue/notices", { method: "POST", headers: { origin: "http://localhost" }, body }));
};
const message = (res: Response) => new URL(res.headers.get("location") ?? "").searchParams.get("message");

describe("POST /api/queue/notices", () => {
  beforeEach(() => {
    session.current = { shopId: "shop", sessionId: "s" };
    prepare.mockReset();
    prepare.mockResolvedValue({ noticeId: "n", kind: "CHECK_REQUEST" });
  });
  afterEach(() => vi.restoreAllMocks());

  it("approves one", async () => {
    const res = await post("a");
    expect(res.headers.get("location")).toBe("http://localhost/queue");
    expect(prepare).toHaveBeenCalledWith(expect.anything(), { shopId: "shop", matchId: "a" });
  });

  it("approves each one selected, for this shop only", async () => {
    await post("a", "b", "c");
    expect(prepare.mock.calls.map((c) => c[1])).toEqual(["a", "b", "c"].map((matchId) => ({ shopId: "shop", matchId })));
  });

  it("still approves the rest when one is refused, and says which reason", async () => {
    prepare.mockImplementation(async (_db: unknown, input: { matchId: string }) => {
      if (input.matchId === "b") throw new NoticeRefused("ALREADY_ASKED", "This sale already has a message. One sale gets one question.");
      return { noticeId: "n", kind: "CHECK_REQUEST" };
    });
    const res = await post("a", "b", "c");
    expect(prepare).toHaveBeenCalledTimes(3);
    expect(message(res)).toBe("This sale already has a message. One sale gets one question.");
  });

  it("does nothing with no selection", async () => {
    const res = await post();
    expect(prepare).not.toHaveBeenCalled();
    expect(res.headers.get("location")).toBe("http://localhost/queue");
  });

  it("refuses more than a page's worth at once", async () => {
    await post(...Array.from({ length: 51 }, (_, i) => `m${i}`));
    expect(prepare).not.toHaveBeenCalled();
  });

  it("does not hide a failure that is not a refusal", async () => {
    prepare.mockRejectedValue(new Error("database down"));
    await expect(post("a")).rejects.toThrow("database down");
  });
});
