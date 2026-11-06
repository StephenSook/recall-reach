// The eval: does the matcher leave look-alikes alone, and does it abstain when the title can't settle it? Every pair
// goes through the real pipeline, retrieval included. The word-match baseline flags whatever retrieval finds, with no
// rules and no way to abstain, which is what a plain search would do.
import { parse } from "csv-parse/sync";
import { recordPull } from "../cpsc/pull";
import { migrate } from "../db/migrate";
import type { Db } from "../db/types";
import { createShop, storeOrderLines } from "../import/store";
import { runShopCheck } from "../match/run";
import type { Strength, Verdict } from "../match/verdict";
import { createContactCipher } from "../privacy/contactCipher";

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

/** Each recall's pairs go in as one shop's sales, so a title competes only with others in its own search. */
export async function decidePairs(db: Db, pairs: EvalPair[], rawRecalls: unknown[]): Promise<Map<string, Decision & { retrieved: true }>> {
  await migrate(db);
  await recordPull(db, { field: "RecallDate", start: "2000-01-01", end: "2100-01-01" }, async () => rawRecalls);
  const decided = new Map<string, Decision & { retrieved: true }>();
  const byRecall = new Map<string, EvalPair[]>();
  for (const p of pairs) byRecall.set(p.recallNumber, [...(byRecall.get(p.recallNumber) ?? []), p]);
  for (const [recallNumber, group] of byRecall) {
    const shopId = await createShop(db, { name: `eval ${recallNumber}`, kind: "DEMO" });
    const lines = group.map((p) => ({
      orderNumber: p.pairId,
      lineNo: 1,
      title: p.title,
      sku: null,
      quantity: 1,
      unitPriceCents: 100,
      discountCents: 0,
      currency: "USD",
      orderedOn: "2026-01-01",
      paymentReference: null,
      buyerEmail: null,
    }));
    await storeOrderLines(db, shopId, lines, createContactCipher("eval".repeat(8), shopId), "eval");
    // Dates play no part: the labels are about the words, and a sale date would clear some pairs for another reason.
    await runShopCheck(db, shopId, { today: "2026-11-06", dateFilter: false });
    const { rows } = await db.query<{ order_number: string; verdict: Verdict; strength: Strength }>(
      `select l.order_number, m.verdict, m.strength from recall_matches m
       join recalls r on r.recall_id = m.recall_id join order_lines l on l.id = m.order_line_id
       where m.shop_id = $1 and r.recall_number = $2`,
      [shopId, recallNumber],
    );
    for (const row of rows) decided.set(row.order_number, { verdict: row.verdict, strength: row.strength, retrieved: true });
  }
  return decided;
}

export interface EvalResults {
  pairs: number;
  recalls: number;
  heldOut: { matcher: Score; baseline: Score };
  train: { matcher: Score; baseline: Score };
}

export async function runEval(db: Db, input: { pairs: EvalPair[]; recalls: unknown[] }): Promise<EvalResults> {
  const decided = await decidePairs(db, input.pairs, input.recalls);
  const matcher = (p: EvalPair) => decided.get(p.pairId) ?? null;
  // A plain word match: anything retrieval finds is flagged as a hit, with no way to abstain.
  const baseline = (p: EvalPair): Decision | null => (decided.has(p.pairId) ? { verdict: "MATCH", strength: "CONFIRMED" } : null);
  const on = (split: EvalPair["split"]) => {
    const pairs = input.pairs.filter((p) => p.split === split);
    return { matcher: score(pairs, matcher), baseline: score(pairs, baseline) };
  };
  return { pairs: input.pairs.length, recalls: new Set(input.pairs.map((p) => p.recallNumber)).size, heldOut: on("held_out"), train: on("train") };
}
