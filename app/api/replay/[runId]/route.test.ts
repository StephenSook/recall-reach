import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/server/db/pg", () => ({ getDb: () => ({}) }));
const load = vi.hoisted(() => vi.fn());
vi.mock("@/server/replay/replay", () => ({ loadReplay: load }));

import { GET } from "./route";

const get = (runId: string) => GET(new Request(`http://localhost/api/replay/${runId}`), { params: Promise.resolve({ runId }) });

describe("GET /api/replay/{runId}", () => {
  afterEach(() => load.mockReset());

  it("gives the run, with no key", async () => {
    load.mockResolvedValue({ runId: "r", rows: [] });
    const res = await get("r");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ runId: "r", rows: [] });
  });

  it("says when there's no such run", async () => {
    load.mockResolvedValue(null);
    expect((await get("missing")).status).toBe(404);
  });
});
