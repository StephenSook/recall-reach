import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { testDb } from "../../test/pglite";
import { migrate } from "../db/migrate";
import { loadYears, recallCountsByYear, yearRange } from "./load";

const fixtureText = readFileSync(
  new URL("../../test/fixtures/cpsc/recalls_2026-10-01_to_2026-11-05.json", import.meta.url),
  "utf8",
);

describe("yearRange", () => {
  it("covers a whole past year", () => {
    expect(yearRange(2025, "2026-11-05")).toEqual({ field: "RecallDate", start: "2025-01-01", end: "2025-12-31" });
  });

  it("stops the current year at today", () => {
    expect(yearRange(2026, "2026-11-05")).toEqual({ field: "RecallDate", start: "2026-01-01", end: "2026-11-05" });
  });

  it("refuses a year that has not started", () => {
    expect(() => yearRange(2027, "2026-11-05")).toThrow(/2027/);
  });
});

describe("loadYears", () => {
  let db: Awaited<ReturnType<typeof testDb>>;
  beforeEach(async () => {
    db = await testDb();
    await migrate(db);
  });
  afterEach(async () => {
    await db.close();
  });

  it("pulls each year and reports recall counts by recall year", async () => {
    const requested: string[] = [];
    const fetchImpl = async (url: string | URL | Request) => {
      requested.push(String(url));
      // The fixture holds Oct-Nov 2026 recalls: the 2026 range gets them, 2025 gets none.
      const body = String(url).includes("RecallDateStart=2026") ? fixtureText : "[]";
      return new Response(body, { status: 200, headers: { "content-type": "application/json" } });
    };
    const result = await loadYears(db, [2025, 2026], "2026-11-05", { fetchImpl: fetchImpl as typeof fetch });
    expect(requested).toHaveLength(2);
    expect(result.pulls.map((p) => [p.range.start, p.range.end, p.status, p.inserted])).toEqual([
      ["2025-01-01", "2025-12-31", "ok", 0],
      ["2026-01-01", "2026-11-05", "ok", 55],
    ]);
    expect(result.countsByYear).toEqual({ 2026: 55 });
    expect(await recallCountsByYear(db)).toEqual({ 2026: 55 });
  });
});
