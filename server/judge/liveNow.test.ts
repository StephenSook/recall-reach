import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { testDb } from "../../test/pglite";
import { pullRecalls } from "../cpsc/pull";
import { migrate } from "../db/migrate";
import { liveNowLine, newestRecall } from "./liveNow";

const NOW = new Date("2026-11-08T21:30:00Z");
const fixture = readFileSync(new URL("../../test/fixtures/cpsc/recalls_2026-10-01_to_2026-11-05.json", import.meta.url), "utf8");

describe("the judge page's live line", () => {
  it("says when the check ran and the newest recall held", () => {
    expect(liveNowLine({ checkedAt: "2026-11-08T21:16:00Z", newest: { recallNumber: "27072", recallDate: "2026-11-05" }, now: NOW })).toBe(
      "Last CPSC check 14 minutes ago. Newest recall held: 27072, from Nov 5, 2026.",
    );
  });

  it("says just now, and one minute in the singular", () => {
    const newest = { recallNumber: "27072", recallDate: "2026-11-05" };
    expect(liveNowLine({ checkedAt: "2026-11-08T21:29:40Z", newest, now: NOW })).toContain("Last CPSC check just now.");
    expect(liveNowLine({ checkedAt: "2026-11-08T21:29:00Z", newest, now: NOW })).toContain("Last CPSC check 1 minute ago.");
  });

  it("counts hours past an hour", () => {
    const newest = { recallNumber: "27072", recallDate: "2026-11-05" };
    expect(liveNowLine({ checkedAt: "2026-11-08T19:20:00Z", newest, now: NOW })).toContain("Last CPSC check 2 hours ago.");
  });

  it("says not yet when there's nothing to report, and invents nothing", () => {
    expect(liveNowLine({ checkedAt: null, newest: null, now: NOW })).toBe("Last CPSC check: not yet.");
    expect(liveNowLine({ checkedAt: "2026-11-08T21:16:00Z", newest: null, now: NOW })).toBe("Last CPSC check 14 minutes ago. Newest recall held: not yet.");
    expect(liveNowLine({ checkedAt: null, newest: { recallNumber: "27072", recallDate: "2026-11-05" }, now: NOW })).toBe("Last CPSC check: not yet. Newest recall held: 27072, from Nov 5, 2026.");
  });

  describe("reading real rows", () => {
    let db: Awaited<ReturnType<typeof testDb>>;
    beforeEach(async () => {
      db = await testDb();
      await migrate(db);
    });
    afterEach(async () => {
      await db.close();
    });

    it("finds none in an empty table", async () => {
      expect(await newestRecall(db)).toBeNull();
    });

    it("finds the latest by CPSC's own date", async () => {
      const fetchImpl = async () => new Response(fixture, { status: 200, headers: { "content-type": "application/json" } });
      await pullRecalls(db, { field: "RecallDate", start: "2026-10-01", end: "2026-11-05" }, { fetchImpl: fetchImpl as typeof fetch });
      const { rows } = await db.query<{ d: string }>("select max(recall_date)::text as d from recalls");
      expect(await newestRecall(db)).toMatchObject({ recallDate: rows[0].d });
    });
  });
});
