// A notice is a message a person approved. The app never sends it: it opens in the seller's own mail.
// The buyer's address comes only from the shop's own record. A PayPal payer email is never read.
import { writtenQuestion, type WrittenQuestion } from "../agent/questionStore";
import type { Recall } from "../cpsc/schema";
import type { Queryable } from "../db/types";
import { fullScopeInRecord, isVariantOf, limitedWithinModel, modelsNamedInText, modelTokens, normalizeModel, unconfuse, writtenApart } from "../match/verdict";
import { refundedAmount } from "../paypal/refunds";
import type { ContactCipher } from "../privacy/contactCipher";
import { checkQuestion, composeCheckRequest, composeSafetyNotice, type CheckQuestion } from "./compose";
import { familyTokenFor } from "./token";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type NoticeRefusalCode = "NO_SUCH_MATCH" | "NO_SUCH_NOTICE" | "NOTHING_TO_SEND" | "TWO_POSSIBLE_ORDERS" | "PRODUCT_WORDS_ONLY" | "ALREADY_ASKED" | "NOT_A_QUESTION" | "LINK_EXPIRED" | "NO_ANSWER" | "EVIDENCE_CHANGED" | "QUESTION_CHANGED";

export class NoticeRefused extends Error {
  constructor(readonly code: NoticeRefusalCode, message: string) {
    super(message);
    this.name = "NoticeRefused";
  }
}

const twoOrders = () => new NoticeRefused("TWO_POSSIBLE_ORDERS", "Two possible orders. Resolve which order this is first.");
const alreadyAsked = () => new NoticeRefused("ALREADY_ASKED", "This sale already has a message. One sale gets one question.");
/**
 * A match needs the evidence recorded as confirmed, and a gap needs the brand behind it. No recorded strength
 * is not enough for either: a row from before strength was recorded may rest on weaker grounds.
 */
function refuseWeakEvidence(match: { verdict: string; strength: string | null }): void {
  if (match.verdict === "CLEARED") throw new NoticeRefused("NOTHING_TO_SEND", "There is no one to notify for this row.");
  const enough = match.verdict === "MATCH" ? match.strength === "CONFIRMED" : match.strength === "BRAND";
  if (!enough) throw new NoticeRefused("PRODUCT_WORDS_ONLY", "The shop's text shares only product words with this recall. Nothing goes out on that.");
}

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
  const { rows } = await db.query<{ verdict: string; strength: string | null; join_state: string | null; order_line_id: string | null; recall_sha256: string }>(
    "select verdict, strength, join_state, order_line_id, recall_sha256 from recall_matches where id = $1 and shop_id = $2",
    [input.matchId, input.shopId],
  );
  const m = rows[0];
  if (!m) throw new NoticeRefused("NO_SUCH_MATCH", "No such match for this shop.");
  if (m.join_state === "AMBIGUOUS_JOIN") throw twoOrders();
  if (m.verdict === "CLEARED" || !m.order_line_id) throw new NoticeRefused("NOTHING_TO_SEND", "There is no one to notify for this row.");
  refuseWeakEvidence(m);
  const kind = m.verdict === "MATCH" ? "SAFETY_NOTICE" : "CHECK_REQUEST";
  const existing = await db.query<{ id: string; kind: "SAFETY_NOTICE" | "CHECK_REQUEST"; sent_at: unknown; responded_at: unknown }>(
    "select id, kind, sent_at, responded_at from notices where match_id = $1",
    [input.matchId],
  );
  const same = existing.rows.find((n) => n.kind === kind);
  if (same) return { noticeId: same.id, kind };
  const other = existing.rows[0];
  // What was sent or answered stays on record as it was. Until then, the message follows the evidence as it stands now.
  // After it, a confirmed recall still has to reach the family, but a safety notice is not walked back with a question.
  const otherWentOut = other && (other.sent_at || other.responded_at);
  if (otherWentOut && kind === "CHECK_REQUEST") return { noticeId: other.id, kind: other.kind };
  if (kind === "CHECK_REQUEST") {
    const taken = await db.query(
      `select 1 from notices where order_line_id = $1 and match_id <> $2
       union all select 1 from recall_matches where order_line_id = $1 and verdict = 'MATCH' and id <> $2`,
      [m.order_line_id, input.matchId],
    );
    if (taken.rows.length > 0) throw alreadyAsked();
  }
  const written = kind === "CHECK_REQUEST" ? await writtenQuestion(db, m.recall_sha256) : null;
  const frozen = written ? JSON.stringify(written) : null;
  if (other && !otherWentOut) {
    // It can be sent or answered while this runs, and then it stays as it was.
    const rewritten = await db.query(
      "update notices set kind = $2, opened_at = null, written_question = $4::jsonb where id = $1 and shop_id = $3 and sent_at is null and responded_at is null returning id",
      [other.id, kind, input.shopId, frozen],
    );
    if (rewritten.rows.length > 0) return { noticeId: other.id, kind };
    if (kind === "CHECK_REQUEST") return { noticeId: other.id, kind: other.kind };
  }
  // The indexes settle a race between two requests: one message of each kind per match, one question per sale.
  const saved = await db.query<{ id: string; kind: "SAFETY_NOTICE" | "CHECK_REQUEST" }>(
    `insert into notices (shop_id, match_id, kind, order_line_id, written_question) values ($1, $2, $3, $4, $5::jsonb)
     on conflict do nothing
     returning id, kind`,
    [input.shopId, input.matchId, kind, m.order_line_id, frozen],
  );
  if (saved.rows[0]) return { noticeId: saved.rows[0].id, kind: saved.rows[0].kind };
  const raced = await db.query<{ id: string }>("select id from notices where match_id = $1 and kind = $2", [input.matchId, kind]);
  if (!raced.rows[0]) throw alreadyAsked();
  return { noticeId: raced.rows[0].id, kind };
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
      sent_at: unknown;
      responded_at: unknown;
      written_question: WrittenQuestion | null;
      join_state: string | null;
      verdict: string;
      strength: string | null;
      item_title: string;
      ordered_on: string;
      buyer_email_enc: string | null;
      shop_name: string;
      order_line_id: string;
    }
  >(
    `select n.kind, n.sent_at, n.responded_at, n.written_question, m.join_state, m.verdict, m.strength, l.title as item_title, l.ordered_on, l.buyer_email_enc, l.id as order_line_id, s.name as shop_name,
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
  refuseWeakEvidence(n); // the line may have been corrected since the notice was prepared
  // A safety notice always needs a confirmed match. A question on a confirmed sale is stale until it has gone out.
  const confirmed = n.verdict === "MATCH";
  const staleQuestion = n.kind === "CHECK_REQUEST" && confirmed && !n.sent_at && !n.responded_at;
  if ((n.kind === "SAFETY_NOTICE" && !confirmed) || staleQuestion) {
    throw new NoticeRefused("EVIDENCE_CHANGED", "The evidence changed since this was prepared. Approve it again to get the right message.");
  }

  const context = {
    recall: { recallNumber: n.recall_number, url: n.url, products: n.products, hazards: n.hazards, remedies: n.remedies },
    itemTitle: n.item_title,
    shopName: n.shop_name,
    orderDate: n.ordered_on,
    familyUrl: `${input.baseUrl}/r/${familyTokenFor(input.tokenSecret, input.noticeId)}`,
  };
  let message;
  if (n.kind === "CHECK_REQUEST") {
    const { question } = askedOf(n);
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

/** What this notice asks: the question frozen when the seller approved it, while CPSC's text still supports it. */
function askedOf(n: Pick<RecallRow, "recall_number" | "title" | "description" | "products" | "hazards" | "remedies"> & { written_question: WrittenQuestion | null }): CheckQuestion {
  return checkQuestion({ recallNumber: n.recall_number, title: n.title, description: n.description, products: n.products, hazards: n.hazards, remedies: n.remedies }, n.written_question);
}

export type CheckResult = "MATCHES" | "DOESNT_MATCH" | "CANT_TELL";

/** "Doesn't match" is only ever said when CPSC's full scope is in the record. */
export function checkResult(
  recall: { title?: string; description: string },
  question: CheckQuestion,
  answer: string,
): CheckResult {
  const said = answer.trim();
  const fullScope = fullScopeInRecord(recall);
  if (question.kind === "model") {
    if (!said) return "CANT_TELL";
    const text = `${recall.title ?? ""} ${recall.description}`;
    const listed = [...modelTokens(text), ...modelsNamedInText(text)];
    const typed = unconfuse(normalizeModel(said));
    // The record names this model. If CPSC recalled only part of it, the model alone can't settle that.
    if (listed.some((m) => unconfuse(normalizeModel(m)) === typed)) return limitedWithinModel(recall.description) ? "CANT_TELL" : "MATCHES";
    // Nobody is told it doesn't match over a typing slip, or something CPSC's record says elsewhere.
    if (isVariantOf(said, listed) || writtenApart(said).test(text.toUpperCase())) return "CANT_TELL";
    // "Not sure", "can't read it", "worn off": words with no number aren't a model, so they can't rule anything out.
    if (!/\d/.test(said)) return "CANT_TELL";
    return fullScope ? "DOESNT_MATCH" : "CANT_TELL";
  }
  // CPSC's list is elsewhere, so nothing a family says here can settle it either way.
  if (!fullScope) return "CANT_TELL";
  if (said === "yes") return "MATCHES";
  if (said !== "no") return "CANT_TELL";
  const noSettlesIt = question.kind === "yes_no" || (question.kind === "written" && question.noRulesOut);
  return noSettlesIt ? "DOESNT_MATCH" : "CANT_TELL";
}

const linkExpired = () => new NoticeRefused("LINK_EXPIRED", "This link has expired.");

export async function recordFamilyStopped(db: Queryable, noticeId: string): Promise<void> {
  const { rows } = await db.query<{ expired: boolean }>("select family_link_expires_at <= now() as expired from notices where id = $1", [noticeId]);
  if (!rows[0]) throw noNotice();
  if (rows[0].expired) throw linkExpired();
  await db.query("update notices set family_stopped = true, responded_at = coalesce(responded_at, now()) where id = $1", [noticeId]);
}

/** The first real answer stands. The link has no login, so anyone holding it could otherwise change what the seller sees. */
export async function recordFamilyAnswer(db: Queryable, noticeId: string, answer: string, askedOnPage?: string): Promise<CheckResult> {
  const { rows } = await db.query<{
    recall_number: string;
    title: string;
    description: string;
    products: Recall["products"];
    hazards: string[];
    remedies: string[];
    written_question: WrittenQuestion | null;
    kind: string;
    check_result: CheckResult | null;
    expired: boolean;
  }>(
    `select r.recall_number, r.title, r.description, r.products, r.hazards, r.remedies, n.written_question, n.kind, n.check_result, n.family_link_expires_at <= now() as expired from notices n
     join recall_matches m on m.id = n.match_id join recalls r on r.recall_id = m.recall_id where n.id = $1`,
    [noticeId],
  );
  const notice = rows[0];
  if (!notice) throw noNotice();
  if (notice.kind !== "CHECK_REQUEST") throw new NoticeRefused("NOT_A_QUESTION", "This message does not ask a question.");
  if (notice.expired) throw linkExpired();
  const question = askedOf(notice);
  // The page they answered may be older than the question now. An answer only counts against the words they read.
  if (askedOnPage !== undefined && askedOnPage !== question.question) throw new NoticeRefused("QUESTION_CHANGED", "The question has changed. Please read it again.");
  const said = answer.trim();
  const offered = question.kind === "model" ? said.length > 0 : ["yes", "no", "not_sure"].includes(said);
  if (!offered) throw new NoticeRefused("NO_ANSWER", "That is not an answer to this question.");
  // An explicit "not sure" stays open, so the family can look and then answer. So does a typed model until it matches,
  // because a label is easy to misread. A typed model only ever moves toward the recall, so a link holder can't talk it down.
  const result = checkResult(notice, question, said);
  const staysOpen = question.kind === "model" ? result !== "MATCHES" : said === "not_sure";
  const saved = await db.query<{ check_result: CheckResult }>(
    `update notices set
       check_result = case when check_result is null or (check_open and (not $4::boolean or array_position(array['DOESNT_MATCH', 'CANT_TELL', 'MATCHES'], $2::text) >= array_position(array['DOESNT_MATCH', 'CANT_TELL', 'MATCHES'], check_result))) then $2 else check_result end,
       check_open = case when check_result is null or check_open then $3::boolean else false end,
       responded_at = coalesce(responded_at, now())
     where id = $1 returning check_result`,
    [noticeId, result, staysOpen, question.kind === "model"],
  );
  return saved.rows[0].check_result;
}

export interface FamilyView {
  kind: "SAFETY_NOTICE" | "CHECK_REQUEST";
  shopName: string;
  recallNumber: string;
  product: string;
  /** CPSC's own photo, so a family can compare it with theirs. Only ever from cpsc.gov. */
  image: { url: string; caption: string } | null;
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
  const fromCpsc = (image: { url: string } | undefined) => {
    if (!image) return false;
    try {
      const { protocol, hostname } = new URL(image.url);
      return protocol === "https:" && (hostname === "cpsc.gov" || hostname.endsWith(".cpsc.gov"));
    } catch {
      return false;
    }
  };
  if (!UUID.test(noticeId)) return null;
  const { rows } = await db.query<
    RecallRow & { kind: FamilyView["kind"]; shop_name: string; family_stopped: boolean; check_result: CheckResult | null; check_open: boolean; expired: boolean; written_question: WrittenQuestion | null; images: { url: string; caption: string }[] }
  >(
    `select n.kind, n.family_stopped, n.check_result, n.check_open, n.written_question, n.family_link_expires_at <= now() as expired, s.name as shop_name,
            r.recall_number, r.title, r.description, r.url, r.products, r.hazards, r.remedies, r.images
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
    image: fromCpsc(n.images[0]) ? n.images[0] : null,
    recallUrl: n.url,
    hazards: n.hazards,
    remedies: n.remedies,
    question: n.kind === "CHECK_REQUEST" ? askedOf(n) : null,
    stopped: n.family_stopped,
    result: n.check_result,
    expired: n.expired,
    answerOpen: n.check_result === null || n.check_open,
  };
}
