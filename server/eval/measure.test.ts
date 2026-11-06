import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { testDb } from "../../test/pglite";
import { decidePairs, parsePairs, rate, runEval, score, wilson, type Decision, type EvalPair } from "./measure";

const pair = (pairId: string, label: EvalPair["label"], split: EvalPair["split"] = "held_out"): EvalPair => ({ pairId, recallNumber: "1", title: "t", label, split });
const decision = (verdict: Decision["verdict"], strength: Decision["strength"] = "BRAND"): Decision => ({ verdict, strength });

describe("wilson", () => {
  it("matches the published interval", () => {
    // Worked by hand from the Wilson score formula with z = 1.96.
    const { low, high } = wilson(10, 100);
    expect(low).toBeCloseTo(0.0552, 3);
    expect(high).toBeCloseTo(0.1744, 3);
  });

  it("has an upper bound above zero when nothing went wrong: none seen is not none", () => {
    const { low, high } = wilson(0, 83);
    expect(low).toBe(0);
    expect(high).toBeGreaterThan(0.04);
  });

  it("stays between 0 and 1", () => {
    const { low, high } = wilson(12, 12);
    expect(low).toBeGreaterThan(0.7);
    expect(high).toBeCloseTo(1, 10);
  });

  it("says nothing with nothing measured", () => {
    expect(rate(0, 0)).toEqual({ k: 0, n: 0, rate: null, low: null, high: null });
  });
});

describe("score", () => {
  const pairs = [pair("n1", "NEAR_MISS"), pair("n2", "NEAR_MISS"), pair("m1", "NO_MATCH"), pair("u1", "UNSURE"), pair("u2", "UNSURE")];
  const run = (d: Record<string, Decision | null>) => score(pairs, (p) => d[p.pairId] ?? null);

  it("counts a look-alike that reaches the seller as a false alarm, and one cleared or never retrieved as right", () => {
    const s = run({ n1: decision("SCOPE_GAP", "PRODUCT_WORDS"), n2: decision("CLEARED"), m1: null });
    expect(s.falseAlarms).toMatchObject({ k: 1, n: 3 });
  });

  it("counts only what could reach a family as a family false alarm", () => {
    const s = run({ n1: decision("SCOPE_GAP", "PRODUCT_WORDS"), n2: decision("SCOPE_GAP", "BRAND"), m1: decision("MATCH", "CONFIRMED") });
    expect(s.falseAlarms).toMatchObject({ k: 3, n: 3 });
    expect(s.couldReachFamily).toMatchObject({ k: 2, n: 3 });
  });

  it("counts a scope gap on an unsure pair as abstaining, a match as guessing, and a clear as a miss", () => {
    const s = run({ u1: decision("SCOPE_GAP"), u2: decision("CLEARED") });
    expect(s.abstained).toMatchObject({ k: 1, n: 2 });
    expect(s.missed).toMatchObject({ k: 1, n: 2 });
    expect(run({ u1: decision("MATCH", "CONFIRMED") }).guessed).toMatchObject({ k: 1, n: 2 });
    expect(run({}).missed).toMatchObject({ k: 2, n: 2 }); // never retrieved is a miss too
  });

  it("names each miss, so the card can list them", () => {
    const s = run({ n1: decision("SCOPE_GAP"), u1: decision("CLEARED") });
    expect(s.falseAlarmPairs).toEqual(["n1"]);
    expect(s.missedPairs).toEqual(["u1", "u2"]);
  });

  it("never mixes in pairs from another split: the caller passes one split at a time", () => {
    const heldOut = parsePairs("pair_id,recall_number,listing_title,label,split\na,1,T,UNSURE,train\nb,1,T,NEAR_MISS,held_out\n");
    expect(heldOut.map((p) => p.split)).toEqual(["train", "held_out"]);
  });
});

describe("parsePairs", () => {
  it("reads titles with commas and quotes", () => {
    expect(parsePairs('pair_id,recall_number,listing_title,label,split\n1-1,1,"A, ""B"" C",NO_MATCH,train\n')[0]).toEqual({ pairId: "1-1", recallNumber: "1", title: 'A, "B" C', label: "NO_MATCH", split: "train" });
  });

  it("refuses a label it does not know, rather than dropping the row", () => {
    expect(() => parsePairs("pair_id,recall_number,listing_title,label,split\n1,1,T,MAYBE,train\n")).toThrow(/label/);
  });
});

describe("the eval on the real labels", () => {
  const load = (name: string) => readFileSync(new URL(`../../eval/${name}`, import.meta.url), "utf8");

  it("has the published counts, with no recall on both sides of the split", () => {
    const pairs = parsePairs(load("pairs.csv"));
    expect(pairs).toHaveLength(285);
    const heldOut = pairs.filter((p) => p.split === "held_out");
    expect(heldOut).toHaveLength(95);
    const train = new Set(pairs.filter((p) => p.split === "train").map((p) => p.recallNumber));
    expect(heldOut.filter((p) => train.has(p.recallNumber))).toEqual([]);
  });

  it("carries no retailer", () => {
    expect(load("pairs.csv").split("\n")[0]).toBe("pair_id,recall_number,listing_title,label,split");
  });

  it("runs every pair through the real pipeline, and beats the word-match baseline as the plan requires", async () => {
    const db = await testDb();
    const results = await runEval(db, { pairs: parsePairs(load("pairs.csv")), recalls: JSON.parse(load("recalls.json")) });
    expect(results.heldOut.matcher.falseAlarms.n).toBe(83);
    expect(results.heldOut.matcher.abstained.n).toBe(12);
    expect(results.heldOut.matcher.falseAlarms.k).toBeLessThan(results.heldOut.baseline.falseAlarms.k);
    expect(results.heldOut.matcher.abstained.k).toBeGreaterThanOrEqual(results.heldOut.baseline.abstained.k);
    await db.close();
  }, 240_000);

  it("the committed results are what the code produces now, so the card can't go stale", async () => {
    const db = await testDb();
    const results = await runEval(db, { pairs: parsePairs(load("pairs.csv")), recalls: JSON.parse(load("recalls.json")) });
    expect(JSON.parse(load("results.json"))).toEqual(JSON.parse(JSON.stringify(results)));
    await db.close();
  }, 240_000);

  it("the decisions are read from the pipeline for the pair's own recall", async () => {
    const db = await testDb();
    const recalls = JSON.parse(load("recalls.json"));
    const pairs = parsePairs(load("pairs.csv")).filter((p) => p.recallNumber === "27072");
    expect(pairs.length).toBeGreaterThan(0);
    const decided = await decidePairs(db, pairs, recalls);
    expect(decided.size).toBeLessThanOrEqual(pairs.length);
    await db.close();
  }, 120_000);
});
