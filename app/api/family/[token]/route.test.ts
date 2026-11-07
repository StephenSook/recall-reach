import { beforeEach, describe, expect, it, vi } from "vitest";

const paths = vi.hoisted(() => ({ stopped: vi.fn(), passedOn: vi.fn(), answer: vi.fn() }));
vi.mock("@/server/db/pg", () => ({ getDb: () => ({}) }));
vi.mock("@/server/notice/token", () => ({ noticeIdFromToken: (_s: string, t: string) => (t === "good" ? "notice-1" : null) }));
vi.mock("@/server/notice/store", async (original) => ({
  ...(await original<typeof import("@/server/notice/store")>()),
  recordFamilyStopped: paths.stopped,
  recordFamilyPassedOn: paths.passedOn,
  recordFamilyAnswer: paths.answer,
}));
vi.mock("@/server/web/http", async (original) => ({ ...(await original<typeof import("@/server/web/http")>()), secret: () => "s" }));

import { POST } from "./route";

const press = (fields: Record<string, string>, token = "good") =>
  POST(new Request(`http://localhost/api/family/${token}`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(fields) }), { params: Promise.resolve({ token }) });

describe("POST /api/family/[token]", () => {
  beforeEach(() => {
    for (const fn of Object.values(paths)) fn.mockReset();
  });

  it("records that they passed it on, and goes back to where they tapped", async () => {
    const res = await press({ action: "passed_on" });
    expect(paths.passedOn).toHaveBeenCalledWith(expect.anything(), "notice-1");
    expect(paths.answer).not.toHaveBeenCalled();
    expect(paths.stopped).not.toHaveBeenCalled();
    expect(res.headers.get("location")).toMatch(/\/r\/good#passed-on$/);
  });

  it("still records that they stopped using it", async () => {
    const res = await press({ action: "stopped" });
    expect(paths.stopped).toHaveBeenCalledOnce();
    expect(res.headers.get("location")).toMatch(/\/r\/good#stopped$/);
  });

  it("refuses a link that isn't one", async () => {
    expect((await press({ action: "passed_on" }, "bad")).status).toBe(404);
    expect(paths.passedOn).not.toHaveBeenCalled();
  });
});
