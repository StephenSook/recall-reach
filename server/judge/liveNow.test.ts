import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { testDb } from "../../test/pglite";
import { pullRecalls } from "../cpsc/pull";
import { migrate } from "../db/migrate";
import type { Queryable } from "../db/types";
import { createHeldReading, liveNowLine, readHeld } from "./liveNow";

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
      expect(await readHeld(db)).toEqual({ newest: null, written: null });
    });

    it("asks in one statement, so it takes one connection", async () => {
      const query = vi.spyOn(db, "query");
      await readHeld(db);
      expect(query).toHaveBeenCalledTimes(1);
    });

    it("finds the latest by CPSC's own date", async () => {
      const fetchImpl = async () => new Response(fixture, { status: 200, headers: { "content-type": "application/json" } });
      await pullRecalls(db, { field: "RecallDate", start: "2026-10-01", end: "2026-11-05" }, { fetchImpl: fetchImpl as typeof fetch });
      const { rows } = await db.query<{ d: string }>("select max(recall_date)::text as d from recalls");
      expect((await readHeld(db)).newest).toMatchObject({ recallDate: rows[0].d });
    });

    it("reports the last good pull and ignores a failed one", async () => {
      await db.query("insert into cpsc_pulls (range_field, range_start, range_end, status, finished_at) values ('LastPublishDate', '2026-11-05', '2026-11-06', 'ok', '2026-11-08T20:00:00Z'), ('LastPublishDate', '2026-11-06', '2026-11-07', 'failed', '2026-11-08T21:00:00Z')");
      expect((await readHeld(db)).written).toBe("2026-11-08T20:00:00.000Z");
    });
  });

  describe("holding the reading, so visits to the page don't reach the database", () => {
    const stored = { newest: null, written: null };
    const fake = (query: () => Promise<{ rows: unknown[] }>) => ({ query: vi.fn(query) }) as unknown as Queryable & { query: ReturnType<typeof vi.fn> };
    const answers = () => fake(async () => ({ rows: [{ recall_number: null, recall_date: null, written: null }] }));

    it("shares one read among visits at the same moment", async () => {
      const db = answers();
      const held = createHeldReading(60_000);
      await expect(Promise.all([held(db, 0), held(db, 0), held(db, 0)])).resolves.toEqual([stored, stored, stored]);
      expect(db.query).toHaveBeenCalledTimes(1);
    });

    it("keeps it for the time given, then reads again", async () => {
      const db = answers();
      const held = createHeldReading(60_000);
      await held(db, 0);
      await held(db, 59_999);
      expect(db.query).toHaveBeenCalledTimes(1);
      await held(db, 60_000);
      expect(db.query).toHaveBeenCalledTimes(2);
    });

    it("doesn't hold a failure: the next visit tries again", async () => {
      let fail = true;
      const db = fake(async () => {
        if (fail) throw new Error("the database went away");
        return { rows: [{ recall_number: null, recall_date: null, written: null }] };
      });
      const held = createHeldReading(60_000);
      await expect(held(db, 0)).resolves.toBeNull();
      fail = false;
      await expect(held(db, 1)).resolves.toEqual(stored);
    });
  });
});
