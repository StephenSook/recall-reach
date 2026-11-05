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

function monthsBefore(today: string, months: number): string {
  const d = new Date(`${today}T00:00:00Z`);
  d.setUTCMonth(d.getUTCMonth() - months);
  return d.toISOString().slice(0, 10);
}

export function joinOrderLines(
  lines: JoinLine[],
  payments: JoinPayment[],
  opts: { today: string; failedMonths?: string[] },
): JoinResult {
  const failed = new Set(opts.failedMonths ?? []);
  const historyFrom = monthsBefore(opts.today, PAYPAL_HISTORY_MONTHS);
  const result: Record<string, LineJoin> = {};
  const claimed = new Set<string>();

  const byNumber = (l: JoinLine) => payments.filter((p) => p.orderNumber === l.orderNumber);
  // Item-level links apply only to payments that carry no order number of their own.
  const bySku = (l: JoinLine) =>
    l.sku ? payments.filter((p) => !p.orderNumber && p.items.some((i) => i.sku === l.sku)) : [];
  const byTitle = (l: JoinLine) =>
    payments.filter((p) => !p.orderNumber && p.items.some((i) => i.name === l.title));

  const itemClaims = new Map<string, number>();
  for (const l of lines) {
    if (byNumber(l).length > 0) continue;
    const candidates = bySku(l).length > 0 ? bySku(l) : byTitle(l);
    for (const p of candidates) itemClaims.set(p.key, (itemClaims.get(p.key) ?? 0) + 1);
  }

  for (const l of lines) {
    const numbered = byNumber(l);
    if (numbered.length === 1) {
      claimed.add(numbered[0].key);
      result[l.id] = { state: "IDENTIFIED", paymentKey: numbered[0].key, linkedBy: "order number" };
      continue;
    }
    if (numbered.length > 1) {
      numbered.forEach((p) => claimed.add(p.key));
      result[l.id] = { state: "AMBIGUOUS_JOIN", paymentKey: null, linkedBy: null };
      continue;
    }
    const viaSku = bySku(l);
    const candidates = viaSku.length > 0 ? viaSku : byTitle(l);
    candidates.forEach((p) => claimed.add(p.key));
    if (candidates.length === 1 && itemClaims.get(candidates[0].key) === 1) {
      result[l.id] = {
        state: "IDENTIFIED",
        paymentKey: candidates[0].key,
        linkedBy: viaSku.length > 0 ? "SKU" : "exact title",
      };
    } else if (candidates.length > 0) {
      result[l.id] = { state: "AMBIGUOUS_JOIN", paymentKey: null, linkedBy: null };
    } else if (l.orderedOn < historyFrom || failed.has(l.orderedOn.slice(0, 7))) {
      result[l.id] = { state: "HISTORY_UNAVAILABLE", paymentKey: null, linkedBy: null };
    } else {
      result[l.id] = { state: "NO_PAYPAL_RECORD", paymentKey: null, linkedBy: null };
    }
  }
  return { lines: result, unidentifiedPayments: payments.filter((p) => !claimed.has(p.key)).length };
}
