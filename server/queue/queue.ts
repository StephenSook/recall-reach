// What the seller's queue shows. No raw PayPal id leaves this function: the page never needs one.
import { SECOND_NOTICE_AFTER_DAYS } from "../notice/store";
import { QUESTION_VERSION, type WrittenQuestion } from "../agent/questionStore";
import type { TraceEntry } from "../agent/recallAgent";
import { readItem } from "../agent/sources";
import type { Recall } from "../cpsc/schema";
import { MODEL } from "../agent/claude";
import type { Queryable } from "../db/types";
import { checkQuestion, type CheckQuestion } from "../notice/compose";
import { currentCheckResultSql, noticeState, type NoticeState } from "../notice/store";
import type { Strength } from "../match/verdict";
import { joinShop } from "../match/run";
import type { SellerAnswer } from "../match/sellerAnswers";
import { BUSINESS_TIME_ZONE_SQL, businessDay } from "../time/businessDay";
import { refundNote } from "../paypal/refundNote";
import { FAMILY_ASKED } from "../safetyReceipt/store";

/** What Claude found for this row. Text for a person to read: it changes no verdict, order or action. */
export interface AgentFinding {
  outcome: string;
  finding: string | null;
  evidence: { source: string; quote: string }[];
  missingField: string | null;
  reason: string | null;
  trace: TraceEntry[];
  model: string;
  checkedAt: string;
  /** Another model answered, not the main one. */
  fellBack: boolean;
  /** Made before this shop existed. A demo shop's answers are shared, so this one was saved and reused, not asked now. */
  saved: boolean;
}

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
  /** Family-given records have no sale date or payment authority. */
  familyAsked?: boolean;
  orderedOn: string | null;
  /** The line's total from the shop's own order file, not from PayPal. */
  saleCents?: number | null;
  saleCurrency?: string | null;
  /** Another row of this order couldn't be read, so this line's share of a discount can't be trusted. */
  orderIncomplete?: boolean;
  verdict: "MATCH" | "SCOPE_GAP" | "CLEARED";
  strength: Strength;
  salePath: "NOTICE_ONLY" | "REVIEW" | "REFUND_ELIGIBLE" | null;
  joinState: string | null;
  matched: string[];
  missing: string[];
  reason: string;
  isListing: boolean;
  stillListed: boolean;
  /** The newest message for this row. */
  notice: { id: string; kind: string; state: NoticeState; stopped: boolean; passedOn: boolean; result: string | null; daysSinceSent: number | null; secondDue: boolean; secondPrepared: boolean } | null;
  /** What the family said to a question, when a safety notice has since followed it. */
  earlierQuestionResult: string | null;
  /** What the family is or would be asked. Only on a scope gap about a sale. */
  question: CheckQuestion | null;
  /** Null until Claude has checked exactly this text. */
  agent: AgentFinding | null;
  /** CPSC changed the recall since this row was checked. */
  recallChanged: boolean;
  /** What the seller said when asked if this is the recalled product. It changes nothing else on the card. */
  sellerAnswer: SellerAnswer | null;
  /** Seconds from PayPal's capture to this queue, while the payment is held. PayPal's time itself never reaches the page. */
  caughtSeconds: number | null;
  /** note is what goes to PayPal with the refund, made by the code that sends it, so the screen shows what is sent. */
  approval: { id: string; amountCents: number; currency: string; expiresAt: string; note: string } | null;
  refund: { id: string; status: string; amountCents: number; currency: string; failure: string | null } | null;
}

/** A payment that names no item or order. Only what a seller needs to find it in PayPal: its date and amount. */
export interface UnidentifiedPayment {
  id: string;
  paidOn: string | null;
  amountCents: number | null;
  currency: string | null;
}

/** How long a live sale counts as on its way. PayPal took up to 85 s in testing. Past this, a lost webhook can't block the shop. */
export const SALE_ON_ITS_WAY_MINUTES = 5;

export interface QueueData {
  shop: { name: string; kind: string } | null;
  /** A store read from its public listings, not from sales. Null for anything else: a demo shop has one listing and real sales. */
  listings: { total: number; forSale: number } | null;
  unidentified: UnidentifiedPayment[];
  coverage: {
    recallsChecked: number;
    searchedFrom: string | null;
    searchedTo: string;
    recallsFrom: string | null;
    recallsTo: string | null;
    recallYearsMissing: number[];
    unidentifiedPayments: number;
    paypalSearched: boolean;
    candidatesNotChecked: number;
    searchWindows: number;
    failedWindows: number;
  } | null;
  rows: QueueRow[];
  /** Sales made just now that PayPal has not told us about yet. */
  pendingLiveSales: number;
}

const VERDICT_ORDER = { MATCH: 0, SCOPE_GAP: 1, CLEARED: 2 } as const;

/** Once a question is approved it is what the family gets. Until then, the one approving it now would freeze. */
function askedFor(r: Record<string, unknown>): CheckQuestion | null {
  if (r.verdict !== "SCOPE_GAP" || (!r.order_line_id && !r.safety_receipt_id)) return null;
  const stored: WrittenQuestion | null = r.stored_question
    ? { question: String(r.stored_question), evidence: String(r.stored_evidence), everyRecalledUnit: Boolean(r.stored_every), accepted: r.stored_review === "ACCEPTED", writtenAt: r.stored_at ? new Date(r.stored_at as string).toISOString() : null }
    : null;
  const written = r.notice_kind === "CHECK_REQUEST" ? (r.written_question as WrittenQuestion | null) : stored;
  return checkQuestion(
    {
      recallNumber: String(r.recall_number),
      title: String(r.recall_title),
      description: String(r.description),
      products: r.products as Recall["products"],
      hazards: r.hazards as string[],
      remedies: r.remedies as string[],
    },
    written,
  );
}

export async function loadQueue(db: Queryable, shopId: string, sessionId: string): Promise<QueueData> {
  const shop = await db.query<{ name: string; kind: string }>("select name, kind from shops where id = $1", [shopId]);
  const made = await db.query<{ created_at: unknown }>("select created_at from shops where id = $1", [shopId]);
  const shopMadeAt = made.rows[0] ? new Date(made.rows[0].created_at as string).getTime() : null;
  const run = await db.query<{
    recalls_checked: number;
    searched_from: string | null;
    searched_to: string;
    recalls_from: string | null;
    recalls_to: string | null;
    recall_years_missing: number[];
    unidentified_payments: number;
    paypal_searched: boolean;
    candidates_not_checked: number;
    search_windows: number;
    failed_windows: number;
  }>(
    `select recalls_checked, recalls_from, recalls_to, recall_years_missing, searched_from, searched_to, unidentified_payments, paypal_searched, candidates_not_checked, search_windows, failed_windows
     from shop_runs where shop_id = $1 order by finished_at desc limit 1`,
    [shopId],
  );
  const { rows } = await db.query<Record<string, never>>(
    `select m.id as match_id, m.verdict, m.strength, m.sale_path, m.join_state, m.matched, m.missing, m.reason, m.order_line_id, m.shop_item_id, m.safety_receipt_id,
            r.recall_number, r.title as recall_title, r.recall_date, r.url as recall_url, r.products, r.description, r.hazards, r.remedies, r.raw_sha256,
            n.written_question,
            extract(epoch from m.caught_at - pp.captured_at) as caught_seconds,
            q.question as stored_question, q.evidence as stored_evidence, q.created_at as stored_at, q.every_recalled_unit and q.scope_confirmed as stored_every, q.review as stored_review,
            ar.recall_sha256 as run_recall_sha, ar.item_sha256 as run_item_sha, ar.outcome as run_outcome, ar.finding as run_finding, ar.evidence as run_evidence,
            ar.missing_field as run_missing, ar.reason as run_reason, ar.trace as run_trace, ar.model as run_model, ar.created_at as run_created_at,
            coalesce(l.title, i.title, concat_ws(' ', sr.brand, sr.item, sr.model)) as item_title, coalesce(l.source, i.source) as source, sa.answer as seller_answer, m.recall_sha256 as checked_sha,
            l.ordered_on, l.quantity * l.unit_price_cents - l.discount_cents as sale_cents, l.currency as sale_currency, l.order_incomplete, coalesce(i.listed, false) as still_listed,
            n.id as notice_id, n.kind as notice_kind, n.opened_at, n.sent_at, n.responded_at, n.family_stopped, n.family_passed_on, n.second_prepared_at, floor(extract(epoch from now() - n.sent_at) / 86400)::int as days_since_sent, ${currentCheckResultSql("n", "r")} as check_result,
            (select ${currentCheckResultSql("q", "r")} from notices q where q.match_id = m.id and q.kind = 'CHECK_REQUEST' and n.kind = 'SAFETY_NOTICE') as earlier_question_result,
            a.id as approval_id, a.amount_cents as approval_amount, a.currency as approval_currency, a.expires_at as approval_expires,
            rf.id as refund_id, rf.status as refund_status, rf.amount_cents as refund_amount, rf.currency as refund_currency, rf.failure as refund_failure
     from recall_matches m
     join recalls r on r.recall_id = m.recall_id
     left join order_lines l on l.id = m.order_line_id
     left join shop_items i on i.id = m.shop_item_id
     left join safety_receipts sr on sr.id = m.safety_receipt_id
     left join seller_answers sa on sa.shop_id = m.shop_id and sa.recall_number = r.recall_number and sa.listing_title = coalesce(l.title, i.title)
     left join lateral (
       select * from notices x where x.match_id = m.id order by x.prepared_at desc, x.kind desc limit 1
     ) n on true
     left join recall_questions q on q.recall_sha256 = m.recall_sha256 and q.agent_version = $3 and q.outcome = 'QUESTION' and q.review is distinct from 'REJECTED'
     left join agent_runs ar on ar.id = m.agent_run_id
     left join paypal_payments pp on pp.id = m.paypal_payment_id
     left join lateral (
       select * from approvals x
       where x.order_line_id = m.order_line_id and x.recall_id = m.recall_id and x.session_id = $2
         and x.consumed_at is null and x.expires_at > now()
       order by x.created_at desc limit 1
     ) a on true
     left join lateral (
       select * from refunds y where y.order_line_id = m.order_line_id order by y.created_at desc limit 1
     ) rf on m.order_line_id is not null
     where m.shop_id = $1 and (m.order_line_id is null or not l.capture_pending)`,
    [shopId, sessionId, QUESTION_VERSION],
  );

  const out = (rows as unknown as Record<string, unknown>[]).map(
    (r): QueueRow => ({
      matchId: String(r.match_id),
      recordId: String(r.order_line_id ?? r.shop_item_id ?? r.safety_receipt_id),
      recallNumber: String(r.recall_number),
      recallTitle: String(r.recall_title),
      recallDate: String(r.recall_date),
      recallUrl: String(r.recall_url),
      product: (r.products as { name: string }[])[0]?.name ?? String(r.recall_title),
      itemTitle: String(r.item_title),
      source: r.safety_receipt_id ? FAMILY_ASKED : String(r.source),
      familyAsked: Boolean(r.safety_receipt_id),
      orderedOn: (r.ordered_on as string | null) ?? null,
      saleCents: r.sale_cents === null || r.sale_cents === undefined ? null : Number(r.sale_cents),
      saleCurrency: (r.sale_currency as string | null) ?? null,
      orderIncomplete: r.order_incomplete === true,
      verdict: r.verdict as QueueRow["verdict"],
      salePath: (r.sale_path as QueueRow["salePath"]) ?? null,
      joinState: (r.join_state as string | null) ?? null,
      strength: (r.strength as Strength | null) ?? "PRODUCT_WORDS", // from before strength was recorded: unknown is weak
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
            passedOn: Boolean(r.family_passed_on),
            result: (r.check_result as string | null) ?? null,
            daysSinceSent: (r.days_since_sent as number | null) ?? null,
            secondDue: shop.rows[0]?.kind === "REAL" && !r.responded_at && !r.second_prepared_at && r.days_since_sent !== null && Number(r.days_since_sent) >= SECOND_NOTICE_AFTER_DAYS,
            secondPrepared: Boolean(r.second_prepared_at) && !r.responded_at,
          }
        : null,
      earlierQuestionResult: (r.earlier_question_result as string | null) ?? null,
      question: askedFor(r),
      agent: null,
      sellerAnswer: (r.seller_answer as SellerAnswer | null) ?? null,
      recallChanged: r.checked_sha !== r.raw_sha256,
      caughtSeconds: r.caught_seconds === null || r.caught_seconds === undefined ? null : Math.max(0, Math.round(Number(r.caught_seconds))),
      approval: r.approval_id
        ? {
            id: String(r.approval_id),
            amountCents: Number(r.approval_amount),
            currency: String(r.approval_currency),
            expiresAt: new Date(r.approval_expires as string).toISOString(),
            note: refundNote(String(r.recall_number), (r.products as { name: string }[])[0]?.name ?? String(r.recall_title)),
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
  // A finding is about the exact text Claude read, so it goes away when either text changes.
  await Promise.all(
    (rows as unknown as Record<string, unknown>[]).map(async (r, i) => {
      if (!r.run_outcome || r.run_recall_sha !== r.raw_sha256) return;
      const item = await readItem(db, shopId, r.order_line_id ? { kind: "order_line", id: String(r.order_line_id) } : { kind: "shop_item", id: String(r.shop_item_id) });
      if (item?.sha256 !== r.run_item_sha) return;
      out[i].agent = {
        outcome: String(r.run_outcome),
        finding: (r.run_finding as string | null) ?? null,
        evidence: r.run_evidence as AgentFinding["evidence"],
        missingField: (r.run_missing as string | null) ?? null,
        reason: (r.run_reason as string | null) ?? null,
        trace: r.run_trace as TraceEntry[],
        model: String(r.run_model),
        checkedAt: new Date(r.run_created_at as string).toISOString(),
        fellBack: r.run_model !== MODEL,
        saved: shopMadeAt !== null && new Date(r.run_created_at as string).getTime() < shopMadeAt,
      };
    }),
  );
  out.sort(
    (a, b) => VERDICT_ORDER[a.verdict] - VERDICT_ORDER[b.verdict] || a.recallNumber.localeCompare(b.recallNumber) || a.itemTitle.localeCompare(b.itemTitle),
  );

  const pending = await db.query<{ n: number }>(
    `select count(*)::int as n from order_lines l where l.shop_id = $1 and l.live_sale
     and l.imported_at > now() - make_interval(mins => $2)
     and not exists (select 1 from recall_matches m where m.order_line_id = l.id and m.caught_at is not null)`,
    [shopId, SALE_ON_ITS_WAY_MINUTES],
  );
  const items = await db.query<{ total: number; for_sale: number }>("select count(*)::int as total, count(*) filter (where listed)::int as for_sale from shop_items where shop_id = $1", [shopId]);
  const c = run.rows[0];
  const { joined } = await joinShop(db, shopId, { today: businessDay(new Date()) });
  const unidentified = await db.query<{ id: string; paid_on: string | null; amount_cents: number | null; currency: string | null }>(
    `select id, (captured_at at time zone ${BUSINESS_TIME_ZONE_SQL})::date::text as paid_on, amount_cents, currency
     from paypal_payments where shop_id = $1 and id = any($2::uuid[]) order by captured_at desc`,
    [shopId, joined.unidentifiedKeys],
  );
  return {
    unidentified: unidentified.rows.map((p) => ({ id: p.id, paidOn: p.paid_on, amountCents: p.amount_cents, currency: p.currency })),
    shop: shop.rows[0] ?? null,
    listings: shop.rows[0]?.kind === "REAL" && items.rows[0].total > 0 ? { total: items.rows[0].total, forSale: items.rows[0].for_sale } : null,
    coverage: c
      ? {
          recallsChecked: c.recalls_checked,
          searchedFrom: c.searched_from,
          searchedTo: c.searched_to,
          recallsFrom: c.recalls_from,
          recallsTo: c.recalls_to,
          recallYearsMissing: c.recall_years_missing,
          unidentifiedPayments: c.unidentified_payments,
          paypalSearched: c.paypal_searched,
          candidatesNotChecked: c.candidates_not_checked,
          searchWindows: c.search_windows,
          failedWindows: c.failed_windows,
        }
      : null,
    rows: out,
    pendingLiveSales: pending.rows[0]?.n ?? 0,
  };
}

/** One sale or listing, and the recalls it could belong to. At most one thing goes out for it. */
export interface QueueCard {
  lead: QueueRow;
  also: QueueRow[];
}

const STRENGTH_ORDER: Record<Strength, number> = { CONFIRMED: 0, BRAND: 1, PRODUCT_WORDS: 2, NO_SHARED_WORDS: 3 };
const actedOn = (r: QueueRow) => r.notice !== null || r.approval !== null || r.refund !== null;
const byEvidence = (a: QueueRow, b: QueueRow) =>
  STRENGTH_ORDER[a.strength] - STRENGTH_ORDER[b.strength] ||
  b.recallDate.localeCompare(a.recallDate) ||
  b.recallNumber.localeCompare(a.recallNumber);
/** Which of a sale's recalls leads its card. */
const stronger = (a: QueueRow, b: QueueRow) => Number(actedOn(b)) - Number(actedOn(a)) || byEvidence(a, b);

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
  // By the evidence only, so a card holds its place when it's acted on, or when an approval lapses during a refresh: a card that moves closes if it's open.
  cards.sort((a, b) => byEvidence(a.lead, b.lead));
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
