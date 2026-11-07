// The exact words on the seller's screen.
import { ranAt } from "@/app/replay/labels";
import type { QueueData, QueueRow } from "@/server/queue/queue";

export const VERDICT_CHIP = { MATCH: "Needs review", SCOPE_GAP: "Can't tell yet", CLEARED: "Cleared" } as const;
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

const CHECK_CHIP: Record<string, string> = {
  MATCHES: "Family's answer matches",
  DOESNT_MATCH: "Family's answer doesn't match",
  CANT_TELL: "Family's answer didn't settle it",
};

/** One word for one, another for any other number. */
export const counted = (n: number, one: string, many: string) => (n === 1 ? one : many);

/** A refund the seller can start now. One that failed can be tried again, because PayPal refused it. Anything else could pay twice. */
export function refundOnOffer(row: Pick<QueueRow, "verdict" | "strength" | "salePath" | "joinState" | "refund">): boolean {
  const eligible = row.verdict === "MATCH" && row.strength === "CONFIRMED" && row.salePath === "REFUND_ELIGIBLE" && row.joinState === "IDENTIFIED";
  return eligible && (!row.refund || row.refund.status === "failed");
}

/**
 * Whether there is still something only the seller can do. Telling the family comes first: a refund made with no
 * notice sent still waits, because it is still a recall. A refund isn't finished until PayPal has refunded it.
 */
export function waitsOnSeller(row: Pick<QueueRow, "verdict" | "strength" | "salePath" | "joinState" | "isListing" | "stillListed" | "notice" | "refund">): boolean {
  if (row.refund && row.refund.status !== "refunded") return true;
  if (row.verdict === "CLEARED") return false;
  if (row.isListing) return row.stillListed;
  if (refundOnOffer(row)) return true;
  // Nothing can go out on this row, so nobody else will ever settle it.
  if (!canNotify(row)) return true;
  // Sold on the recall date: the family can be told, and a person still has to decide about the money.
  if (row.verdict === "MATCH" && row.salePath === "REVIEW") return true;
  const told = row.notice?.state === "MARKED_SENT" || row.notice?.state === "FAMILY_RESPONDED";
  if (!told || needsApproval(row)) return true;
  return row.notice?.result === "CANT_TELL";
}

type CountedRow = Parameters<typeof waitsOnSeller>[0];

/**
 * The one rule behind the wait count, the Needs review tab and Done. A card is a sale: a family's no about its lead
 * doesn't settle the other recalls that came near it, and they can't be asked about from here.
 */
export function saleWaits(card: { lead: CountedRow; also: unknown[] }): boolean {
  return waitsOnSeller(card.lead) || (card.lead.notice?.result === "DOESNT_MATCH" && card.also.length > 0);
}

/** What the stat row shows. The tiles are what the check found, so they stay. The wait count goes down as work gets done. */
export function queueCounts(q: { cards: { lead: CountedRow; also: unknown[] }[]; cleared: unknown[]; unrelated: number; recallsChecked: number | null }) {
  const matched = q.cards.filter((c) => c.lead.verdict === "MATCH").length;
  return { recallsChecked: q.recallsChecked, matched, scopeGaps: q.cards.length - matched, cleared: q.cleared.length + q.unrelated, waiting: q.cards.filter(saleWaits).length };
}

/** Only a shared word with a recall. Worth seeing, but not worth pulling anything off a shelf for. */
export const sharedWordOnly = (row: Pick<QueueRow, "strength">) => row.strength === "PRODUCT_WORDS" || row.strength === "NO_SHARED_WORDS";

type CardRow = Pick<QueueRow, "strength" | "notice" | "refund" | "approval">;

/** Apart only when a card holds nothing but shared words and nothing has been done on it: a seller never loses sight of work they owe. */
export const sitsApart = (card: { lead: CardRow; also: CardRow[] }) => [card.lead, ...card.also].every((r) => sharedWordOnly(r) && !r.notice && !r.refund && !r.approval);

/** A real shop's cards, split by what they rest on. Each record counts once, under the strongest thing it came near. */
export function splitCounts(cards: { lead: CardRow & Pick<QueueRow, "recordId">; also: CardRow[] }[]) {
  const strong = new Set(cards.filter((c) => !sitsApart(c)).map((c) => c.lead.recordId));
  const word = new Set(cards.map((c) => c.lead.recordId).filter((id) => !strong.has(id)));
  return { needCheck: strong.size, sharedWord: word.size };
}

/** What the tiles say for a store read from its listings. */
export function listingCounts(cards: Parameters<typeof splitCounts>[0], total: number) {
  const { needCheck, sharedWord } = splitCounts(cards);
  // Not "clear": the check keeps the closest titles per recall, so a listing past that cap has no card and wasn't read.
  return { total, needCheck, sharedWord, notFlagged: total - needCheck - sharedWord };
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

/** A stored answer can be days old, and the main model can hand over to the fallback, so the card says both. */
export const agentChecked = (run: { model: string; checkedAt: string; fellBack: boolean }) =>
  `Checked ${ranAt(run.checkedAt)} by ${run.model}${run.fellBack ? ", the fallback model" : ""}`;

/** One step of how it checked. */
export function traceLine(step: { tool: string; ok: boolean; item?: string; query?: string; found?: number; note?: string }): string {
  if (!step.ok) return `Sent back: ${step.note ?? "that did not pass a check."}`;
  if (step.tool === "read_recall") return "Read the recall";
  if (step.tool === "read_shop_item") return `Read ${step.item ?? "an item"}`;
  if (step.tool === "search_shop_items") return `Searched your shop for "${step.query ?? ""}": ${step.found ?? 0} found`;
  return "Recorded its finding";
}

const recallsLine = (c: NonNullable<QueueData["coverage"]>) => {
  const left = c.candidatesNotChecked > 0 ? ` ${c.candidatesNotChecked} candidates were not checked.` : "";
  const range = c.recallsFrom && c.recallsTo ? `, ${c.recallsFrom} to ${c.recallsTo}` : "";
  const gap = c.recallYearsMissing.length > 0 ? ` Recalls from ${c.recallYearsMissing.join(", ")} did not fully load.` : "";
  return `Checked ${c.recallsChecked.toLocaleString("en-US")} recalls${range}.${gap}${left}`;
};

/** A store read from its listings: what was read, and what that can't show. */
export function listingCoverageLine(c: NonNullable<QueueData["coverage"]>, listings: NonNullable<QueueData["listings"]>): string {
  return `Read ${listings.total.toLocaleString("en-US")} ${counted(listings.total, "listing", "listings")}, ${listings.forSale.toLocaleString("en-US")} for sale now. No sales or PayPal history were read. ${recallsLine(c)}`;
}

/** Says "Searched" only when all of PayPal's history was read. Anything less means no dates and no payment count. */
export function coverageLine(c: NonNullable<QueueData["coverage"]>): string {
  const searched = c.paypalSearched
    ? `Searched ${c.searchedFrom ?? c.searchedTo} to ${c.searchedTo}. ${c.unidentifiedPayments} ${counted(c.unidentifiedPayments, "payment", "payments")} couldn't be identified.`
    : c.failedWindows > 0
      ? `PayPal's history was only partly read: ${c.failedWindows} of ${c.searchWindows} searches failed.`
      : "PayPal's history was not searched.";
  return `${searched} ${recallsLine(c)}`;
}

/** Whether anything may go out on this row at all: there has to be a buyer, one order, and more than product words. */
export const canNotify = (row: Pick<QueueRow, "verdict" | "isListing" | "joinState" | "strength">) =>
  row.verdict !== "CLEARED" && !row.isListing && row.joinState !== "AMBIGUOUS_JOIN" && row.strength !== "PRODUCT_WORDS" && row.strength !== "NO_SHARED_WORDS";

/** Whether a message for this row is waiting on the seller's approval. */
export function needsApproval(row: Pick<QueueRow, "verdict" | "notice"> & Partial<Pick<QueueRow, "recallChanged">>): boolean {
  const n = row.notice;
  if (!n) return true;
  // CPSC changed the recall after the check, and this hasn't gone out: it's read again on approval.
  if (row.recallChanged && (n.state === "PREPARED" || n.state === "OPENED_IN_MAIL")) return true;
  const safety = n.kind === "SAFETY_NOTICE";
  const confirmed = row.verdict === "MATCH";
  // The evidence changed before it went out, so it needs approving again as the right message.
  if (n.state === "PREPARED" || n.state === "OPENED_IN_MAIL") return safety !== confirmed;
  // A question went out and the recall has since been confirmed: the family still has to be told.
  return !safety && confirmed;
}

/** "A payment", not "paid": PayPal's search also lists pending and reversed payments, and a linked one can be any of them. */
export const paymentLine = (row: Pick<QueueRow, "verdict" | "joinState" | "isListing">) =>
  row.joinState === "IDENTIFIED" && !row.isListing && row.verdict !== "CLEARED" ? "PayPal's records show a payment for this sale." : null;

/** "Refund eligible" only when the card offers one. Sold after the recall is still worth saying when it doesn't. */
export const pathChip = (row: Pick<QueueRow, "verdict" | "strength" | "salePath" | "joinState" | "refund">) =>
  !row.salePath ? "" : row.salePath === "REFUND_ELIGIBLE" && !refundOnOffer(row) ? "Sold after the recall" : PATH_CHIP[row.salePath];

/**
 * What has happened on this row, once anything has. Until then, what the check found. A family's yes stays the
 * family's yes: only the check can confirm a match, so these words never say confirmed.
 */
export function stateChip(row: Pick<QueueRow, "verdict" | "notice" | "refund">): string {
  if (row.verdict === "CLEARED") return VERDICT_CHIP.CLEARED;
  if (row.refund) return REFUND_STATE[row.refund.status];
  const notice = row.notice;
  if (!notice || needsApproval(row)) return VERDICT_CHIP[row.verdict];
  return (notice.result && CHECK_CHIP[notice.result]) || NOTICE_STATE[notice.state];
}

/** A sale's path, for a confirmed match. A refund made or under way is no longer on offer. One that failed can be tried again. */
export const pathNow = (row: Pick<QueueRow, "verdict" | "strength" | "salePath" | "joinState" | "refund">) =>
  row.verdict === "MATCH" && row.salePath && (!row.refund || row.refund.status === "failed") ? pathChip(row) : null;

/** The chips on a card. A sale path is a claim about a confirmed match, so it shows on nothing else. */
export function chipsFor(row: Pick<QueueRow, "verdict" | "strength" | "salePath" | "joinState" | "isListing" | "stillListed" | "notice" | "refund">): string[] {
  const chips: string[] = [stateChip(row)];
  if (row.verdict === "CLEARED") return chips;
  const path = pathNow(row);
  if (path) chips.push(path);
  if (row.strength === "PRODUCT_WORDS") chips.push("Product words only");
  const join = row.joinState ? JOIN_CHIP[row.joinState] : undefined;
  if (join) chips.push(join);
  // Pulling something is for a title that names a recalled model. A brand alone only says go and look.
  if (row.isListing && row.stillListed && row.strength === "CONFIRMED") chips.push("Pull from the shelf");
  if (row.isListing && row.stillListed && row.strength === "BRAND") chips.push("Check the shelf");
  if (row.isListing && !row.stillListed) chips.push("Not for sale now");
  return chips;
}
