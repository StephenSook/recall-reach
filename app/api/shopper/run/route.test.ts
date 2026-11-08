import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { migrate } from "@/server/db/migrate";
import type { Queryable } from "@/server/db/types";
import { latestExampleRun } from "@/server/shopper/exampleRuns";
import { testDb } from "@/test/pglite";

let db: Queryable;
const paths = vi.hoisted(() => ({ run: vi.fn() }));
vi.mock("@/server/db/pg", () => ({ getDb: () => db }));
vi.mock("@/server/agent/claude", async (original) => ({ ...(await original<typeof import("@/server/agent/claude")>()), agentClientFromEnv: () => ({}) }));
vi.mock("@/server/agent/shopper", async (original) => ({ ...(await original<typeof import("@/server/agent/shopper")>()), runShopper: paths.run }));
vi.mock("@/server/sweep/channel3", () => ({ channel3Listings: () => ({ search: async () => [] }) }));

import { POST } from "./route";

const ORIGIN = "http://localhost";
let ip = 0;
const post = (ask: string, budget: number) =>
  POST(new Request(`${ORIGIN}/api/shopper/run`, { method: "POST", headers: { "content-type": "application/json", origin: ORIGIN, "true-client-ip": `203.0.113.${++ip}` }, body: JSON.stringify({ ask, budget }) }));
const LISTING = { id: "L1", title: "Wooden high chair", brand: "Plan Toys", priceCents: 14900, currency: "USD", url: "https://example.com/chair", source: "a shop" };
const picked = {
  outcome: "PICKED",
  steps: [{ kind: "search", query: "high chair", found: 3, inBudget: 2 }],
  blocked: [],
  pick: { listing: LISTING, recallsChecked: 934, from: "a shop", similar: 0 },
  models: ["claude-sonnet-5-5"],
};

describe("POST /api/shopper/run", () => {
  let real: Awaited<ReturnType<typeof testDb>>;
  beforeEach(async () => {
    real = await testDb();
    await migrate(real);
    db = real;
    paths.run.mockReset();
    paths.run.mockResolvedValue(picked);
  });
  afterEach(async () => {
    await real.close();
  });

  it("records a run of one of the page's examples, with its models and its offer", async () => {
    expect((await post("A high chair", 200)).status).toBe(200);
    expect(await latestExampleRun(db)).toMatchObject({ ask: "A high chair", models: ["claude-sonnet-5-5"], pick: { title: "Wooden high chair", priceCents: 14900 }, slipId: expect.any(String), paidAt: null });
  });

  it("records nothing a visitor typed themselves", async () => {
    expect((await post("A high chair for Jo", 200)).status).toBe(200);
    expect(await latestExampleRun(db)).toBeNull();
  });
});
