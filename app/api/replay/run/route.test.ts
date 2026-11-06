import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/server/db/pg", () => ({ getDb: () => ({}) }));
vi.mock("@/server/paypal/client", () => ({ payPalClientFromEnv: () => ({}) }));
const run = vi.hoisted(() => vi.fn());
vi.mock("@/server/replay/replay", () => ({ runReplay: run }));

import { POST } from "./route";

const post = (origin = "http://localhost") => POST(new Request("http://localhost/api/replay/run", { method: "POST", headers: { origin } }));

describe("POST /api/replay/run", () => {
  beforeEach(() => {
    vi.stubEnv("SHOP_DATA_KEY", "k".repeat(32));
    vi.spyOn(console, "error").mockImplementation(() => {});
    run.mockReset();
    run.mockResolvedValue({ runId: "run-1" });
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("refuses a post from another site", async () => {
    expect((await post("https://elsewhere.example")).status).toBe(403);
    expect(run).not.toHaveBeenCalled();
  });

  it("goes to the run it made", async () => {
    expect((await post()).headers.get("location")).toBe("http://localhost/replay/run-1");
  });

  it("says it failed, without saying why", async () => {
    run.mockRejectedValue(new Error("detail"));
    expect((await post()).headers.get("location")).toBe("http://localhost/replay?error=failed");
  });

  it("limits how often it can run for everyone together", async () => {
    let last = await post();
    for (let i = 0; i < 12; i++) last = await post();
    expect(last.headers.get("location")).toBe("http://localhost/replay?error=busy");
  });
});
