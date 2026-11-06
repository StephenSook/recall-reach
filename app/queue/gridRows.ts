// What the grid shows, built on the server so only these fields reach the browser. The cards decide what can be
// approved: only a sale's lead has Approve, because a sale gets one question and the wrong one would block the right one.
import type { QueueCard, QueueRow } from "@/server/queue/queue";
import { canNotify, needsApproval, NOTICE_STATE, PATH_CHIP, VERDICT_CHIP } from "./labels";

export type GridTab = "needs" | "cleared" | "shelf" | "all";

export interface GridRow {
  matchId: string;
  recallNumber: string;
  product: string;
  itemTitle: string;
  verdict: QueueRow["verdict"];
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
  /** Where this row is on the page. Null for a recall that is only counted there. */
  anchor: string | null;
}

/** CPSC's words and the sale date. No shop text, and nothing about a buyer. */
export const TELL_CPSC_COLUMNS = ["recallNumber", "product", "soldOn"] as const satisfies readonly (keyof GridRow)[];

export function gridRows(rows: QueueRow[], { cards, cleared }: { cards: QueueCard[]; cleared: QueueRow[] }): GridRow[] {
  const cardOf = new Map<string, string>();
  for (const card of cards) for (const r of [card.lead, ...card.also]) cardOf.set(r.matchId, card.lead.matchId);
  const leads = new Set(cards.map((c) => c.lead.matchId));
  const listed = new Set(cleared.map((r) => r.matchId));

  return rows.map((r) => {
    const isLead = leads.has(r.matchId);
    const card = cardOf.get(r.matchId);
    return {
      matchId: r.matchId,
      recallNumber: r.recallNumber,
      product: r.product,
      itemTitle: r.itemTitle,
      verdict: r.verdict,
      state: VERDICT_CHIP[r.verdict],
      path: r.verdict === "MATCH" && r.salePath ? PATH_CHIP[r.salePath] : null,
      soldOn: r.orderedOn,
      recallDate: r.recallDate,
      reason: r.reason,
      noticeState: r.notice ? NOTICE_STATE[r.notice.state] : null,
      isLead,
      approvable: isLead && canNotify(r) && needsApproval(r),
      weak: r.strength === "PRODUCT_WORDS" || r.strength === "NO_SHARED_WORDS",
      tellCpsc: r.verdict === "MATCH" && r.salePath === "REFUND_ELIGIBLE",
      listedOnShelf: r.isListing && r.stillListed && r.verdict !== "CLEARED",
      anchor: card ? `#sale-${card}` : listed.has(r.matchId) ? `#match-${r.matchId}` : null,
    };
  });
}

export function inTab(row: GridRow, tab: GridTab): boolean {
  if (tab === "needs") return row.isLead;
  if (tab === "cleared") return row.verdict === "CLEARED";
  if (tab === "shelf") return row.listedOnShelf;
  return true;
}
