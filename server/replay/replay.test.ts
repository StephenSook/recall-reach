import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { answerSearch } from "../../test/fakeHistory";
import { testDb } from "../../test/pglite";
import { pullRecalls } from "../cpsc/pull";
import { migrate } from "../db/migrate";
import type { Method, PayPalClient, RequestOptions } from "../paypal/client";
import { latestReplay, loadReplay, proveReplay, REPLAYS_KEPT, runReplay } from "./replay";

const fixtureText = readFileSync(new URL("../../test/fixtures/cpsc/recalls_2026-10-01_to_2026-11-05.json", import.meta.url), "utf8");
const TODAY = "2026-11-06";
const NOW = new Date(`${TODAY}T15:00:00Z`);

function fakePayPal(over: { searchFails?: boolean } = {}) {
  const calls: { method: Method; path: string }[] = [];
  const client: PayPalClient = {
    request: (async (method: Method, path: string, opts: RequestOptions = {}) => {
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
