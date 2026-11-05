// The exact words on the seller's screen (research/COPY-DECK.md).
export const VERDICT_CHIP = { MATCH: "Needs review", SCOPE_GAP: "Scope gap", CLEARED: "Cleared" } as const;
export const PATH_CHIP = { NOTICE_ONLY: "Notice only", REVIEW: "Review date", REFUND_ELIGIBLE: "Refund eligible" } as const;
export const JOIN_CHIP: Record<string, string | undefined> = {
  AMBIGUOUS_JOIN: "Two possible orders",
  HISTORY_UNAVAILABLE: "History unavailable",
};
export const NOTICE_STATE = {
  PREPARED: "Prepared",
  OPENED_IN_MAIL: "Opened in mail",
  MARKED_SENT: "You marked sent",
  FAMILY_RESPONDED: "Family responded",
} as const;
export const REFUND_STATE: Record<string, string> = {
  pending: "Refund pending at PayPal",
  refunded: "Refunded",
  failed: "Refund failed",
  unconfirmed: "Refund not confirmed",
};
export const CHECK_RESULT: Record<string, string> = {
  MATCHES: "Family's answer matches the recall",
  DOESNT_MATCH: "Family's answer does not match the recall details",
  CANT_TELL: "Family's answer could not settle it",
};
