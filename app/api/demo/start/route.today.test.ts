import { afterEach, describe, expect, it, vi } from "vitest";

const seed = vi.hoisted(() => vi.fn(async () => ({ shopId: "00000000-0000-4000-8000-00000000000a" })));
vi.mock("@/server/demo/seed", () => ({ seedDemoShop: seed }));
vi.mock("@/server/db/pg", () => ({ getDb: () => ({}) }));
vi.mock("@/server/paypal/client", () => ({ payPalClientFromEnv: () => ({}) }));

import { POST } from "./route";

describe("POST /api/demo/start", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
  });

  it("dates the shop by the US day CPSC's dates use, not the UTC day already started", async () => {
    vi.useFakeTimers({ now: new Date("2026-11-06T01:15:00Z"), toFake: ["Date"] });
    vi.stubEnv("SHOP_DATA_KEY", "k".repeat(32));
    vi.stubEnv("SESSION_SECRET", "s".repeat(32));
    await POST(new Request("http://localhost/api/demo/start", { method: "POST", headers: { origin: "http://localhost", "true-client-ip": "192.0.2.1" } }));
    expect(seed).toHaveBeenCalledWith(expect.anything(), expect.anything(), expect.objectContaining({ today: "2026-11-05" }));
  });
});
