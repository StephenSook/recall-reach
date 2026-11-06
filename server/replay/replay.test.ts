import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { answerSearch } from "../../test/fakeHistory";
import { testDb } from "../../test/pglite";
import { pullRecalls } from "../cpsc/pull";
import { migrate } from "../db/migrate";
import type { Db, Queryable } from "../db/types";
import type { Method, PayPalClient } from "../paypal/client";
import { latestRecallDay, latestReplay, loadReplay, proveReplay, refreshReplay, REPLAY_FROM, REPLAYS_KEPT, runReplay } from "./replay";

const fixtureText = readFileSync(new URL("../../test/fixtures/cpsc/recalls_2026-10-01_to_2026-11-05.json", import.meta.url), "utf8");
const TODAY = "2026-11-06";
const NOW = new Date(`${TODAY}T15:00:00Z`);

function fakePayPal(over: { searchFails?: boolean } = {}) {
  const calls: { method: Method; path: string }[] = [];
  const client: PayPalClient = {
    request: (async (method: Method, path: string) => {
      calls.push({ method, path });
      const found = answerSearch(path, over.searchFails);
      if (found) return found;
      throw new Error(`unexpected ${method} ${path}`);
    }) as PayPalClient["request"],
  };
  return { client, calls };
}

describe("Recall Replay", () => {
  let db: Awaited<ReturnType<typeof testDb>>;
  beforeEach(async () => {
    db = await testDb();
    await migrate(db);
    const fetchImpl = async () => new Response(fixtureText, { status: 200, headers: { "content-type": "application/json" } });
    await pullRecalls(db, { field: "RecallDate", start: "2026-10-01", end: "2026-11-05" }, { fetchImpl: fetchImpl as typeof fetch });
  });
  afterEach(async () => {
    await db.close();
  });

  const run = (client = fakePayPal().client) => runReplay(db, client, { today: TODAY, now: NOW, secret: "k".repeat(32) });
  const total = async () => Number((await db.query<{ n: string }>("select count(*)::text as n from recalls")).rows[0].n);

  /** The database, failing on any statement holding these words, inside a transaction or out. */
  const failingOn = (words: string): typeof db => {
    const guarded = <Q extends Queryable>(q: Q): Q =>
      new Proxy(q, {
        get(target, prop) {
          if (prop === "query") {
            return async (sql: string, params?: unknown[]) => {
              if (sql.includes(words)) throw new Error("the database failed here");
              return target.query(sql, params);
            };
          }
          if (prop === "transaction") {
            return (fn: (tx: Queryable) => Promise<unknown>) => (target as unknown as Db).transaction((tx) => fn(guarded(tx)));
          }
          const value = Reflect.get(target, prop);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
    return guarded(db);
  };

  describe("a run that fails part way", () => {
    it("publishes nothing, so a broken run can't pass for a fresh one, and leaves no shop", async () => {
      const client = fakePayPal().client;
      await expect(runReplay(failingOn("insert into replay_rows"), client, { today: TODAY, now: NOW, secret: "k".repeat(32) })).rejects.toThrow("failed here");
      expect((await db.query("select 1 from replay_runs")).rows).toEqual([]);
      expect((await db.query("select 1 from shops")).rows).toEqual([]);
    });

    it("keeps the run it had", async () => {
      const { runId } = await run();
      const client = fakePayPal().client;
      await expect(runReplay(failingOn("update replay_runs set checked"), client, { today: TODAY, now: NOW, secret: "k".repeat(32) })).rejects.toThrow("failed here");
      expect((await latestReplay(db))?.runId).toBe(runId);
      expect((await db.query("select 1 from replay_runs")).rows).toHaveLength(1);
    });
  });

  describe("keeping a run from the last day, for someone arriving in a quiet week", () => {
    const hoursBeforeNow = (hours: number) => new Date(NOW.getTime() - hours * 3_600_000).toISOString();
    const age = (runId: string, hours: number) => db.query("update replay_runs set created_at = $2::timestamptz where id = $1", [runId, hoursBeforeNow(hours)]);
    const refresh = (client = fakePayPal().client) => refreshReplay(db, () => run(client), NOW);
    const runs = async () => Number((await db.query<{ n: string }>("select count(*)::text as n from replay_runs")).rows[0].n);

    it("runs when there is no run yet, and leaves no shop behind", async () => {
      expect(await refresh()).toBe("RAN");
      expect(await runs()).toBe(1);
      expect((await db.query("select 1 from shops")).rows).toEqual([]);
    });

    it("does nothing while the newest good run is under a day old", async () => {
      await age((await run()).runId, 23);
      expect(await refresh()).toBe("FRESH");
      expect(await runs()).toBe(1);
    });

    it("runs again once the newest good run is a day old", async () => {
      const { runId } = await run();
      await age(runId, 25);
      expect(await refresh()).toBe("RAN");
      expect((await latestReplay(db))?.runId).not.toBe(runId);
    });

    it("keeps the last good run when PayPal's search fails, and tries again next time", async () => {
      const { runId } = await run();
      await age(runId, 25);
      expect(await refresh(fakePayPal({ searchFails: true }).client)).toBe("DISCARDED");
      expect((await latestReplay(db))?.runId).toBe(runId);
      expect(await runs()).toBe(1);
      expect(await refresh()).toBe("RAN");
    });

    it("keeps a run with a failed search when it is the only one, because it says so on the page", async () => {
      expect(await refresh(fakePayPal({ searchFails: true }).client)).toBe("RAN");
      const latest = await latestReplay(db);
      expect((await loadReplay(db, latest?.runId ?? ""))?.search.complete).toBe(false);
    });

    it("tries again next time when the only run has a failed search", async () => {
      await refresh(fakePayPal({ searchFails: true }).client);
      expect(await refresh()).toBe("RAN");
    });

    it("says when a run was made, in the run and in its proof", async () => {
      const { runId } = await run();
      await age(runId, 1);
      expect((await loadReplay(db, runId))?.createdAt).toBe(hoursBeforeNow(1));
      expect((await proveReplay(db, runId))?.ranAt).toBe(hoursBeforeNow(1));
    });
  });

  describe("a run", () => {
    it("checks every recall loaded, and says what happened to each", async () => {
      const { runId } = await run();
      const replay = await loadReplay(db, runId);
      expect(replay?.rows).toHaveLength(await total());
      expect(new Set(replay?.rows.map((r) => r.recallNumber)).size).toBe(await total());
      for (const r of replay?.rows ?? []) expect(["MATCH", "SCOPE_GAP", "CLEARED", "NOT_NEAR"]).toContain(r.outcome);
    });

    it("has real outcomes on real recalls", async () => {
      const replay = await loadReplay(db, (await run()).runId);
      const row = (n: string) => replay?.rows.find((r) => r.recallNumber === n);
      expect(row("27072")).toMatchObject({ outcome: "MATCH", saleSplit: "NOTICE_ONLY" });
      expect(row("27027")).toMatchObject({ outcome: "MATCH", saleSplit: "REFUND_ELIGIBLE" });
      expect(row("27040")).toMatchObject({ outcome: "SCOPE_GAP" });
    });

    it("gives a recall its strongest outcome when several items come near it", async () => {
      const replay = await loadReplay(db, (await run()).runId);
      expect(replay?.rows.find((r) => r.recallNumber === "27072")?.outcome).toBe("MATCH"); // the near miss on the same recall clears
    });

    describe("its own window", () => {
      const older: unknown[] = JSON.parse(readFileSync(new URL("../../test/fixtures/cpsc/recall_22200.json", import.meta.url), "utf8"));
      const loadOlder = () => {
        const fetchImpl = async () => new Response(JSON.stringify(older), { status: 200, headers: { "content-type": "application/json" } });
        return pullRecalls(db, { field: "RecallDate", start: "2022-08-01", end: "2022-08-31" }, { fetchImpl: fetchImpl as typeof fetch });
      };

      it("keeps to 2025 on when older recalls are loaded, and has no row for them", async () => {
        const before = (await loadReplay(db, (await run()).runId))!;
        await loadOlder();
        const after = (await loadReplay(db, (await run()).runId))!;
        expect(after.counts).toEqual(before.counts);
        expect(after.rows.map((r) => r.recallNumber)).not.toContain("22200");
        expect(after.rows.every((r) => r.recallDate >= REPLAY_FROM)).toBe(true);
      });

      it("isn't called changed because an older recall came in", async () => {
        const { runId } = await run();
        await loadOlder();
        expect((await proveReplay(db, runId))?.sameRecalls).toBe(true);
      });
    });

    describe("the newest day of recalls, for the public API", () => {
      it("has nothing to say before a run", async () => {
        expect(await latestRecallDay(db)).toBeNull();
      });

      it("gives that day's recalls from the latest run, with what each one found", async () => {
        const { runId } = await run();
        const day = await latestRecallDay(db);
        expect(day).toMatchObject({ runId, recallDate: "2026-11-05" });
        expect(day?.recalls.map((r) => r.recallNumber)).toContain("27072");
        expect(day?.recalls.find((r) => r.recallNumber === "27072")).toMatchObject({ outcome: "MATCH", itemTitle: "Baby Brezza SuperFast Sterilizer Dryer BRZ0083" });
      });

      it("carries nothing from PayPal", async () => {
        await run();
        const text = JSON.stringify(await latestRecallDay(db));
        expect(text).not.toContain("POOLTXN");
        expect(text).not.toContain("DEMO-HIST");
      });
    });

    it("reports only recalls it read before its check, so one loading mid-run isn't called nothing near", async () => {
      // One no demo case needs, so the seed still runs without it.
      const earlier = await loadReplay(db, (await run()).runId);
      const late = earlier?.rows.find((r) => r.outcome === "NOT_NEAR")?.recallNumber ?? "";
      expect(late).not.toBe("");
      await db.query("delete from recalls where recall_number = $1", [late]);
      const fetchImpl = async () => new Response(fixtureText, { status: 200, headers: { "content-type": "application/json" } });
      let loaded = false;
      const during = new Proxy(db, {
        get(target, prop) {
          // Right after the check has finished, which is the transaction that writes the shop's run.
          if (prop === "transaction") {
            return async (fn: (tx: Queryable) => Promise<unknown>) => {
              const answer = await target.transaction(fn);
              if (!loaded && (await target.query("select 1 from shop_runs")).rows.length > 0) {
                loaded = true;
                await pullRecalls(target, { field: "RecallDate", start: "2026-10-01", end: "2026-11-05" }, { fetchImpl: fetchImpl as typeof fetch });
              }
              return answer;
            };
          }
          const value = Reflect.get(target, prop);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
      const { runId } = await runReplay(during, fakePayPal().client, { today: TODAY, now: NOW, secret: "k".repeat(32) });
      expect(loaded).toBe(true);
      const replay = await loadReplay(db, runId);
      expect(replay?.rows.map((r) => r.recallNumber)).not.toContain(late);
      expect(replay?.rows).toHaveLength((await total()) - 1);
      expect((await proveReplay(db, runId))?.sameRecalls).toBe(false);
    });

    it("says which years didn't load, in the run and in its proof", async () => {
      const { runId } = await run();
      expect((await loadReplay(db, runId))?.recallYearsMissing).toEqual([2025, 2026]);
      expect((await proveReplay(db, runId))?.recallYearsMissing).toEqual([2025, 2026]);
    });

    it("says a year is missing if it was when the run read its recalls, even if the load finishes during the run", async () => {
      let loaded = false;
      const during = new Proxy(db, {
        get(target, prop) {
          if (prop === "query") {
            return async (sql: string, params?: unknown[]) => {
              if (!loaded && sql.includes("insert into shops")) {
                loaded = true;
                await target.query("insert into cpsc_pulls (range_field, range_start, range_end, status, fetched, finished_at) values ('RecallDate', '2025-01-01', '2025-12-31', 'ok', 1, now()), ('RecallDate', '2026-01-01', '2026-11-05', 'ok', 1, now())");
              }
              return target.query(sql, params);
            };
          }
          const value = Reflect.get(target, prop);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
      const { runId } = await runReplay(during, fakePayPal().client, { today: TODAY, now: NOW, secret: "k".repeat(32) });
      expect(loaded).toBe(true);
      expect((await loadReplay(db, runId))?.recallYearsMissing).toEqual([2025, 2026]);
    });

    it("says a year is missing if its load finishes just after the run read its recalls", async () => {
      const loadedYears = "insert into cpsc_pulls (range_field, range_start, range_end, status, fetched, finished_at) values ('RecallDate', '2025-01-01', '2025-12-31', 'ok', 1, now()), ('RecallDate', '2026-01-01', '2026-11-05', 'ok', 1, now())";
      const during = new Proxy(db, {
        get(target, prop) {
          if (prop === "query") {
            return async (sql: string, params?: unknown[]) => {
              const answer = await target.query(sql, params);
              if (sql.includes("array_agg(recall_id)")) await target.query(loadedYears);
              return answer;
            };
          }
          const value = Reflect.get(target, prop);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
      const { runId } = await runReplay(during, fakePayPal().client, { today: TODAY, now: NOW, secret: "k".repeat(32) });
      expect((await loadReplay(db, runId))?.recallYearsMissing).toEqual([2025, 2026]);
    });

    it("has no year to name once every year loaded", async () => {
      await db.query("insert into cpsc_pulls (range_field, range_start, range_end, status, fetched, finished_at) values ('RecallDate', '2025-01-01', '2025-12-31', 'ok', 1, now()), ('RecallDate', '2026-01-01', '2026-11-05', 'ok', 1, now())");
      const { runId } = await run();
      expect((await loadReplay(db, runId))?.recallYearsMissing).toEqual([]);
      expect((await proveReplay(db, runId))?.recallYearsMissing).toEqual([]);
    });

    it("counts add up to every recall", async () => {
      const { counts } = (await loadReplay(db, (await run()).runId))!;
      expect(counts.matched + counts.scopeGaps + counts.cleared + counts.notNear).toBe(counts.checked);
      expect(counts.checked).toBe(await total());
      expect(counts.matched).toBeGreaterThanOrEqual(3);
    });

    it("splits matches into notice only and refund eligible", async () => {
      const { counts } = (await loadReplay(db, (await run()).runId))!;
      expect(counts.noticeOnly).toBeGreaterThanOrEqual(1);
      expect(counts.refundEligible).toBeGreaterThanOrEqual(1);
    });

    it("has a clock, from a real measurement of the run", async () => {
      const replay = await loadReplay(db, (await run()).runId);
      expect(replay?.ms).toBeGreaterThan(0);
    });

    it("spends nothing: no capture, no refund, no call to Claude", async () => {
      const pp = fakePayPal();
      await run(pp.client);
      expect(pp.calls.filter((c) => c.method !== "GET")).toEqual([]);
      const source = readFileSync(new URL("./replay.ts", import.meta.url), "utf8");
      expect(source).not.toMatch(/agent\/|anthropic/i);
    });

    it("leaves no shop behind", async () => {
      const before = (await db.query("select id from shops")).rows;
      await run();
      expect((await db.query("select id from shops")).rows).toEqual(before);
      expect((await db.query("select 1 from paypal_payments")).rows).toEqual([]);
    });

    it("says what PayPal's search covered, and how many payments it could not identify", async () => {
      const { counts, search } = (await loadReplay(db, (await run()).runId))!;
      expect(counts.unidentified).toBe(1);
      expect(search).toMatchObject({ complete: true, failedWindows: 0 });
      expect(search.windows).toBeGreaterThan(0);
    });

    it("says so when PayPal's search failed, and still checks every recall", async () => {
      const { counts, search } = (await loadReplay(db, (await run(fakePayPal({ searchFails: true }).client)).runId))!;
      expect(search.complete).toBe(false);
      expect(counts.checked).toBe(await total());
    });

    it("carries nothing from PayPal: no ids, amounts or item names", async () => {
      const { runId } = await run();
      const stored = JSON.stringify([(await db.query("select * from replay_runs")).rows, (await db.query("select * from replay_rows where run_id = $1", [runId])).rows]);
      expect(stored).not.toContain("POOLTXN");
      expect(stored).not.toContain("DEMO-HIST");
      expect(stored).not.toContain("DEMO-abcd1234");
      expect(stored).not.toContain("Someone else's sale");
    });
  });

  describe("old runs", () => {
    it("never prunes the last good run away, however many runs failed since", async () => {
      const good = (await run()).runId;
      await db.query("update replay_runs set created_at = now() - interval '1 day' where id = $1", [good]);
      const failing = fakePayPal({ searchFails: true }).client;
      for (let i = 0; i < REPLAYS_KEPT; i++) await run(failing);
      const kept = await db.query<{ id: string }>("select id from replay_runs where search_complete");
      expect(kept.rows.map((r) => r.id)).toEqual([good]);
    });

    it("keeps only the newest", async () => {
      let last = "";
      for (let i = 0; i < REPLAYS_KEPT + 2; i++) last = (await run()).runId;
      expect((await db.query("select 1 from replay_runs")).rows).toHaveLength(REPLAYS_KEPT);
      expect((await latestReplay(db))?.runId).toBe(last);
    });

    it("reads nothing for a run that isn't there", async () => {
      expect(await loadReplay(db, "not-a-uuid")).toBeNull();
      expect(await loadReplay(db, "00000000-0000-4000-8000-000000000001")).toBeNull();
      expect(await latestReplay(db)).toBeNull();
    });
  });

  describe("the proof", () => {
    it("recounts the headline numbers from the rows, and they agree", async () => {
      const { runId } = await run();
      const proof = await proveReplay(db, runId);
      expect(proof?.agree).toBe(true);
      expect(proof?.recomputed).toEqual(proof?.stored);
    });

    it("catches a stored number that does not match its rows", async () => {
      const { runId } = await run();
      await db.query("update replay_runs set matched = matched + 1 where id = $1", [runId]);
      expect((await proveReplay(db, runId))?.agree).toBe(false);
    });

    it("says whether CPSC's records are still the ones this run read", async () => {
      const { runId } = await run();
      expect((await proveReplay(db, runId))?.sameRecalls).toBe(true);
      await db.query("update recalls set raw_sha256 = 'changed' where recall_number = '27040'");
      expect((await proveReplay(db, runId))?.sameRecalls).toBe(false);
    });

    it("has nothing to say about a run that isn't there", async () => {
      expect(await proveReplay(db, "00000000-0000-4000-8000-000000000001")).toBeNull();
    });
  });
});
