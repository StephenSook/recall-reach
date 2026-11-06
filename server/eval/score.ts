// Scoring and reading the eval's labels. Nothing here touches a database, so a page can read it.
import { parse } from "csv-parse/sync";
import type { Strength, Verdict } from "../match/verdict";

export const LABELS = ["MATCH", "UNSURE", "NEAR_MISS", "NO_MATCH"] as const;
export type Label = (typeof LABELS)[number];

export interface EvalPair {
  pairId: string;
  recallNumber: string;
  title: string;
  label: Label;
  split: "train" | "held_out";
}

export interface Decision {
  verdict: Verdict;
  strength: Strength;
}

export interface Rate {
  k: number;
  n: number;
  rate: number | null;
  low: number | null;
  high: number | null;
}

/** The Wilson score interval at 95%. Zero seen out of 83 still leaves room, which is the point of showing it. */
export function wilson(k: number, n: number, z = 1.96): { low: number; high: number } {
  const p = k / n;
  const denominator = 1 + (z * z) / n;
  const centre = p + (z * z) / (2 * n);
  const margin = z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n));
  return { low: k === 0 ? 0 : (centre - margin) / denominator, high: k === n ? 1 : (centre + margin) / denominator };
}

export function rate(k: number, n: number): Rate {
  if (n === 0) return { k, n, rate: null, low: null, high: null };
  return { k, n, rate: k / n, ...wilson(k, n) };
}

export interface Score {
  /** Look-alikes that reach the seller's review. */
  falseAlarms: Rate;
  /** Look-alikes the app would let a seller message a family about. */
  couldReachFamily: Rate;
  /** Scope-gap pairs it routes to a question. */
  abstained: Rate;
  /** Scope-gap pairs it calls a match. */
  guessed: Rate;
  /** Scope-gap pairs it clears or never finds. */
  missed: Rate;
  falseAlarmPairs: string[];
  reachFamilyPairs: string[];
  missedPairs: string[];
}

const canReachFamily = (d: Decision) => (d.verdict === "MATCH" && d.strength === "CONFIRMED") || (d.verdict === "SCOPE_GAP" && d.strength === "BRAND");

export function score(pairs: EvalPair[], decide: (p: EvalPair) => Decision | null): Score {
  const negatives = pairs.filter((p) => p.label === "NEAR_MISS" || p.label === "NO_MATCH");
  const unsure = pairs.filter((p) => p.label === "UNSURE");
  const flagged = negatives.filter((p) => {
    const d = decide(p);
    return d !== null && d.verdict !== "CLEARED";
  });
  const reach = negatives.filter((p) => {
    const d = decide(p);
    return d !== null && d.verdict !== "CLEARED" && canReachFamily(d);
  });
  const abstained = unsure.filter((p) => decide(p)?.verdict === "SCOPE_GAP");
  const guessed = unsure.filter((p) => decide(p)?.verdict === "MATCH");
  const missed = unsure.filter((p) => {
    const d = decide(p);
    return d === null || d.verdict === "CLEARED";
  });
  return {
    falseAlarms: rate(flagged.length, negatives.length),
    couldReachFamily: rate(reach.length, negatives.length),
    abstained: rate(abstained.length, unsure.length),
    guessed: rate(guessed.length, unsure.length),
    missed: rate(missed.length, unsure.length),
    falseAlarmPairs: flagged.map((p) => p.pairId),
    reachFamilyPairs: reach.map((p) => p.pairId),
    missedPairs: missed.map((p) => p.pairId),
  };
}

export function parsePairs(csv: string): EvalPair[] {
  const rows = parse(csv, { columns: true, skip_empty_lines: true }) as Record<string, string>[];
  return rows.map((r) => {
    if (!(LABELS as readonly string[]).includes(r.label)) throw new Error(`pair ${r.pair_id} has an unknown label`);
    if (r.split !== "train" && r.split !== "held_out") throw new Error(`pair ${r.pair_id} has an unknown split`);
    return { pairId: r.pair_id, recallNumber: r.recall_number, title: r.listing_title, label: r.label as Label, split: r.split };
  });
}

export type ClaudeFinding = "SAME_PRODUCT" | "CANT_TELL" | "DIFFERENT_PRODUCT" | "NONE";

/** What Claude said about the pairs that reached a seller, by what the pair really is. It changes none of the numbers above. */
export function scoreClaude(pairs: EvalPair[], findings: Record<string, ClaudeFinding>) {
  const on = (labels: Label[]) => {
    const asked = pairs.filter((p) => labels.includes(p.label) && findings[p.pairId] !== undefined);
    const count = (f: ClaudeFinding) => rate(asked.filter((p) => findings[p.pairId] === f).length, asked.length);
    return { same: count("SAME_PRODUCT"), cantTell: count("CANT_TELL"), different: count("DIFFERENT_PRODUCT"), none: count("NONE") };
  };
  return { lookAlikes: on(["NEAR_MISS", "NO_MATCH"]), scopeGaps: on(["UNSURE"]) };
}

/** Titles built from a recall's own words: one stating its model, one a character off. Never mixed into the rates above. */
export interface StatedModelScore {
  recalls: number;
  confirmed: Rate;
  /** Stated titles it asked about: a scope gap goes to a person, and says neither yes nor no. */
  asks: number;
  /** Of those, where CPSC limits the recall within the model, so the model alone can't settle it. */
  limitedAsks: number;
  /** Stated titles cleared or never found: a recalled product waved through. */
  cleared: number;
  offByOneConfirmed: Rate;
}

export function scoreStatedModels(pairs: EvalPair[], decide: (p: EvalPair) => Decision | null, limited: ReadonlySet<string> = new Set()): StatedModelScore {
  const confirmed = (p: EvalPair) => {
    const d = decide(p);
    return d?.verdict === "MATCH" && d.strength === "CONFIRMED";
  };
  const asks = (p: EvalPair) => decide(p)?.verdict === "SCOPE_GAP";
  const stated = pairs.filter((p) => p.label === "MATCH");
  const offByOne = pairs.filter((p) => p.label === "NEAR_MISS");
  return {
    recalls: new Set(pairs.map((p) => p.recallNumber)).size,
    confirmed: rate(stated.filter(confirmed).length, stated.length),
    asks: stated.filter(asks).length,
    limitedAsks: stated.filter((p) => asks(p) && limited.has(p.recallNumber)).length,
    cleared: stated.filter((p) => !confirmed(p) && !asks(p)).length,
    offByOneConfirmed: rate(offByOne.filter(confirmed).length, offByOne.length),
  };
}

export interface EvalResults {
  pairs: number;
  recalls: number;
  heldOut: { matcher: Score; baseline: Score };
  train: { matcher: Score; baseline: Score };
  statedModels?: { matcher: StatedModelScore; baseline: StatedModelScore };
}
