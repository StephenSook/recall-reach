import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parsePairs } from "@/server/eval/score";
import { WRONG, wrongPairs } from "./wrongPairs";

const load = (name: string) => readFileSync(new URL(`../../eval/${name}`, import.meta.url), "utf8");
const pairs = parsePairs(load("pairs.csv"));
const { heldOut } = JSON.parse(load("results.json"));
const recalls = JSON.parse(load("recalls.json"));

describe("wrongPairs", () => {
  const rows = wrongPairs(pairs, heldOut.matcher, recalls);
  const count = (outcome: string) => rows.filter((r) => r.outcome === outcome).length;

  it("has every held-out pair it got wrong, matching the numbers above it on the page", () => {
    expect(count(WRONG.REACHES_FAMILY)).toBe(heldOut.matcher.couldReachFamily.k);
    expect(count(WRONG.SHOWN_TO_SELLER)).toBe(heldOut.matcher.falseAlarms.k - heldOut.matcher.couldReachFamily.k);
    expect(count(WRONG.MISSED)).toBe(heldOut.matcher.missed.k);
    expect(rows).toHaveLength(heldOut.matcher.falseAlarms.k + heldOut.matcher.missed.k + heldOut.matcher.guessed.k);
  });

  it("holds none it got right, and none from outside the held-out pairs", () => {
    const heldOutIds = new Set(pairs.filter((p) => p.split === "held_out").map((p) => p.pairId));
    expect(rows.every((r) => heldOutIds.has(r.pairId))).toBe(true);
    expect(new Set(rows.map((r) => r.pairId)).size).toBe(rows.length);
    expect(rows.length).toBeLessThan(heldOutIds.size);
  });

  it("shows the listing's title, CPSC's title and what the pair really is", () => {
    const row = rows.find((r) => r.outcome === WRONG.MISSED)!;
    const pair = pairs.find((p) => p.pairId === row.pairId)!;
    expect(row.title).toBe(pair.title);
    expect(row.recallTitle.length).toBeGreaterThan(0);
    expect(row.really).toBe("Title can't settle it");
  });

  it("refuses a pair the results name but the labels don't have", () => {
    expect(() => wrongPairs(pairs, { ...heldOut.matcher, missedPairs: ["no-such-pair"] }, recalls)).toThrow(/no-such-pair/);
  });
});
