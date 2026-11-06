import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { testDb } from "../../test/pglite";
import { parseRecalls } from "../cpsc/schema";
import { modelsNamedInText, modelTokens } from "../match/verdict";
import { checkResult } from "../notice/store";
import { decidePairs, parsePairs, rate, runEval, score, scoreClaude, scoreStatedModels, wilson, type ClaudeFinding, type Decision, type EvalPair } from "./measure";

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

describe("scoreClaude", () => {
  const pairs = [pair("n1", "NEAR_MISS"), pair("n2", "NEAR_MISS"), pair("n3", "NO_MATCH"), pair("n4", "NEAR_MISS"), pair("u1", "UNSURE"), pair("u2", "UNSURE")];

  it("counts what Claude said by what each pair really is, only over pairs it was asked about", () => {
    const s = scoreClaude(pairs, { n1: "DIFFERENT_PRODUCT", n2: "SAME_PRODUCT", n3: "CANT_TELL", u1: "CANT_TELL", u2: "DIFFERENT_PRODUCT" });
    expect(s.lookAlikes.different).toMatchObject({ k: 1, n: 3 });
    expect(s.lookAlikes.same).toMatchObject({ k: 1, n: 3 });
    expect(s.scopeGaps.cantTell).toMatchObject({ k: 1, n: 2 });
    expect(s.scopeGaps.different).toMatchObject({ k: 1, n: 2 });
  });
});

describe("scoreStatedModels", () => {
  const pair = (pairId: string, recallNumber: string): EvalPair => ({ pairId, recallNumber, title: "T", label: "MATCH", split: "held_out" });
  const pairs = [pair("confirmed", "1"), pair("asks", "2"), pair("cleared", "2"), pair("missing", "2")];
  const decisions: Record<string, Decision | null> = {
    confirmed: { verdict: "MATCH", strength: "CONFIRMED" },
    asks: { verdict: "SCOPE_GAP", strength: "BRAND" },
    cleared: { verdict: "CLEARED", strength: "BRAND" },
    missing: null,
  };
  const limited = new Set(["2"]);

  it("counts a clear or a title never found as cleared, even on a limited recall", () => {
    expect(scoreStatedModels(pairs, (p) => decisions[p.pairId], limited)).toMatchObject({ asks: 1, limitedAsks: 1, cleared: 2, confirmed: { k: 1, n: 4 } });
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

  it("a title stating a recalled model is confirmed or asks, never clears, and one a character off is not confirmed", () => {
    const { matcher, baseline } = JSON.parse(load("results.json")).statedModels;
    // Exact on purpose. A drop in either fails here, and regenerating the results can't hide it.
    expect(matcher.confirmed).toMatchObject({ k: 52, n: 60 });
    expect(matcher.asks).toBe(8);
    expect(matcher.limitedAsks).toBe(6);
    expect(matcher.cleared).toBe(0);
    expect(baseline.asks).toBe(0); // word match never asks
    expect(matcher.offByOneConfirmed.k).toBe(0);
    expect(baseline.offByOneConfirmed.k).toBe(baseline.offByOneConfirmed.n); // word match can't tell them apart
  });

  it("a family typing a model the title states is never told it doesn't match", () => {
    const { valid } = parseRecalls(JSON.parse(load("positives_recalls.json")));
    const byNumber = new Map(valid.map((v) => [v.recall.recallNumber, v.recall]));
    const stated = parsePairs(load("positives.csv")).filter((p) => p.label === "MATCH");
    expect(stated).toHaveLength(60);
    // Most of these titles end in the model, so a pair can't drop out because the tokenizer doesn't read it as one (4155L).
    // Two don't (26611 ends in an airflow figure, 27064 in a masked VIN), so this also tries the models read from the record.
    const typed = stated.flatMap((p) => {
      const recall = byNumber.get(p.recallNumber)!;
      const last = p.title.trim().split(/\s+/).at(-1) ?? "";
      expect(last, p.pairId).toMatch(/\d/);
      const record = `${recall.title} ${recall.description}`;
      return [...new Set([last, ...modelTokens(p.title), ...modelTokens(record), ...modelsNamedInText(record)])].map((model) => ({ pair: p.pairId, model, recall }));
    });
    const told = typed.filter(({ model, recall }) => checkResult(recall, { question: "Q", kind: "model" }, model) === "DOESNT_MATCH").map((t) => `${t.pair}: ${t.model}`);
    expect(told).toEqual([]);
  });

  it("a family typing a model CPSC writes with a space in it, which the tokenizer can't read, is never told it doesn't match", () => {
    const { valid } = parseRecalls(JSON.parse(load("positives_recalls.json")));
    const recall = valid.find((v) => v.recall.recallNumber === "26611")!.recall;
    for (const model of ["KHB 6048-06", "KMS 1524-06"]) {
      expect(recall.description).toContain(model);
      expect(checkResult(recall, { question: "Q", kind: "model" }, model)).toBe("CANT_TELL");
    }
  });

  it("keeps stated-model titles out of the held-out rates, and names none as real listings", () => {
    const held = new Set(parsePairs(load("pairs.csv")).map((p) => p.pairId));
    expect(parsePairs(load("positives.csv")).filter((p) => held.has(p.pairId))).toEqual([]);
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
    const results = await runEval(db, {
      pairs: parsePairs(load("pairs.csv")),
      recalls: JSON.parse(load("recalls.json")),
      statedModels: { pairs: parsePairs(load("positives.csv")), recalls: JSON.parse(load("positives_recalls.json")) },
    });
    expect(JSON.parse(load("results.json"))).toEqual(JSON.parse(JSON.stringify(results)));
    await db.close();
  }, 240_000);

  it("the committed Claude summary is what its cached findings say, so CI checks it without spending anything", () => {
    const cached = JSON.parse(load("claude-held-out.json")) as { findings: Record<string, ClaudeFinding>; summary: unknown };
    const heldOut = parsePairs(load("pairs.csv")).filter((p) => p.split === "held_out");
    expect(JSON.parse(JSON.stringify(scoreClaude(heldOut, cached.findings)))).toEqual(cached.summary);
    expect(Object.keys(cached.findings).length).toBeGreaterThan(0);
    for (const id of Object.keys(cached.findings)) expect(heldOut.some((p) => p.pairId === id)).toBe(true);
  });

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
