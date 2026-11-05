// Links the shop's own order lines to PayPal payments, locally. Nothing here leaves the app.
//
// States a line can be in. Only IDENTIFIED may lead to a refund. AMBIGUOUS_JOIN blocks all outreach
// until the seller resolves which order it is, because a wrong guess emails the wrong family.
// None of the states below means "cleared": a recall match stays a match whatever the join says.
export type JoinState =
  | "IDENTIFIED" // exactly one payment
  | "AMBIGUOUS_JOIN" // more than one possible payment, or a payment more than one line could claim
  | "HISTORY_UNAVAILABLE" // older than PayPal's 3 years, or that month's search failed
  | "NO_PAYPAL_RECORD"; // PayPal was searched and has nothing: the shop's record stands alone

export const PAYPAL_HISTORY_MONTHS = 36; // "previous three years", reporting_transactions_v1.json

export interface JoinLine {
  id: string;
  orderNumber: string;
  title: string;
  sku: string | null;
  orderedOn: string;
}

export interface JoinPayment {
  /** Opaque to this code. */
  key: string;
  /** The shop's order number from invoice_id or custom_id, if the payment has one. */
  orderNumber: string | null;
  items: { name: string; sku: string | null }[];
  /** The day the payment was captured, YYYY-MM-DD. Null when PayPal gave none. */
  paidOn: string | null;
}

export interface LineJoin {
  state: JoinState;
  paymentKey: string | null;
  linkedBy: "order number" | "SKU" | "exact title" | null;
}

export interface JoinResult {
  lines: Record<string, LineJoin>;
  /** CANNOT_IDENTIFY_ITEMS: payments with nothing that ties them to any order line. Never cleared. */
  unidentifiedPayments: number;
}

const DAY_MS = 86_400_000;
const ms = (day: string) => Date.parse(`${day}T00:00:00Z`);

/** A SKU or title alone can recur across years, so an item-level link must also be close in time. */
const ITEM_LINK_MAX_DAYS = 7;
/** A line this close to PayPal's limit may already be past it by the time anyone reads the answer. */
const HISTORY_MARGIN_DAYS = 2;

function monthsBefore(today: string, months: number): string {
  const d = new Date(`${today}T00:00:00Z`);
  d.setUTCMonth(d.getUTCMonth() - months);
  return d.toISOString().slice(0, 10);
}

function nextMonth(month: string): string {
  const d = new Date(`${month}-01T00:00:00Z`);
  d.setUTCMonth(d.getUTCMonth() + 1);
  return d.toISOString().slice(0, 7);
}

/** "#T-100a" and "t-100A" are one order: exports and checkouts differ on the # and on case. */
const normalizeNumber = (n: string) => n.trim().replace(/^#/, "").toLowerCase();

export function joinOrderLines(
  lines: JoinLine[],
  payments: JoinPayment[],
  opts: { today: string; failedMonths?: string[] },
): JoinResult {
  const failed = new Set(opts.failedMonths ?? []);
  const historyFrom = new Date(ms(monthsBefore(opts.today, PAYPAL_HISTORY_MONTHS)) + HISTORY_MARGIN_DAYS * DAY_MS)
    .toISOString()
    .slice(0, 10);
  const result: Record<string, LineJoin> = {};
  const claimed = new Set<string>();

  const byNumber = (l: JoinLine) =>
    payments.filter((p) => p.orderNumber !== null && normalizeNumber(p.orderNumber) === normalizeNumber(l.orderNumber));
  const nearOrderDate = (l: JoinLine, p: JoinPayment) =>
    p.paidOn !== null && Math.abs(ms(p.paidOn) - ms(l.orderedOn)) <= ITEM_LINK_MAX_DAYS * DAY_MS;
  // Item-level links apply only to payments with no order number of their own, close to the order.
  const unnumbered = (l: JoinLine) => payments.filter((p) => !p.orderNumber && nearOrderDate(l, p));
  const bySku = (l: JoinLine) => (l.sku ? unnumbered(l).filter((p) => p.items.some((i) => i.sku === l.sku)) : []);
  // A title never links across two different SKUs: only when one side has no SKU to conflict.
  const byTitle = (l: JoinLine) =>
    unnumbered(l).filter((p) => p.items.some((i) => i.name === l.title && (!l.sku || i.sku === null)));
  const itemCandidates = (l: JoinLine) => {
    const viaSku = bySku(l);
    return viaSku.length > 0 ? viaSku : byTitle(l);
  };
  // An order's own payment should list this line, if it lists anything at all.
  const listsLine = (l: JoinLine, p: JoinPayment) =>
    p.items.length === 0 || p.items.some((i) => (l.sku && i.sku === l.sku) || i.name === l.title);

  const itemClaims = new Map<string, number>();
  for (const l of lines) {
    if (byNumber(l).length > 0) continue;
    for (const p of itemCandidates(l)) itemClaims.set(p.key, (itemClaims.get(p.key) ?? 0) + 1);
  }

  for (const l of lines) {
    const numbered = byNumber(l);
    if (numbered.length > 0) {
      numbered.forEach((p) => claimed.add(p.key));
      result[l.id] =
        numbered.length === 1 && listsLine(l, numbered[0])
          ? { state: "IDENTIFIED", paymentKey: numbered[0].key, linkedBy: "order number" }
          : { state: "AMBIGUOUS_JOIN", paymentKey: null, linkedBy: null };
      continue;
    }

    const candidates = itemCandidates(l);
    candidates.forEach((p) => claimed.add(p.key));
    // A capture can land after the order month, so a failed next month leaves the answer open too.
    const month = l.orderedOn.slice(0, 7);
    const searchIncomplete = l.orderedOn < historyFrom || failed.has(month) || failed.has(nextMonth(month));
    if (searchIncomplete) {
      result[l.id] = { state: "HISTORY_UNAVAILABLE", paymentKey: null, linkedBy: null };
    } else if (candidates.length === 1 && itemClaims.get(candidates[0].key) === 1) {
      result[l.id] = {
        state: "IDENTIFIED",
        paymentKey: candidates[0].key,
        linkedBy: bySku(l).length > 0 ? "SKU" : "exact title",
      };
    } else if (candidates.length > 0) {
      result[l.id] = { state: "AMBIGUOUS_JOIN", paymentKey: null, linkedBy: null };
    } else {
      result[l.id] = { state: "NO_PAYPAL_RECORD", paymentKey: null, linkedBy: null };
    }
  }
  return { lines: result, unidentifiedPayments: payments.filter((p) => !claimed.has(p.key)).length };
}
