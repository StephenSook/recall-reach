import { afterEach, describe, expect, it, vi } from "vitest";

const proveReplay = vi.fn();
vi.mock("@/server/db/pg", () => ({ getDb: () => ({}) }));
vi.mock("@/server/replay/replay", () => ({ proveReplay: (...args: unknown[]) => proveReplay(...args) }));

import { GET } from "./route";

const ask = (runId: string) => GET(new Request("http://x/"), { params: Promise.resolve({ runId }) });
const PROOF = { runId: "r1", ranAt: "2026-11-06T00:00:00.000Z", stored: { checked: 934 }, recomputed: { checked: 934 }, agree: true, sameRecalls: true };

describe("GET /api/proof/{runId}", () => {
  afterEach(() => proveReplay.mockReset());

  it("can be read by a person: indented, with whether the numbers agree first", async () => {
    proveReplay.mockResolvedValue(PROOF);
    const res = await ask("r1");
    const text = await res.text();
    expect(text.startsWith('{\n  "agree": true,\n  "sameRecalls": true,\n')).toBe(true);
    expect(res.headers.get("content-type")).toContain("application/json");
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  it("holds the same answer as before", async () => {
    proveReplay.mockResolvedValue(PROOF);
    expect(await (await ask("r1")).json()).toEqual(PROOF);
  });

  it("says so when there is no such run", async () => {
    proveReplay.mockResolvedValue(null);
    const res = await ask("nope");
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "no such run" });
  });
});
