// The eval: does the matcher leave look-alikes alone, and does it abstain when the title can't settle it? Every pair
// goes through the real pipeline, retrieval included. The word-match baseline flags whatever retrieval finds, with no
// rules and no way to abstain, which is what a plain search would do.
import { recordPull } from "../cpsc/pull";
import { migrate } from "../db/migrate";
import type { Db } from "../db/types";
import { createShop, storeOrderLines } from "../import/store";
import { runShopCheck } from "../match/run";
import type { Strength, Verdict } from "../match/verdict";
import { createContactCipher } from "../privacy/contactCipher";
import { score, type Decision, type EvalPair, type EvalResults } from "./score";

export * from "./score";

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
