import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { testDb } from "../../test/pglite";
import { migrate } from "../db/migrate";
import type { RecallRange } from "./fetch";
import { pullRecalls, snapshotHash } from "./pull";

// Real CPSC API response for RecallDate 2026-10-01 to 2026-11-05 (55 recalls), saved 2026-11-05.
const fixtureText = readFileSync(
  new URL("../../test/fixtures/cpsc/recalls_2026-10-01_to_2026-11-05.json", import.meta.url),
  "utf8",
);
const fixture = (): Record<string, unknown>[] => JSON.parse(fixtureText);
const RANGE: RecallRange = { field: "RecallDate", start: "2026-10-01", end: "2026-11-05" };

type TestDb = Awaited<ReturnType<typeof testDb>>;

/** Fetch stand-in that answers with the given payload (or HTTP status). */
function answering(reply: unknown[] | number) {
  const fetchImpl = async () =>
    typeof reply === "number"
      ? new Response("error", { status: reply })
      : new Response(JSON.stringify(reply), { status: 200, headers: { "content-type": "application/json" } });
  return { fetchImpl: fetchImpl as typeof fetch, sleep: async () => {} };
}

describe("pullRecalls", () => {
  let db: TestDb;
  beforeEach(async () => {
    db = await testDb();
    await migrate(db);
  });
  afterEach(async () => {
    await db.close();
  });

  const count = async (table: string) =>
    Number((await db.query<{ n: string }>(`select count(*)::text as n from ${table}`)).rows[0].n);

  it("loads every record from the real fixture and logs an ok pull", async () => {
    const summary = await pullRecalls(db, RANGE, answering(fixture()));
    expect(summary).toMatchObject({ status: "ok", fetched: 55, inserted: 55, updated: 0, unchanged: 0, invalid: [] });
    expect(await count("recalls")).toBe(55);
    const { rows } = await db.query<Record<string, unknown>>("select * from cpsc_pulls where id = $1", [summary.pullId]);
    expect(rows[0]).toMatchObject({
      status: "ok",
      range_field: "RecallDate",
      range_start: "2026-10-01",
      range_end: "2026-11-05",
      fetched: 55,
      inserted: 55,
      updated: 0,
      unchanged: 0,
      invalid: 0,
      error: null,
    });
    expect(rows[0].finished_at).not.toBeNull();
  });

  it("stores the mapped fields, the raw record and its snapshot hash", async () => {
    await pullRecalls(db, RANGE, answering(fixture()));
    const { rows } = await db.query<Record<string, unknown>>("select * from recalls where recall_id = 11045");
    const original = fixture().find((r) => r.RecallID === 11045);
    expect(rows[0]).toMatchObject({
      recall_number: "27066",
      recall_date: "2026-11-05",
      last_publish_date: "2026-11-05 00:00:00",
      title: "Arlopu Recalls Slide Playsets Due to Risk of Serious Injury and Death from Head and Neck Entrapment Hazards",
      products: [{ name: "Arlopu Slide Playsets", model: "", type: "Slides or Sliding Boards", units: "About 10,318" }],
      remedy_options: ["Repair"],
      raw: original,
      raw_sha256: snapshotHash(original),
    });
  });

  it("changes nothing when the same data is pulled again", async () => {
    await pullRecalls(db, RANGE, answering(fixture()));
    const before = await db.query("select recall_id, first_seen_at, updated_at from recalls order by recall_id");
    const summary = await pullRecalls(db, RANGE, answering(fixture()));
    expect(summary).toMatchObject({ status: "ok", inserted: 0, updated: 0, unchanged: 55 });
    const after = await db.query("select recall_id, first_seen_at, updated_at from recalls order by recall_id");
    expect(after.rows).toEqual(before.rows);
  });

  it("updates a record CPSC changed and keeps when it was first seen", async () => {
    await pullRecalls(db, RANGE, answering(fixture()));
    const firstSeen = (await db.query("select first_seen_at from recalls where recall_id = 11045")).rows[0];
    const changed = fixture();
    const arlopu = changed.find((r) => r.RecallID === 11045)!;
    arlopu.Title = "Arlopu Recalls Slide Playsets (updated)";
    const summary = await pullRecalls(db, RANGE, answering(changed));
    expect(summary).toMatchObject({ inserted: 0, updated: 1, unchanged: 54 });
    const { rows } = await db.query<Record<string, unknown>>(
      "select title, raw_sha256, first_seen_at from recalls where recall_id = 11045",
    );
    expect(rows[0].title).toBe("Arlopu Recalls Slide Playsets (updated)");
    expect(rows[0].raw_sha256).toBe(snapshotHash(arlopu));
    expect(rows[0].first_seen_at).toEqual(firstSeen.first_seen_at);
  });

  it("keeps the most recently published copy when CPSC repeats a recall in one response", async () => {
    const records = fixture();
    const older = { ...records.find((r) => r.RecallID === 11045)!, LastPublishDate: "2026-11-04T00:00:00", Title: "old" };
    const summary = await pullRecalls(db, RANGE, answering([older, ...records]));
    expect(summary).toMatchObject({ fetched: 56, inserted: 55 });
    const { rows } = await db.query<{ title: string }>("select title from recalls where recall_id = 11045");
    expect(rows[0].title).not.toBe("old");
  });

  it("loads the valid records and logs a partial pull when some are invalid", async () => {
    const records = fixture();
    delete records[3].RecallID;
    const summary = await pullRecalls(db, RANGE, answering(records));
    expect(summary.status).toBe("partial");
    expect(summary).toMatchObject({ fetched: 55, inserted: 54 });
    expect(summary.invalid).toHaveLength(1);
    expect(summary.invalid[0]).toMatchObject({ index: 3, recallId: null });
    expect(await count("recalls")).toBe(54);
    const { rows } = await db.query<Record<string, unknown>>("select status, invalid, invalid_detail from cpsc_pulls");
    expect(rows[0]).toMatchObject({ status: "partial", invalid: 1 });
    expect(rows[0].invalid_detail).toEqual(summary.invalid);
  });

  it("logs a failed pull and rethrows when CPSC errors", async () => {
    await expect(pullRecalls(db, RANGE, answering(400))).rejects.toThrow(/HTTP 400/);
    const { rows } = await db.query<Record<string, unknown>>("select status, error, finished_at from cpsc_pulls");
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("failed");
    expect(rows[0].error).toMatch(/HTTP 400/);
    expect(rows[0].finished_at).not.toBeNull();
    expect(await count("recalls")).toBe(0);
  });
});

describe("snapshotHash", () => {
  it("does not depend on key order", () => {
    expect(snapshotHash({ a: 1, b: { c: [1, 2], d: "x" } })).toBe(snapshotHash({ b: { d: "x", c: [1, 2] }, a: 1 }));
  });

  it("changes when any value changes", () => {
    expect(snapshotHash({ a: 1, b: [1, 2] })).not.toBe(snapshotHash({ a: 1, b: [2, 1] }));
  });

  it("is a sha256 hex digest", () => {
    expect(snapshotHash({})).toMatch(/^[0-9a-f]{64}$/);
  });
});
