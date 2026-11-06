// PayPal Transaction Search: GET /v1/reporting/transactions. Local use only, never sent to a third party.
//
// Limits, read 2026-11-05 from https://developer.paypal.com/docs/api/transaction-search/v1/ and its spec
// (paypal-rest-api-specifications reporting_transactions_v1.json at 7bbed78):
// - end_date: "The maximum supported range is 31 days."
// - "This call lists transaction for the previous three years."
// - "It takes a maximum of three hours for executed transactions to appear". Measured once in the sandbox:
//   about 213 minutes (2026-11-05), so a sale made moments ago is not here yet.
// - page_size is at most 500. fields=all is what includes item details (cart_info).
//
// A window that cannot be read in full is recorded as failed. It never reads as "no sales".
import { z } from "zod";
import type { PayPalClient } from "./client";
import { valueToCents } from "./orders";

const PATH = "/v1/reporting/transactions";
const WINDOW_MS = 31 * 86_400_000;
const PAGE_SIZE = 500;
const HISTORY_MONTHS = 36;
/** A start this close to PayPal's limit may be past it by the time the search runs. */
const HISTORY_MARGIN_MS = 2 * 86_400_000;

// T00 is PayPal's payment family (a card capture measured as T0005). T11 is a reversal; T19 an adjustment.
const SALE_EVENT_FAMILY = "T00";

// Only these fields are read. Everything else in the answer, including payer_info, is dropped here.
const rowSchema = z.object({
  transaction_info: z.object({
    transaction_id: z.string().min(1),
    transaction_event_code: z.string().optional(),
    transaction_status: z.string().optional(),
    transaction_initiation_date: z.string().optional(),
    transaction_amount: z.object({ currency_code: z.string(), value: z.string() }).optional(),
    invoice_id: z.string().optional(),
    custom_field: z.string().optional(),
  }),
  cart_info: z
    .object({
      item_details: z.array(z.object({ item_name: z.string().optional(), item_code: z.string().optional() })).optional(),
    })
    .optional(),
});

const pageSchema = z.object({
  transaction_details: z.array(rowSchema),
  total_pages: z.number().int().optional(),
});

export interface SearchedPayment {
  transactionId: string;
  invoiceId: string | null;
  customField: string | null;
  status: string | null;
  paidAt: string | null;
  amountCents: number;
  currency: string;
  items: { name: string; sku: string | null }[];
}

export interface SearchWindow {
  start: string;
  end: string;
}

export interface SearchCoverage {
  from: string;
  to: string;
  /** The range asked for reached past PayPal's three years. */
  capped: boolean;
  windows: number;
  failedWindows: SearchWindow[];
  rowsRead: number;
  duplicatesRemoved: number;
  /** Refunds, adjustments, denied payments and rows with no amount. */
  notPayments: number;
  /** Every window was read to its last page. */
  complete: boolean;
}

const rfc3339 = (ms: number) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");

/** Windows of at most 31 days that cover the range exactly, one second apart. */
export function searchWindows(from: Date, to: Date): SearchWindow[] {
  const end = Math.floor(to.getTime() / 1000) * 1000;
  const windows: SearchWindow[] = [];
  for (let start = Math.floor(from.getTime() / 1000) * 1000; start <= end; start += WINDOW_MS + 1000) {
    windows.push({ start: rfc3339(start), end: rfc3339(Math.min(start + WINDOW_MS, end)) });
  }
  return windows;
}

/** PayPal writes "+0000". Anything unreadable stays null rather than a wrong date. */
function paidAtOf(value: string | undefined): string | null {
  if (!value) return null;
  const ms = Date.parse(value.replace(/([+-]\d{2})(\d{2})$/, "$1:$2"));
  return Number.isNaN(ms) ? null : new Date(ms).toISOString();
}

export async function searchTransactions(
  client: PayPalClient,
  range: { from: Date; to: Date },
): Promise<{ payments: SearchedPayment[]; coverage: SearchCoverage }> {
  const limit = new Date(range.to);
  limit.setUTCMonth(limit.getUTCMonth() - HISTORY_MONTHS);
  const earliest = limit.getTime() + HISTORY_MARGIN_MS;
  const capped = range.from.getTime() < earliest;
  const from = capped ? new Date(earliest) : range.from;
  const windows = searchWindows(from, range.to);

  const seen = new Set<string>();
  const payments: SearchedPayment[] = [];
  const failedWindows: SearchWindow[] = [];
  let rowsRead = 0;
  let duplicatesRemoved = 0;
  let notPayments = 0;

  for (const window of windows) {
    try {
      for (let page = 1; ; page++) {
        const { data } = await client.request("GET", PATH, {
          query: { start_date: window.start, end_date: window.end, fields: "all", page_size: PAGE_SIZE, page },
        });
        const parsed = pageSchema.parse(data);
        for (const { transaction_info: info, cart_info: cart } of parsed.transaction_details) {
          rowsRead++;
          if (seen.has(info.transaction_id)) {
            duplicatesRemoved++;
            continue;
          }
          seen.add(info.transaction_id);
          const value = info.transaction_amount?.value;
          const isSale = info.transaction_event_code?.startsWith(SALE_EVENT_FAMILY) ?? false;
          if (!isSale || !value || value.startsWith("-") || info.transaction_status === "D") {
            notPayments++;
            continue;
          }
          const amountCents = valueToCents(value);
          if (amountCents === 0) {
            notPayments++;
            continue;
          }
          payments.push({
            transactionId: info.transaction_id,
            invoiceId: info.invoice_id ?? null,
            customField: info.custom_field ?? null,
            status: info.transaction_status ?? null,
            paidAt: paidAtOf(info.transaction_initiation_date),
            amountCents,
            currency: info.transaction_amount?.currency_code ?? "",
            items: (cart?.item_details ?? []).map((i) => ({ name: i.item_name ?? "", sku: i.item_code ?? null })),
          });
        }
        if (page >= (parsed.total_pages ?? 1)) break;
      }
    } catch {
      failedWindows.push(window);
    }
  }

  return {
    payments,
    coverage: {
      from: windows[0]?.start ?? rfc3339(from.getTime()),
      to: rfc3339(range.to.getTime()),
      capped,
      windows: windows.length,
      failedWindows,
      rowsRead,
      duplicatesRemoved,
      notPayments,
      complete: failedWindows.length === 0,
    },
  };
}

/** The months a failed window touches: a sale in any of them may have been missed. */
export function failedMonths(failed: SearchWindow[]): string[] {
  const months = new Set<string>();
  for (const w of failed) {
    const end = w.end.slice(0, 7);
    const d = new Date(`${w.start.slice(0, 7)}-01T00:00:00Z`);
    for (let month = w.start.slice(0, 7); month <= end; month = d.toISOString().slice(0, 7)) {
      months.add(month);
      d.setUTCMonth(d.getUTCMonth() + 1);
    }
  }
  return [...months];
}
