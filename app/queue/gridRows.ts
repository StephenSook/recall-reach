// What the grid shows, built on the server so only these fields reach the browser. The cards decide what can be
// approved: only a sale's lead has Approve, because a sale gets one question and the wrong one would block the right one.
import type { QueueCard, QueueRow, UnidentifiedPayment } from "@/server/queue/queue";
import { canNotify, needsApproval, NOTICE_STATE, pathChip, VERDICT_CHIP } from "./labels";

export type GridTab = "needs" | "cleared" | "shelf" | "unidentified" | "all";

export interface GridRow {
  matchId: string;
  recallNumber: string;
  product: string;
  itemTitle: string;
  verdict: QueueRow["verdict"] | "UNIDENTIFIED";
  state: string;
  path: string | null;
  soldOn: string | null;
  recallDate: string;
  reason: string;
  noticeState: string | null;
  isLead: boolean;
  approvable: boolean;
  weak: boolean;
  tellCpsc: boolean;
  listedOnShelf: boolean;
  /** The window this row opens. Null when there is nothing to do on it: its row already says why it cleared. */
  anchor: string | null;
}

/** CPSC's words and the sale date. No shop text, and nothing about a buyer. */
export const TELL_CPSC_COLUMNS = ["recallNumber", "product", "soldOn"] as const satisfies readonly (keyof GridRow)[];

export function gridRows(rows: QueueRow[], cards: QueueCard[]): GridRow[] {
  const cardOf = new Map<string, string>();
  for (const card of cards) for (const r of [card.lead, ...card.also]) cardOf.set(r.matchId, card.lead.matchId);
  const leads = new Set(cards.map((c) => c.lead.matchId));
  // One order on the page: the cards' leads as they stand, then the other recalls on those sales, then the rest.
  const rank = new Map<string, number>();
  for (const [i, card] of cards.entries()) {
    rank.set(card.lead.matchId, i);
    for (const r of card.also) rank.set(r.matchId, cards.length);
  }
  const place = (r: QueueRow) => rank.get(r.matchId) ?? cards.length + 1;

  return [...rows].sort((a, b) => place(a) - place(b)).map((r) => {
    const isLead = leads.has(r.matchId);
    const card = cardOf.get(r.matchId);
    return {
      matchId: r.matchId,
      recallNumber: r.recallNumber,
      product: r.product,
      itemTitle: r.itemTitle,
      verdict: r.verdict,
      state: VERDICT_CHIP[r.verdict],
      path: r.verdict === "MATCH" && r.salePath ? pathChip(r) : null,
      soldOn: r.orderedOn,
      recallDate: r.recallDate,
      reason: r.reason,
      noticeState: r.notice ? NOTICE_STATE[r.notice.state] : null,
      isLead,
      approvable: isLead && canNotify(r) && needsApproval(r),
      weak: r.strength === "PRODUCT_WORDS" || r.strength === "NO_SHARED_WORDS",
      tellCpsc: r.verdict === "MATCH" && r.salePath === "REFUND_ELIGIBLE",
      listedOnShelf: r.isListing && r.stillListed && r.verdict !== "CLEARED",
      anchor: card ? `#sale-${card}` : null,
    };
  });
}

/** Payments that name no item or order. They are not candidates for any recall, so they are in no other tab. */
export function unidentifiedRows(payments: UnidentifiedPayment[]): GridRow[] {
  return payments.map((p, i) => ({
    matchId: `unidentified-${i + 1}`,
    recallNumber: "",
    product: "",
    itemTitle: p.amountCents === null ? "A PayPal payment" : `A PayPal payment of ${(p.amountCents / 100).toFixed(2)} ${p.currency ?? ""}`.trim(),
    verdict: "UNIDENTIFIED" as const,
    state: "Couldn't identify",
    path: null,
    soldOn: p.paidOn,
    recallDate: "",
    reason: "It names no item or order, so it can't be checked against a recall. It is not cleared.",
    noticeState: null,
    isLead: false,
    approvable: false,
    weak: false,
    tellCpsc: false,
    listedOnShelf: false,
    anchor: null,
  }));
}

export function inTab(row: GridRow, tab: GridTab): boolean {
  if (tab === "unidentified") return row.verdict === "UNIDENTIFIED";
  if (row.verdict === "UNIDENTIFIED") return false;
  if (tab === "needs") return row.isLead;
  if (tab === "cleared") return row.verdict === "CLEARED";
  if (tab === "shelf") return row.listedOnShelf && row.isLead;
  return true;
}
