import type { ReplayOutcome, ReplayRow } from "@/server/replay/replay";

export const OUTCOME_CHIP: Record<ReplayOutcome, string> = { MATCH: "Matched", SCOPE_GAP: "Scope gap", CLEARED: "Cleared", NOT_NEAR: "Nothing near" };
export const SPLIT_CHIP: Record<NonNullable<ReplayRow["saleSplit"]>, string> = { NOTICE_ONLY: "Notice only", REVIEW: "Review date", REFUND_ELIGIBLE: "Refund eligible" };

export const seconds = (ms: number) => (ms / 1000).toFixed(1);
