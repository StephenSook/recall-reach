// What the seller's queue shows. No raw PayPal id leaves this function: the page never needs one.
import type { Queryable } from "../db/types";
import { noticeState, type NoticeState } from "../notice/store";
import type { Strength } from "../match/verdict";

export interface QueueRow {
  matchId: string;
  /** The one sale or listing this row is about. */
  recordId: string;
  recallNumber: string;
  recallTitle: string;
  recallDate: string;
  recallUrl: string;
  product: string;
  itemTitle: string;
  /** Where the shop's text came from, including whether its date is seeded demo data. */
  source: string;
  orderedOn: string | null;
  verdict: "MATCH" | "SCOPE_GAP" | "CLEARED";
  strength: Strength;
  salePath: "NOTICE_ONLY" | "REVIEW" | "REFUND_ELIGIBLE" | null;
  joinState: string | null;
  matched: string[];
  missing: string[];
  reason: string;
  isListing: boolean;
  stillListed: boolean;
  notice: { id: string; kind: string; state: NoticeState; stopped: boolean; result: string | null } | null;
  approval: { id: string; amountCents: number; currency: string; expiresAt: string } | null;
  refund: { id: string; status: string; amountCents: number; currency: string; failure: string | null } | null;
}

export interface QueueData {
  shop: { name: string; kind: string } | null;
  coverage: {
    recallsChecked: number;
    searchedFrom: string | null;
    searchedTo: string;
    unidentifiedPayments: number;
    paypalSearched: boolean;
    candidatesNotChecked: number;
  } | null;
  rows: QueueRow[];
}

const VERDICT_ORDER = { MATCH: 0, SCOPE_GAP: 1, CLEARED: 2 } as const;

export async function loadQueue(db: Queryable, shopId: string, sessionId: string): Promise<QueueData> {
  const shop = await db.query<{ name: string; kind: string }>("select name, kind from shops where id = $1", [shopId]);
  const run = await db.query<{
    recalls_checked: number;
    searched_from: string | null;
    searched_to: string;
    unidentified_payments: number;
    paypal_searched: boolean;
    candidates_not_checked: number;
  }>(
    `select recalls_checked, searched_from, searched_to, unidentified_payments, paypal_searched, candidates_not_checked
     from shop_runs where shop_id = $1 order by finished_at desc limit 1`,
    [shopId],
  );
  const { rows } = await db.query<Record<string, never>>(
    `select m.id as match_id, m.verdict, m.strength, m.sale_path, m.join_state, m.matched, m.missing, m.reason, m.order_line_id, m.shop_item_id,
            r.recall_number, r.title as recall_title, r.recall_date, r.url as recall_url, r.products,
            coalesce(l.title, i.title) as item_title, coalesce(l.source, i.source) as source,
            l.ordered_on, coalesce(i.listed, false) as still_listed,
            n.id as notice_id, n.kind as notice_kind, n.opened_at, n.sent_at, n.responded_at, n.family_stopped, n.check_result,
            a.id as approval_id, a.amount_cents as approval_amount, a.currency as approval_currency, a.expires_at as approval_expires,
            rf.id as refund_id, rf.status as refund_status, rf.amount_cents as refund_amount, rf.currency as refund_currency, rf.failure as refund_failure
     from recall_matches m
     join recalls r on r.recall_id = m.recall_id
     left join order_lines l on l.id = m.order_line_id
     left join shop_items i on i.id = m.shop_item_id
     left join notices n on n.match_id = m.id
     left join lateral (
       select * from approvals x
       where x.order_line_id = m.order_line_id and x.recall_id = m.recall_id and x.session_id = $2
         and x.consumed_at is null and x.expires_at > now()
       order by x.created_at desc limit 1
     ) a on true
     left join lateral (
       select * from refunds y where y.order_line_id = m.order_line_id order by y.created_at desc limit 1
     ) rf on m.order_line_id is not null
     where m.shop_id = $1`,
    [shopId, sessionId],
  );

  const out = (rows as unknown as Record<string, unknown>[]).map(
    (r): QueueRow => ({
      matchId: String(r.match_id),
      recordId: String(r.order_line_id ?? r.shop_item_id),
      recallNumber: String(r.recall_number),
      recallTitle: String(r.recall_title),
      recallDate: String(r.recall_date),
      recallUrl: String(r.recall_url),
      product: (r.products as { name: string }[])[0]?.name ?? String(r.recall_title),
      itemTitle: String(r.item_title),
      source: String(r.source),
      orderedOn: (r.ordered_on as string | null) ?? null,
      verdict: r.verdict as QueueRow["verdict"],
      salePath: (r.sale_path as QueueRow["salePath"]) ?? null,
      joinState: (r.join_state as string | null) ?? null,
      strength: (r.strength as Strength | null) ?? "BRAND",
      matched: r.matched as string[],
      missing: r.missing as string[],
      reason: String(r.reason),
      isListing: r.shop_item_id !== null,
      stillListed: Boolean(r.still_listed),
      notice: r.notice_id
        ? {
            id: String(r.notice_id),
            kind: String(r.notice_kind),
            state: noticeState({ opened_at: r.opened_at, sent_at: r.sent_at, responded_at: r.responded_at }),
            stopped: Boolean(r.family_stopped),
            result: (r.check_result as string | null) ?? null,
          }
        : null,
      approval: r.approval_id
        ? {
            id: String(r.approval_id),
            amountCents: Number(r.approval_amount),
            currency: String(r.approval_currency),
            expiresAt: new Date(r.approval_expires as string).toISOString(),
          }
        : null,
      refund: r.refund_id
        ? {
            id: String(r.refund_id),
            status: String(r.refund_status),
            amountCents: Number(r.refund_amount),
            currency: String(r.refund_currency),
            failure: (r.refund_failure as string | null) ?? null,
          }
        : null,
    }),
  );
  out.sort(
    (a, b) => VERDICT_ORDER[a.verdict] - VERDICT_ORDER[b.verdict] || a.recallNumber.localeCompare(b.recallNumber) || a.itemTitle.localeCompare(b.itemTitle),
  );

  const c = run.rows[0];
  return {
    shop: shop.rows[0] ?? null,
    coverage: c
      ? {
          recallsChecked: c.recalls_checked,
          searchedFrom: c.searched_from,
          searchedTo: c.searched_to,
          unidentifiedPayments: c.unidentified_payments,
          paypalSearched: c.paypal_searched,
          candidatesNotChecked: c.candidates_not_checked,
        }
      : null,
    rows: out,
  };
}

/** One sale or listing, and the recalls it could belong to. At most one thing goes out for it. */
export interface QueueCard {
  lead: QueueRow;
  also: QueueRow[];
}

const STRENGTH_ORDER: Record<Strength, number> = { CONFIRMED: 0, BRAND: 1, PRODUCT_WORDS: 2, NO_SHARED_WORDS: 3 };
const actedOn = (r: QueueRow) => r.notice !== null || r.approval !== null || r.refund !== null;
const stronger = (a: QueueRow, b: QueueRow) =>
  Number(actedOn(b)) - Number(actedOn(a)) ||
  STRENGTH_ORDER[a.strength] - STRENGTH_ORDER[b.strength] ||
  b.recallDate.localeCompare(a.recallDate) ||
  b.recallNumber.localeCompare(a.recallNumber);

/**
 * Turns rows into what a seller reads: one card per sale, led by its strongest candidate, with the rest
 * under it. A weak candidate stays visible and never becomes a cleared row to reduce noise. The exception
 * is a confirmed match: each is a separate hazard the family should hear about, so each has its own card.
 */
export function toCards(rows: QueueRow[]): { cards: QueueCard[]; cleared: QueueRow[]; unrelated: number } {
  const open = new Map<string, QueueRow[]>();
  for (const row of rows) {
    if (row.verdict === "CLEARED") continue;
    open.set(row.recordId, [...(open.get(row.recordId) ?? []), row]);
  }
  const cards: QueueCard[] = [];
  for (const candidates of open.values()) {
    const sorted = [...candidates].sort(stronger);
    const confirmed = sorted.filter((r) => r.verdict === "MATCH");
    const others = sorted.filter((r) => r.verdict !== "MATCH");
    if (confirmed.length === 0) cards.push({ lead: others[0], also: others.slice(1) });
    confirmed.forEach((lead, i) => cards.push({ lead, also: i === 0 ? others : [] }));
  }
  cards.sort((a, b) => STRENGTH_ORDER[a.lead.strength] - STRENGTH_ORDER[b.lead.strength] || stronger(a.lead, b.lead));
  const clearedRows = rows.filter((r) => r.verdict === "CLEARED");
  return {
    cards,
    cleared: clearedRows.filter((r) => r.strength !== "NO_SHARED_WORDS"),
    unrelated: clearedRows.filter((r) => r.strength === "NO_SHARED_WORDS").length,
  };
}

/** A summary the shop can paste to CPSC itself. The app never sends it, and it holds no buyer data. */
export function tellCpscDraft(input: {
  shopName: string;
  recallNumber: string;
  product: string;
  recallUrl: string;
  saleDates: string[];
}): string {
  return [
    `CPSC recall ${input.recallNumber}: ${input.product}`,
    input.recallUrl,
    `${input.shopName} may have sold this recalled product: ${input.saleDates.length} sale(s), dated ${input.saleDates.join(", ")}.`,
  ].join("\n");
}
