// Reads a shop's order export into order lines. Two formats:
//
// Shopify orders CSV. Format read 2026-11-05 from
// https://help.shopify.com/en/manual/fulfillment/managing-orders/exporting-orders
// "orders with multiple line items display their additional line items on separate lines. Many of
// the fields are left blank", so order-level fields are carried forward by order Name. "Lineitem
// discount" excludes order-level discounts, so the rest of "Discount Amount" is allocated by value.
//
// Generic CSV, for any other system. Required: order_number, title, quantity, unit_price, currency,
// ordered_on (YYYY-MM-DD). Optional: sku, discount, payment_reference, buyer_email.
//
// A row that cannot be read is reported, never dropped. Reasons never repeat the cell's value, so
// they are safe to show and log. Only the columns named here are read; addresses, names and every
// other column in the file are ignored and never stored.
import { parse } from "csv-parse/sync";

export interface ImportedOrderLine {
  orderNumber: string;
  /** This row's position within its order, counting rows that were rejected, so it is stable. */
  lineNo: number;
  title: string;
  sku: string | null;
  quantity: number;
  unitPriceCents: number;
  /** The line's whole discount: its own plus its share of any order-level discount. */
  discountCents: number;
  currency: string;
  orderedOn: string;
  paymentReference: string | null;
  buyerEmail: string | null;
  /** Another row of this order could not be read, so this line's share of any order discount may be wrong. */
  orderIncomplete?: boolean;
}

export interface RejectedRow {
  orderNumber: string;
  row: number;
  reason: string;
}

export interface ParsedExport {
  format: "shopify" | "generic";
  lines: ImportedOrderLine[];
  rejected: RejectedRow[];
}

type Row = Record<string, string>;
class RowError extends Error {}

// Amounts are stored in cents, so only two-decimal currencies are accepted.
const TWO_DECIMAL_CURRENCIES = new Set(["USD", "CAD", "EUR", "GBP", "AUD"]);
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function cents(value: string, column: string): number {
  const v = value.trim().replace(/,/g, "");
  const m = /^(\d+)(?:\.(\d{1,2}))?$/.exec(v);
  if (!m) throw new RowError(`${column}: not an amount`);
  return Number(m[1]) * 100 + Number((m[2] ?? "").padEnd(2, "0"));
}

function optionalCents(value: string | undefined, column: string): number {
  return value?.trim() ? cents(value, column) : 0;
}

function quantity(value: string, column: string): number {
  if (!/^[1-9]\d*$/.test(value.trim())) throw new RowError(`${column}: not a whole number above zero`);
  return Number(value.trim());
}

function currency(value: string, column: string): string {
  const c = value.trim().toUpperCase();
  if (!TWO_DECIMAL_CURRENCIES.has(c)) throw new RowError(`${column}: only USD, CAD, EUR, GBP and AUD are supported`);
  return c;
}

/** The calendar date as the file states it. Shopify writes "2026-03-14 10:22:05 -0400". */
function day(value: string, column: string): string {
  const d = value.trim().slice(0, 10);
  const t = new Date(`${d}T00:00:00Z`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d) || Number.isNaN(t.getTime()) || t.toISOString().slice(0, 10) !== d) {
    throw new RowError(`${column}: not a date`);
  }
  return d;
}

function email(value: string | undefined, column: string): string | null {
  const v = value?.trim();
  if (!v) return null;
  if (!EMAIL.test(v)) throw new RowError(`${column}: not an email address`);
  return v;
}

const text = (value: string | undefined) => value?.trim() || null;

/** Splits a total by weight in whole cents (largest remainder), so the parts always sum exactly. */
export function allocateDiscount(totalCents: number, weights: number[]): number[] {
  const sum = weights.reduce((a, b) => a + b, 0);
  if (sum <= 0 || totalCents <= 0) return weights.map(() => 0);
  const exact = weights.map((w) => (totalCents * w) / sum);
  const out = exact.map(Math.floor);
  let left = totalCents - out.reduce((a, b) => a + b, 0);
  const order = exact.map((e, i) => ({ i, frac: e - Math.floor(e) })).sort((a, b) => b.frac - a.frac || a.i - b.i);
  for (const { i } of order) {
    if (left <= 0) break;
    out[i]++;
    left--;
  }
  return out;
}

function parseShopify(rows: Row[]): ParsedExport {
  const orderFields = new Map<string, Row>();
  const seen = new Map<string, number>();
  const lines: ImportedOrderLine[] = [];
  const rejected: RejectedRow[] = [];
  const orderDiscount = new Map<string, number>();

  rows.forEach((row, index) => {
    const orderNumber = row["Name"]?.trim() ?? "";
    const lineNo = (seen.get(orderNumber) ?? 0) + 1;
    seen.set(orderNumber, lineNo);
    if (!orderFields.has(orderNumber)) orderFields.set(orderNumber, row);
    const first = orderFields.get(orderNumber)!;
    const field = (name: string) => row[name]?.trim() || first[name]?.trim() || "";
    try {
      if (!orderNumber) throw new RowError("Name: empty");
      const title = text(row["Lineitem name"]);
      if (!title) throw new RowError("Lineitem name: empty");
      const paymentReference =
        text(field("Payment ID")) ??
        text(field("Payment References").split(" + ")[0]) ??
        text(field("Payment Reference (deprecated)"));
      lines.push({
        orderNumber,
        lineNo,
        title,
        sku: text(row["Lineitem SKU"]),
        quantity: quantity(row["Lineitem quantity"] ?? "", "Lineitem quantity"),
        unitPriceCents: cents(row["Lineitem price"] ?? "", "Lineitem price"),
        discountCents: optionalCents(row["Lineitem discount"], "Lineitem discount"),
        currency: currency(field("Currency"), "Currency"),
        orderedOn: day(field("Created at"), "Created at"),
        paymentReference,
        buyerEmail: email(field("Email"), "Email"),
      });
      if (!orderDiscount.has(orderNumber)) {
        orderDiscount.set(orderNumber, optionalCents(field("Discount Amount"), "Discount Amount"));
      }
    } catch (err) {
      if (!(err instanceof RowError)) throw err;
      rejected.push({ orderNumber, row: index + 1, reason: err.message });
    }
  });

  // "Lineitem discount" does not include order-level discounts: allocate what remains by line value.
  for (const [orderNumber, total] of orderDiscount) {
    const mine = lines.filter((l) => l.orderNumber === orderNumber);
    const already = mine.reduce((a, l) => a + l.discountCents, 0);
    const shares = allocateDiscount(
      total - already,
      mine.map((l) => l.unitPriceCents * l.quantity - l.discountCents),
    );
    mine.forEach((l, i) => (l.discountCents += shares[i]));
  }
  return { format: "shopify", lines, rejected };
}

function parseGeneric(rows: Row[]): ParsedExport {
  const seen = new Map<string, number>();
  const lines: ImportedOrderLine[] = [];
  const rejected: RejectedRow[] = [];
  rows.forEach((raw, index) => {
    const row: Row = Object.fromEntries(Object.entries(raw).map(([k, v]) => [k.toLowerCase(), v]));
    const orderNumber = row.order_number?.trim() ?? "";
    const lineNo = (seen.get(orderNumber) ?? 0) + 1;
    seen.set(orderNumber, lineNo);
    try {
      if (!orderNumber) throw new RowError("order_number: empty");
      const title = text(row.title);
      if (!title) throw new RowError("title: empty");
      lines.push({
        orderNumber,
        lineNo,
        title,
        sku: text(row.sku),
        quantity: quantity(row.quantity ?? "", "quantity"),
        unitPriceCents: cents(row.unit_price ?? "", "unit_price"),
        discountCents: optionalCents(row.discount, "discount"),
        currency: currency(row.currency ?? "", "currency"),
        orderedOn: day(row.ordered_on ?? "", "ordered_on"),
        paymentReference: text(row.payment_reference),
        buyerEmail: email(row.buyer_email, "buyer_email"),
      });
    } catch (err) {
      if (!(err instanceof RowError)) throw err;
      rejected.push({ orderNumber, row: index + 1, reason: err.message });
    }
  });
  return { format: "generic", lines, rejected };
}

const GENERIC_REQUIRED = ["order_number", "title", "quantity", "unit_price", "currency", "ordered_on"];

function markIncompleteOrders(parsed: ParsedExport): ParsedExport {
  const incomplete = new Set(parsed.rejected.map((r) => r.orderNumber));
  for (const line of parsed.lines) line.orderIncomplete = incomplete.has(line.orderNumber);
  return parsed;
}

export function parseShopExport(csv: string): ParsedExport {
  const rows = parse(csv, {
    columns: (header: string[]) => header.map((h) => h.trim()),
    bom: true,
    skip_empty_lines: true,
    relax_column_count: true,
  }) as Row[];
  const header = Object.keys(rows[0] ?? {});
  if (header.includes("Lineitem name") && header.includes("Name")) return markIncompleteOrders(parseShopify(rows));
  const lower = header.map((h) => h.toLowerCase());
  if (GENERIC_REQUIRED.every((c) => lower.includes(c))) return markIncompleteOrders(parseGeneric(rows));
  throw new Error("not a recognized order export: expected Shopify's order CSV or the generic columns in README");
}
