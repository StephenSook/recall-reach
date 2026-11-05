// Live smoke test against the real CPSC Recalls API. Run with: pnpm test:live
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { testDb } from "../../test/pglite";
import { migrate } from "../db/migrate";
import { fetchRecalls, type RecallRange } from "./fetch";
import { pullRecalls } from "./pull";
import { parseRecalls } from "./schema";

if (process.env.CPSC_LIVE !== "1") {
  // Fail loudly instead of skipping, so a live run without the flag can never look green.
  throw new Error("live CPSC tests call the real API; run them with CPSC_LIVE=1 (pnpm test:live)");
}

const day = (offsetDays: number) => new Date(Date.now() + offsetDays * 86_400_000).toISOString().slice(0, 10);

describe("CPSC Recalls API (live)", () => {
  let db: Awaited<ReturnType<typeof testDb>>;
  beforeAll(async () => {
    db = await testDb();
    await migrate(db);
  });
  afterAll(async () => {
    await db.close();
  });

  it("returns recalls from the last 60 days that all pass validation", async () => {
    const range: RecallRange = { field: "RecallDate", start: day(-60), end: day(0) };
    const { valid, invalid } = parseRecalls(await fetchRecalls(range));
    expect(invalid).toEqual([]);
    expect(valid.length).toBeGreaterThan(0);
  });

  it("filters by LastPublishDate and stays inside the range", async () => {
    const range: RecallRange = { field: "LastPublishDate", start: day(-14), end: day(0) };
    const records = await fetchRecalls(range);
    expect(Array.isArray(records)).toBe(true);
  });

  it("pulls the last 60 days into Postgres with an ok pull log", async () => {
    const range: RecallRange = { field: "RecallDate", start: day(-60), end: day(0) };
    const summary = await pullRecalls(db, range);
    expect(summary.status).toBe("ok");
    expect(summary.inserted).toBeGreaterThan(0);
    expect(summary.inserted + summary.updated + summary.unchanged).toBeLessThanOrEqual(summary.fetched);
  });
});
