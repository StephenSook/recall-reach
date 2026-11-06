// A notice is a message a person approved. The app never sends it: it opens in the seller's own mail.
// The buyer's address comes only from the shop's own record. A PayPal payer email is never read.
import type { Recall } from "../cpsc/schema";
import type { Queryable } from "../db/types";
import { fullScopeInRecord, modelTokens } from "../match/verdict";
import { refundedAmount } from "../paypal/refunds";
import type { ContactCipher } from "../privacy/contactCipher";
import { checkQuestion, composeCheckRequest, composeSafetyNotice, type CheckQuestion } from "./compose";
import { familyTokenFor } from "./token";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type NoticeRefusalCode = "NO_SUCH_MATCH" | "NO_SUCH_NOTICE" | "NOTHING_TO_SEND" | "TWO_POSSIBLE_ORDERS" | "PRODUCT_WORDS_ONLY" | "ALREADY_ASKED" | "NOT_A_QUESTION" | "LINK_EXPIRED" | "NO_ANSWER";

export class NoticeRefused extends Error {
  constructor(readonly code: NoticeRefusalCode, message: string) {
    super(message);
    this.name = "NoticeRefused";
  }
}

const twoOrders = () => new NoticeRefused("TWO_POSSIBLE_ORDERS", "Two possible orders. Resolve which order this is first.");
const alreadyAsked = () => new NoticeRefused("ALREADY_ASKED", "This sale already has a message. One sale gets one question.");
const noNotice = () => new NoticeRefused("NO_SUCH_NOTICE", "No such notice for this shop.");

export type NoticeState = "PREPARED" | "OPENED_IN_MAIL" | "MARKED_SENT" | "FAMILY_RESPONDED";

export function noticeState(n: { opened_at: unknown; sent_at: unknown; responded_at: unknown }): NoticeState {
  if (n.responded_at) return "FAMILY_RESPONDED";
  if (n.sent_at) return "MARKED_SENT";
  return n.opened_at ? "OPENED_IN_MAIL" : "PREPARED";
}

export async function prepareNotice(
  db: Queryable,
  input: { shopId: string; matchId: string },
): Promise<{ noticeId: string; kind: "SAFETY_NOTICE" | "CHECK_REQUEST" }> {
  if (!UUID.test(input.matchId)) throw new NoticeRefused("NO_SUCH_MATCH", "No such match for this shop.");
  const { rows } = await db.query<{ verdict: string; strength: string | null; join_state: string | null; order_line_id: string | null }>(
    "select verdict, strength, join_state, order_line_id from recall_matches where id = $1 and shop_id = $2",
    [input.matchId, input.shopId],
  );
  const m = rows[0];
  if (!m) throw new NoticeRefused("NO_SUCH_MATCH", "No such match for this shop.");
  if (m.join_state === "AMBIGUOUS_JOIN") throw twoOrders();
  if (m.verdict === "CLEARED" || !m.order_line_id) throw new NoticeRefused("NOTHING_TO_SEND", "There is no one to notify for this row.");
  if (m.strength === "PRODUCT_WORDS") {
    throw new NoticeRefused("PRODUCT_WORDS_ONLY", "The shop's text shares only product words with this recall. Nothing goes out on that.");
  }
  const kind = m.verdict === "MATCH" ? "SAFETY_NOTICE" : "CHECK_REQUEST";
  const existing = await db.query<{ id: string; kind: "SAFETY_NOTICE" | "CHECK_REQUEST" }>("select id, kind from notices where match_id = $1", [input.matchId]);
  if (existing.rows[0]) return { noticeId: existing.rows[0].id, kind: existing.rows[0].kind };
  if (kind === "CHECK_REQUEST") {
    const taken = await db.query(
      `select 1 from notices where order_line_id = $1
       union all select 1 from recall_matches where order_line_id = $1 and verdict = 'MATCH' and id <> $2`,
      [m.order_line_id, input.matchId],
    );
    if (taken.rows.length > 0) throw alreadyAsked();
  }
  // The index settles a race between two requests. Here a second notice for the match is the same notice.
  const saved = await db.query<{ id: string; kind: "SAFETY_NOTICE" | "CHECK_REQUEST" }>(
    `insert into notices (shop_id, match_id, kind, order_line_id) values ($1, $2, $3, $4)
     on conflict do nothing
     returning id, kind`,
    [input.shopId, input.matchId, kind, m.order_line_id],
  );
  if (!saved.rows[0]) throw alreadyAsked();
  return { noticeId: saved.rows[0].id, kind: saved.rows[0].kind };
}

async function mark(db: Queryable, column: "opened_at" | "sent_at", input: { shopId: string; noticeId: string }): Promise<void> {
  if (!UUID.test(input.noticeId)) throw noNotice();
  const { rows } = await db.query(
    `update notices set ${column} = coalesce(${column}, now()) where id = $1 and shop_id = $2 returning id`,
    [input.noticeId, input.shopId],
  );
  if (rows.length === 0) throw noNotice();
}

export const markOpened = (db: Queryable, input: { shopId: string; noticeId: string }) => mark(db, "opened_at", input);
export const markSent = (db: Queryable, input: { shopId: string; noticeId: string }) => mark(db, "sent_at", input);

interface RecallRow {
  recall_number: string;
  title: string;
  description: string;
  url: string;
  products: Recall["products"];
  hazards: string[];
  remedies: string[];
}

export interface ComposedForSeller {
  to: string | null;
  toSource: "Shop record" | "You add the address";
  subject: string;
  body: string;
}

/** Goes only to the signed-in shop session. The browser builds the mail link; nothing here is logged. */
export async function composeForSeller(
  db: Queryable,
  input: { shopId: string; noticeId: string; baseUrl: string; tokenSecret: string; cipher: ContactCipher },
): Promise<ComposedForSeller> {
  if (!UUID.test(input.noticeId)) throw noNotice();
  const { rows } = await db.query<
    RecallRow & {
      kind: string;
      join_state: string | null;
      item_title: string;
      ordered_on: string;
      buyer_email_enc: string | null;
      shop_name: string;
      order_line_id: string;
    }
  >(
    `select n.kind, m.join_state, l.title as item_title, l.ordered_on, l.buyer_email_enc, l.id as order_line_id, s.name as shop_name,
            r.recall_number, r.title, r.description, r.url, r.products, r.hazards, r.remedies
     from notices n
     join recall_matches m on m.id = n.match_id
     join order_lines l on l.id = m.order_line_id
     join shops s on s.id = n.shop_id
     join recalls r on r.recall_id = m.recall_id
     where n.id = $1 and n.shop_id = $2`,
    [input.noticeId, input.shopId],
  );
  const n = rows[0];
  if (!n) throw noNotice();
  if (n.join_state === "AMBIGUOUS_JOIN") throw twoOrders();

  const context = {
    recall: { recallNumber: n.recall_number, url: n.url, products: n.products, hazards: n.hazards, remedies: n.remedies },
    itemTitle: n.item_title,
    shopName: n.shop_name,
    orderDate: n.ordered_on,
    familyUrl: `${input.baseUrl}/r/${familyTokenFor(input.tokenSecret, input.noticeId)}`,
  };
  let message;
  if (n.kind === "CHECK_REQUEST") {
    const { question } = checkQuestion({ recallNumber: n.recall_number, title: n.title, description: n.description });
    message = composeCheckRequest({ ...context, question });
  } else {
    // The refund line appears only once PayPal confirmed the refund, never on approval.
    const refunded = await db.query<{ amount_cents: number; currency: string }>(
      "select amount_cents, currency from refunds where order_line_id = $1 and status = 'refunded' limit 1",
      [n.order_line_id],
    );
    const r = refunded.rows[0];
    message = composeSafetyNotice({ ...context, confirmedRefund: r ? refundedAmount(r.amount_cents, r.currency) : undefined });
  }
  const to = n.buyer_email_enc ? input.cipher.open(n.buyer_email_enc) : null;
  return { to, toSource: to ? "Shop record" : "You add the address", ...message };
}

export type CheckResult = "MATCHES" | "DOESNT_MATCH" | "CANT_TELL";
const normalizeModel = (t: string) => t.toUpperCase().replace(/[^A-Z0-9]/g, "");

/** "Doesn't match" is only ever said when CPSC's full scope is in the record. */
export function checkResult(
  recall: { title?: string; description: string },
  question: CheckQuestion,
  answer: string,
): CheckResult {
  const said = answer.trim();
  const noMatch: CheckResult = fullScopeInRecord(recall) ? "DOESNT_MATCH" : "CANT_TELL";
  if (question.kind === "model") {
    if (!said) return "CANT_TELL";
    const listed = modelTokens(`${recall.title ?? ""} ${recall.description}`).map(normalizeModel);
    return listed.includes(normalizeModel(said)) ? "MATCHES" : noMatch;
  }
  if (said === "yes") return "MATCHES";
  if (said === "no") return question.kind === "yes_no" ? noMatch : "CANT_TELL";
  return "CANT_TELL";
}

const linkExpired = () => new NoticeRefused("LINK_EXPIRED", "This link has expired.");

export async function recordFamilyStopped(db: Queryable, noticeId: string): Promise<void> {
  const { rows } = await db.query<{ expired: boolean }>("select family_link_expires_at <= now() as expired from notices where id = $1", [noticeId]);
  if (!rows[0]) throw noNotice();
  if (rows[0].expired) throw linkExpired();
  await db.query("update notices set family_stopped = true, responded_at = coalesce(responded_at, now()) where id = $1", [noticeId]);
}

/** The first real answer stands. The link has no login, so anyone holding it could otherwise change what the seller sees. */
export async function recordFamilyAnswer(db: Queryable, noticeId: string, answer: string): Promise<CheckResult> {
  const { rows } = await db.query<{
    recall_number: string;
    title: string;
    description: string;
    kind: string;
    check_result: CheckResult | null;
    expired: boolean;
  }>(
    `select r.recall_number, r.title, r.description, n.kind, n.check_result, n.family_link_expires_at <= now() as expired from notices n
     join recall_matches m on m.id = n.match_id join recalls r on r.recall_id = m.recall_id where n.id = $1`,
    [noticeId],
  );
  const notice = rows[0];
  if (!notice) throw noNotice();
  if (notice.kind !== "CHECK_REQUEST") throw new NoticeRefused("NOT_A_QUESTION", "This message does not ask a question.");
  if (notice.expired) throw linkExpired();
  const question = checkQuestion({ recallNumber: notice.recall_number, title: notice.title, description: notice.description });
  const said = answer.trim();
  const offered = question.kind === "model" ? said.length > 0 : ["yes", "no", "not_sure"].includes(said);
  if (!offered) throw new NoticeRefused("NO_ANSWER", "That is not an answer to this question.");
  // Only an explicit "not sure" stays open, so the family can look and then answer.
  const saved = await db.query<{ check_result: CheckResult }>(
    `update notices set
       check_result = case when check_result is null or check_open then $2 else check_result end,
       check_open = case when check_result is null or check_open then $3::boolean else false end,
       responded_at = coalesce(responded_at, now())
     where id = $1 returning check_result`,
    [noticeId, checkResult(notice, question, said), said === "not_sure"],
  );
  return saved.rows[0].check_result;
}

export interface FamilyView {
  kind: "SAFETY_NOTICE" | "CHECK_REQUEST";
  shopName: string;
  recallNumber: string;
  product: string;
  recallUrl: string;
  hazards: string[];
  remedies: string[];
  question: CheckQuestion | null;
  stopped: boolean;
  result: CheckResult | null;
  /** The link no longer takes answers. CPSC's words still show: the hazard has not gone away. */
  expired: boolean;
  /** The question can still be answered: none yet, or only "not sure". */
  answerOpen: boolean;
}

/** All the family page gets. No buyer, order or payment data, so none can reach the page. */
export async function familyView(db: Queryable, noticeId: string): Promise<FamilyView | null> {
  if (!UUID.test(noticeId)) return null;
  const { rows } = await db.query<
    RecallRow & { kind: FamilyView["kind"]; shop_name: string; family_stopped: boolean; check_result: CheckResult | null; check_open: boolean; expired: boolean }
  >(
    `select n.kind, n.family_stopped, n.check_result, n.check_open, n.family_link_expires_at <= now() as expired, s.name as shop_name,
            r.recall_number, r.title, r.description, r.url, r.products, r.hazards, r.remedies
     from notices n join shops s on s.id = n.shop_id
     join recall_matches m on m.id = n.match_id join recalls r on r.recall_id = m.recall_id
     where n.id = $1`,
    [noticeId],
  );
  const n = rows[0];
  if (!n) return null;
  return {
    kind: n.kind,
    shopName: n.shop_name,
    recallNumber: n.recall_number,
    product: n.products[0]?.name ?? n.title,
    recallUrl: n.url,
    hazards: n.hazards,
    remedies: n.remedies,
    question: n.kind === "CHECK_REQUEST" ? checkQuestion({ recallNumber: n.recall_number, title: n.title, description: n.description }) : null,
    stopped: n.family_stopped,
    result: n.check_result,
    expired: n.expired,
    answerOpen: n.check_result === null || n.check_open,
  };
}
