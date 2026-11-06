import type { ReplayOutcome, ReplayRow } from "@/server/replay/replay";

export const OUTCOME_CHIP: Record<ReplayOutcome, string> = { MATCH: "Matched", SCOPE_GAP: "Scope gap", CLEARED: "Cleared", NOT_NEAR: "Nothing near" };
export const SPLIT_CHIP: Record<NonNullable<ReplayRow["saleSplit"]>, string> = { NOTICE_ONLY: "Notice only", REVIEW: "Review date", REFUND_ELIGIBLE: "Refund eligible" };

export const seconds = (ms: number) => (ms / 1000).toFixed(1);

const ranFormat = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", dateStyle: "medium", timeStyle: "short" });

/** When a run was made, so nobody takes an old run for a new one. */
export const ranAt = (iso: string) => `${ranFormat.format(new Date(iso)).replace(/\s+/g, " ")} ET`;

/** "Every" holds only when every year loaded. */
export const replayIntro = (yearsMissing: number[]) =>
  yearsMissing.length === 0
    ? "Every real CPSC recall from 2025 on, checked against the demo shop in one run."
    : "The real CPSC recalls loaded from 2025 on, checked against the demo shop in one run.";

export const replayGap = (yearsMissing: number[]) =>
  yearsMissing.length === 0 ? null : `Recalls from ${yearsMissing.join(", ")} did not fully load, so this run didn't check them.`;

/** Accounts for every recall matched, in the same unit as the count beside it: Replay counts recalls, not sales. */
export function matchSplitLine(rows: Pick<ReplayRow, "outcome" | "saleSplit">[]): string {
  const matches = rows.filter((r) => r.outcome === "MATCH");
  if (matches.length === 0) return "No recalls matched.";
  const count = (split: ReplayRow["saleSplit"]) => matches.filter((r) => r.saleSplit === split).length;
  const parts = [
    { k: count("NOTICE_ONLY"), one: "has a sale before the recall and needs a notice", many: "have a sale before the recall and need a notice" },
    { k: count("REFUND_ELIGIBLE"), one: "has a sale after it that can be refunded", many: "have a sale after it that can be refunded" },
    { k: count("REVIEW"), one: "has a sale on the recall date and needs a look", many: "have a sale on the recall date and need a look" },
    { k: count(null), one: "has a listing with no sale", many: "have a listing with no sale" },
  ].filter((p) => p.k > 0);
  if (matches.length === 1) return `The 1 recall matched ${parts[0].one}.`;
  const said = parts.map((p) => `${p.k} ${p.k === 1 ? p.one : p.many}`);
  const list = said.length < 2 ? said.join("") : `${said.slice(0, -1).join(", ")}, and ${said.at(-1)}`;
  return `Of the ${matches.length} recalls matched, ${list}.`;
}
