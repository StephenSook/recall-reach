import type { EvalPair, Label, Score } from "@/server/eval/score";

/** In the words the bars on the page use. */
export const WRONG = {
  REACHES_FAMILY: "A seller could message a family",
  SHOWN_TO_SELLER: "Shown to the seller, and nothing can go out",
  MISSED: "Misses it",
} as const;

export interface WrongPair {
  pairId: string;
  recallNumber: string;
  recallTitle: string;
  title: string;
  really: string;
  outcome: (typeof WRONG)[keyof typeof WRONG];
}

const REALLY: Record<Label, string> = { MATCH: "The recalled product", UNSURE: "Title can't settle it", NEAR_MISS: "A look-alike", NO_MATCH: "A look-alike" };

/** Every held-out pair the matcher got wrong, for anyone who asks to see them. */
export function wrongPairs(pairs: EvalPair[], matcher: Pick<Score, "falseAlarmPairs" | "reachFamilyPairs" | "missedPairs">, recalls: { RecallNumber: string | number; Title: string }[]): WrongPair[] {
  const byId = new Map(pairs.map((p) => [p.pairId, p]));
  const titles = new Map(recalls.map((r) => [String(r.RecallNumber), r.Title]));
  const reachFamily = new Set(matcher.reachFamilyPairs);
  const row = (id: string, outcome: WrongPair["outcome"]): WrongPair => {
    const pair = byId.get(id);
    if (!pair) throw new Error(`the results name pair ${id}, which has no label`);
    return { pairId: id, recallNumber: pair.recallNumber, recallTitle: titles.get(pair.recallNumber) ?? "", title: pair.title, really: REALLY[pair.label], outcome };
  };
  return [
    ...matcher.falseAlarmPairs.map((id) => row(id, reachFamily.has(id) ? WRONG.REACHES_FAMILY : WRONG.SHOWN_TO_SELLER)),
    ...matcher.missedPairs.map((id) => row(id, WRONG.MISSED)),
  ];
}
