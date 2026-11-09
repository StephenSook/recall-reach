// What the grid shows, built on the server so only these fields reach the browser. The cards decide what can be
// approved: only a sale's lead has Approve, because a sale gets one question and the wrong one would block the right one.
import type { QueueCard, QueueRow, UnidentifiedPayment } from "@/server/queue/queue";
import { REFUND_WINDOW_DAYS } from "./recalls/timeline";
import { canNotify, needsApproval, NOTICE_STATE, pathNow, saleWaits, sharedWordOnly, sitsApart, stateChip } from "./labels";

export type GridTab = "needs" | "words" | "done" | "cleared" | "shelf" | "unidentified" | "all";

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
  /** Something is still only the seller's to do. */
  waits: boolean;
  approvable: boolean;
  weak: boolean;
  /** On a real shop's queue, a card with nothing but shared words and nothing done on it sits in its own tab. A demo shop has no such tab. */
  apart: boolean;
  tellCpsc: boolean;
  listedOnShelf: boolean;
  /** The window this row opens. Null when there is nothing to do on it: its row already says why it cleared. */
  anchor: string | null;
  /** Which sale this is. One sale can match several recalls, and is still one sale to add up or refund. */
  saleId: string | null;
  /** The sale's total in dollars from the shop's own order file. Null for another currency, so a sum never mixes them. */
  saleUsd: number | null;
  /** A confirmed match sold after the recall with a payment found, and no refund done or under way. */
  refundEligible: boolean;
}

const addDays = (day: string, days: number) => new Date(Date.parse(`${day}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);

/** What a store's listings have no use for, or no right to say: nothing there was sold, and nothing can be sent. */
const SALE_COLUMNS = ["path", "soldOn", "noticeState", "saleUsd"];

/** The columns a queue leaves out. Message comes back with the first message. */
export function hiddenColumns(rows: Pick<GridRow, "noticeState">[], listings: boolean): Set<string> {
  const hidden = new Set(listings ? SALE_COLUMNS : []);
  if (!rows.some((r) => r.noticeState)) hidden.add("noticeState");
  return hidden;
}

/** A row with no sale date is an item on the shelf, not a blank. */
export const soldLabel = (row: Partial<Pick<GridRow, "soldOn" | "listedOnShelf">>): string | null => row.soldOn ?? (row.listedOnShelf ? "On the shelf" : null);

/** CPSC's words and the sale date. No shop text, and nothing about a buyer. */
export const TELL_CPSC_COLUMNS = ["recallNumber", "product", "soldOn"] as const satisfies readonly (keyof GridRow)[];

export function gridRows(rows: QueueRow[], cards: QueueCard[], opts: { sharedWordsApart?: boolean; listings?: boolean; today?: string } = {}): GridRow[] {
  const cardOf = new Map<string, string>();
  for (const card of cards) for (const r of [card.lead, ...card.also]) cardOf.set(r.matchId, card.lead.matchId);
  const leads = new Set(cards.map((c) => c.lead.matchId));
  const waiting = new Set(cards.filter(saleWaits).map((c) => c.lead.matchId));
  const apart = new Set(opts.sharedWordsApart ? cards.filter(sitsApart).map((c) => c.lead.matchId) : []);
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
    // A line discounted past its price has nothing to refund, as refundAmountCents reads it.
    const saleCents = r.saleCents === null || r.saleCents === undefined ? null : Math.max(0, r.saleCents);
    const windowOpen = !opts.today || !r.orderedOn || addDays(r.orderedOn, REFUND_WINDOW_DAYS) >= opts.today;
    return {
      matchId: r.matchId,
      recallNumber: r.recallNumber,
      product: r.product,
      itemTitle: r.itemTitle,
      verdict: r.verdict,
      state: stateChip(r),
      path: pathNow(r),
      soldOn: r.orderedOn,
      recallDate: r.recallDate,
      reason: r.reason,
      noticeState: r.notice ? NOTICE_STATE[r.notice.state] : null,
      isLead,
      // Nothing on a store's listings is ever done here: no message or refund can come from one.
      waits: opts.listings ? true : waiting.has(r.matchId),
      approvable: isLead && canNotify(r) && needsApproval(r),
      weak: sharedWordOnly(r),
      apart: apart.has(r.matchId),
      tellCpsc: r.verdict === "MATCH" && r.salePath === "REFUND_ELIGIBLE",
      listedOnShelf: r.isListing && r.stillListed && r.verdict !== "CLEARED" && !sharedWordOnly(r),
      anchor: card ? `#sale-${card}` : null,
      saleId: r.recordId,
      saleUsd: saleCents !== null && r.saleCurrency === "USD" && !r.orderIncomplete ? saleCents / 100 : null,
      refundEligible: r.verdict === "MATCH" && r.strength === "CONFIRMED" && r.salePath === "REFUND_ELIGIBLE" && r.joinState === "IDENTIFIED" && (!r.refund || r.refund.status === "failed") && saleCents !== 0 && !r.orderIncomplete && windowOpen && r.paymentHeld !== false,
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
    waits: false,
    approvable: false,
    weak: false,
    apart: false,
    tellCpsc: false,
    listedOnShelf: false,
    anchor: null,
    saleId: null,
    saleUsd: null,
    refundEligible: false,
  }));
}

export function inTab(row: GridRow, tab: GridTab): boolean {
  if (tab === "unidentified") return row.verdict === "UNIDENTIFIED";
  if (row.verdict === "UNIDENTIFIED") return false;
  if (tab === "words") return row.apart;
  if (tab === "needs") return row.isLead && row.waits && !row.apart;
  if (tab === "done") return row.isLead && !row.waits && !row.apart;
  if (tab === "cleared") return row.verdict === "CLEARED";
  if (tab === "shelf") return row.listedOnShelf && row.isLead;
  return true;
}
