import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { testDb } from "../../test/pglite";
import { migrate } from "../db/migrate";
import { loadMissingYears, loadYears, missingRecallYears, recallCountsByYear, yearRange } from "./load";

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

  describe("loadMissingYears", () => {
    const answering = (body: (url: string) => string | number) => {
      const requested: string[] = [];
      const fetchImpl = async (url: string | URL | Request) => {
        requested.push(String(url));
        const answer = body(String(url));
        return typeof answer === "number" ? new Response("no", { status: answer }) : new Response(answer, { status: 200, headers: { "content-type": "application/json" } });
      };
      return { requested, deps: { fetchImpl: fetchImpl as typeof fetch, sleep: async () => {} } };
    };
    /** One real record, dated inside whichever year was asked for. */
    const real = JSON.parse(readFileSync(new URL("../../test/fixtures/cpsc/recall_22200.json", import.meta.url), "utf8"))[0];
    const aRecallForTheYear = (url: string) => {
      const year = Number(/RecallDateStart=(\d{4})/.exec(url)?.[1]);
      const date = `${year}-08-15T00:00:00`;
      return JSON.stringify([{ ...real, RecallID: year, RecallNumber: String(year), RecallDate: date, LastPublishDate: date }]);
    };
    const TODAY = "2024-11-05"; // so the years from 2022 are 2022, 2023 and the running 2024

    it("pulls each year it has no finished pull for, the running year up to today", async () => {
      expect(await missingRecallYears(db, 2022, TODAY)).toEqual([2022, 2023, 2024]);
      const { requested, deps } = answering(aRecallForTheYear);
      const result = await loadMissingYears(db, 2022, TODAY, deps);
      expect(requested).toHaveLength(3);
      expect(result.failed).toEqual([]);
      expect(result.pulls.map((p) => p.range.start)).toEqual(["2022-01-01", "2023-01-01", "2024-01-01"]);
      expect(result.pulls.at(-1)?.range.end).toBe(TODAY);
      expect(await missingRecallYears(db, 2022, TODAY)).toEqual([]);
    });

    describe("the running year", () => {
      const held = (start: string, end: string) => db.query("insert into cpsc_pulls (range_field, range_start, range_end, status, fetched) values ('RecallDate', $1, $2, 'ok', 1)", [start, end]);
      const polled = (start: string, end: string, status = "ok") => db.query("insert into cpsc_pulls (range_field, range_start, range_end, status, fetched) values ('LastPublishDate', $1, $2, $3, 0)", [start, end, status]);
      const missing = () => missingRecallYears(db, 2024, TODAY);

      it("isn't held by a pull that doesn't start on its first day", async () => {
        await held("2024-10-01", "2024-11-05");
        expect(await missing()).toEqual([2024]);
      });

      it("is held by a pull from its first day that reaches today", async () => {
        await held("2024-01-01", TODAY);
        expect(await missing()).toEqual([]);
      });

      it("isn't held when that pull stopped months ago and nothing carried on from there", async () => {
        await held("2024-01-01", "2024-06-01");
        expect(await missing()).toEqual([2024]);
      });

      it("isn't held when the poll starts months after that pull stopped: the months between are a gap", async () => {
        await held("2024-01-01", "2024-06-01");
        await polled("2024-11-04", TODAY);
        expect(await missing()).toEqual([2024]);
      });

      it("is held once a catch-up closes the gap, in any order the rows arrived", async () => {
        await held("2024-01-01", "2024-06-01");
        await polled("2024-11-04", TODAY);
        await polled("2024-05-31", "2024-11-04");
        expect(await missing()).toEqual([]);
      });

      it.each(["failed", "partial"])("isn't carried forward by a poll that %s: a recall it rejected isn't held", async (status) => {
        await held("2024-01-01", "2024-06-01");
        await polled("2024-05-31", TODAY, status);
        expect(await missing()).toEqual([2024]);
      });

      it("stays held through a few quiet days, and stops once the poll is well behind", async () => {
        await held("2024-01-01", "2024-11-02");
        expect(await missing()).toEqual([]);
        expect(await missingRecallYears(db, 2024, "2024-11-06")).toEqual([2024]);
      });
    });

    it("costs nothing once they are in", async () => {
      await loadMissingYears(db, 2022, TODAY, answering(aRecallForTheYear).deps);
      const again = answering(aRecallForTheYear);
      expect(await loadMissingYears(db, 2022, TODAY, again.deps)).toEqual({ pulls: [], failed: [], deferred: [] });
      expect(again.requested).toEqual([]);
    });

    it("keeps going when one year fails, says which, and tries only that year again", async () => {
      const first = answering((url) => (url.includes("RecallDateStart=2022") ? 500 : aRecallForTheYear(url)));
      const result = await loadMissingYears(db, 2022, TODAY, first.deps);
      expect(result.failed.map((f) => f.year)).toEqual([2022]);
      expect(result.pulls.map((p) => p.range.start)).toEqual(["2023-01-01", "2024-01-01"]);
      expect(await missingRecallYears(db, 2022, TODAY)).toEqual([2022]);

      const second = answering(aRecallForTheYear);
      await loadMissingYears(db, 2022, TODAY, second.deps);
      expect(second.requested).toHaveLength(1);
      expect(await missingRecallYears(db, 2022, TODAY)).toEqual([]);
    });

    it("starts no new year once its time is up, and the rest wait for next time", async () => {
      const { requested, deps } = answering(aRecallForTheYear);
      expect(await loadMissingYears(db, 2022, TODAY, deps, { budgetMs: -1 })).toEqual({ pulls: [], failed: [], deferred: [2022, 2023, 2024] });
      expect(requested).toEqual([]);
      expect(await missingRecallYears(db, 2022, TODAY)).toEqual([2022, 2023, 2024]);
    });

    it("doesn't take a poll's pull, or a failed one, for a year being loaded", async () => {
      // Neither of these loads a year.
      await db.query("insert into cpsc_pulls (range_field, range_start, range_end, status, fetched) values ('LastPublishDate', '2022-01-01', '2022-12-31', 'ok', 5), ('RecallDate', '2022-01-01', '2022-12-31', 'failed', 5), ('RecallDate', '2022-01-01', '2022-12-31', 'partial', 5)");
      expect(await missingRecallYears(db, 2022, TODAY)).toEqual([2022, 2023, 2024]);
    });

    it("doesn't take an empty answer for a whole year as that year being loaded: it says so and tries again", async () => {
      const result = await loadMissingYears(db, 2023, TODAY, answering(() => "[]").deps);
      expect(result.failed).toEqual([
        { year: 2023, error: "CPSC returned no recalls for this year" },
        { year: 2024, error: "CPSC returned no recalls for this year" },
      ]);
      expect(await missingRecallYears(db, 2023, TODAY)).toEqual([2023, 2024]);
    });
  });
});
