// The exact words on the seller's screen (research/COPY-DECK.md).
import type { QueueRow } from "@/server/queue/queue";

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
  reserved: "Refund not sent yet",
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

/** The chips on a card. A sale path is a claim about a confirmed match, so it shows on nothing else. */
export function chipsFor(row: Pick<QueueRow, "verdict" | "strength" | "salePath" | "joinState" | "isListing" | "stillListed">): string[] {
  const chips: string[] = [VERDICT_CHIP[row.verdict]];
  if (row.verdict === "CLEARED") return chips;
  if (row.verdict === "MATCH" && row.salePath) chips.push(PATH_CHIP[row.salePath]);
  if (row.strength === "PRODUCT_WORDS") chips.push("Product words only");
  const join = row.joinState ? JOIN_CHIP[row.joinState] : undefined;
  if (join) chips.push(join);
  if (row.isListing && row.stillListed) chips.push("Pull from the shelf");
  return chips;
}
