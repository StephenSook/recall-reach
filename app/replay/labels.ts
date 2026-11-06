import type { ReplayOutcome, ReplayRow } from "@/server/replay/replay";

export const OUTCOME_CHIP: Record<ReplayOutcome, string> = { MATCH: "Matched", SCOPE_GAP: "Scope gap", CLEARED: "Cleared", NOT_NEAR: "Nothing near" };
export const SPLIT_CHIP: Record<NonNullable<ReplayRow["saleSplit"]>, string> = { NOTICE_ONLY: "Notice only", REVIEW: "Review date", REFUND_ELIGIBLE: "Refund eligible" };

export const seconds = (ms: number) => (ms / 1000).toFixed(1);

/** Accounts for every match in the run, so the split adds up to the count beside it. */
export function matchSplitLine(rows: Pick<ReplayRow, "outcome" | "saleSplit">[]): string {
  const matches = rows.filter((r) => r.outcome === "MATCH");
  if (matches.length === 0) return "Nothing matched.";
  const count = (split: ReplayRow["saleSplit"]) => matches.filter((r) => r.saleSplit === split).length;
  const say = (k: number, one: string, many: string) => (k === 0 ? null : `${k} ${k === 1 ? one : many}`);
  const parts = [
    say(count("NOTICE_ONLY"), "sold before the recall and needs a notice", "sold before the recall and need a notice"),
    say(count("REFUND_ELIGIBLE"), "sold after it and can be refunded", "sold after it and can be refunded"),
    say(count("REVIEW"), "sold on the recall date and needs a look", "sold on the recall date and need a look"),
    say(count(null), "is still listed and has not been sold", "are still listed and have not been sold"),
  ].filter((part) => part !== null);
  const list = parts.length < 2 ? parts.join("") : `${parts.slice(0, -1).join(", ")}, and ${parts.at(-1)}`;
  return `Of the ${matches.length} ${matches.length === 1 ? "match" : "matches"}, ${list}.`;
}
