// The exact words on the seller's screen (research/COPY-DECK.md).
import type { QueueData, QueueRow } from "@/server/queue/queue";

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

/** One word for one, another for any other number. */
export const counted = (n: number, one: string, many: string) => (n === 1 ? one : many);

/** What the stat row shows. Each number is counted from what is on the page. */
export function queueCounts(q: { cards: { lead: { verdict: string } }[]; cleared: unknown[]; unrelated: number; recallsChecked: number | null }) {
  const matched = q.cards.filter((c) => c.lead.verdict === "MATCH").length;
  return { recallsChecked: q.recallsChecked, matched, scopeGaps: q.cards.length - matched, cleared: q.cleared.length + q.unrelated, waiting: q.cards.length };
}

/** Color carries meaning, and red means a refund is possible. Everything else on a chip is plain. */
export const chipClass = (chip: string) => (chip === PATH_CHIP.REFUND_ELIGIBLE ? "chip chip-refund" : "chip");

const AGENT_HEADLINE: Record<string, string> = {
  SAME_PRODUCT: "Claude: the words point to this product",
  CANT_TELL: "Claude: can't tell from the words",
  DIFFERENT_PRODUCT: "Claude: the words point to a different product",
  NO_FINDING: "Claude gave no finding",
  REFUSED: "Claude declined to answer",
  STEP_LIMIT: "Claude stopped before a finding",
};

/** What Claude found, in plain words. It describes the text, never whether a product is safe. */
export function agentHeadline(run: { outcome: string; finding: string | null }): string {
  return AGENT_HEADLINE[run.finding ?? run.outcome] ?? AGENT_HEADLINE.NO_FINDING;
}

/** One step of how it checked. */
export function traceLine(step: { tool: string; ok: boolean; item?: string; query?: string; found?: number; note?: string }): string {
  if (!step.ok) return `Sent back: ${step.note ?? "that did not pass a check."}`;
  if (step.tool === "read_recall") return "Read the recall";
  if (step.tool === "read_shop_item") return `Read ${step.item ?? "an item"}`;
  if (step.tool === "search_shop_items") return `Searched your shop for "${step.query ?? ""}": ${step.found ?? 0} found`;
  return "Recorded its finding";
}

/** Says "Searched" only when all of PayPal's history was read. Anything less means no dates and no payment count. */
export function coverageLine(c: NonNullable<QueueData["coverage"]>): string {
  const searched = c.paypalSearched
    ? `Searched ${c.searchedFrom ?? c.searchedTo} to ${c.searchedTo}. ${c.unidentifiedPayments} ${counted(c.unidentifiedPayments, "payment", "payments")} couldn't be identified.`
    : c.failedWindows > 0
      ? `PayPal's history was only partly read: ${c.failedWindows} of ${c.searchWindows} searches failed.`
      : "PayPal's history was not searched.";
  const left = c.candidatesNotChecked > 0 ? ` ${c.candidatesNotChecked} candidates were not checked.` : "";
  const range = c.recallsFrom && c.recallsTo ? `, ${c.recallsFrom} to ${c.recallsTo}` : "";
  return `${searched} Checked ${c.recallsChecked.toLocaleString("en-US")} recalls${range}.${left}`;
}

/** Whether anything may go out on this row at all: there has to be a buyer, one order, and more than product words. */
export const canNotify = (row: Pick<QueueRow, "verdict" | "isListing" | "joinState" | "strength">) =>
  row.verdict !== "CLEARED" && !row.isListing && row.joinState !== "AMBIGUOUS_JOIN" && row.strength !== "PRODUCT_WORDS" && row.strength !== "NO_SHARED_WORDS";

/** Whether a message for this row is waiting on the seller's approval. */
export function needsApproval(row: Pick<QueueRow, "verdict" | "notice">): boolean {
  const n = row.notice;
  if (!n) return true;
  const safety = n.kind === "SAFETY_NOTICE";
  const confirmed = row.verdict === "MATCH";
  // The evidence changed before it went out, so it needs approving again as the right message.
  if (n.state === "PREPARED" || n.state === "OPENED_IN_MAIL") return safety !== confirmed;
  // A question went out and the recall has since been confirmed: the family still has to be told.
  return !safety && confirmed;
}

/** A refund needs the payment. Sold after the recall is still worth saying when that payment isn't known. */
export const pathChip = (row: Pick<QueueRow, "salePath" | "joinState">) =>
  row.salePath === "REFUND_ELIGIBLE" && row.joinState === "HISTORY_UNAVAILABLE" ? "Sold after the recall" : row.salePath ? PATH_CHIP[row.salePath] : "";

/** The chips on a card. A sale path is a claim about a confirmed match, so it shows on nothing else. */
export function chipsFor(row: Pick<QueueRow, "verdict" | "strength" | "salePath" | "joinState" | "isListing" | "stillListed">): string[] {
  const chips: string[] = [VERDICT_CHIP[row.verdict]];
  if (row.verdict === "CLEARED") return chips;
  if (row.verdict === "MATCH" && row.salePath) chips.push(pathChip(row));
  if (row.strength === "PRODUCT_WORDS") chips.push("Product words only");
  const join = row.joinState ? JOIN_CHIP[row.joinState] : undefined;
  if (join) chips.push(join);
  if (row.isListing && row.stillListed) chips.push("Pull from the shelf");
  return chips;
}
