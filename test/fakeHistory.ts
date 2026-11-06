import { HISTORY_POOL } from "../server/demo/historyPool";
import type { RequestOptions } from "../server/paypal/client";

const row = (i: number, info: Record<string, unknown>, items: { item_name: string; item_code: string }[] = []) => ({
  transaction_info: {
    transaction_id: `POOLTXN${i}`,
    transaction_event_code: "T0005",
    transaction_status: "S",
    transaction_initiation_date: "2026-11-05T23:45:00+0000",
    transaction_amount: { currency_code: "USD", value: "42.00" },
    ...info,
  },
  cart_info: { item_details: items },
});

/** What Transaction Search answers: the standing pool, another session's sale, and a refund that is not a sale. */
export const historyRows = [
  ...HISTORY_POOL.map((p, i) => {
    const cents = p.lines.reduce((sum, l) => sum + l.unitPriceCents, 0) || p.amountCents || 0;
    return row(
      i,
      { invoice_id: p.orderNumber ?? undefined, transaction_amount: { currency_code: "USD", value: (cents / 100).toFixed(2) } },
      p.lines.map((l) => ({ item_name: l.title, item_code: l.sku })),
    );
  }),
  row(90, { invoice_id: "DEMO-abcd1234-1" }, [{ item_name: "Someone else's sale", item_code: "DEMO-OTHER" }]),
  row(91, { transaction_event_code: "T1107", transaction_amount: { currency_code: "USD", value: "-2.00" } }),
];

/** Answers a search request, or null if this is not one. Passing `fail` makes every search fail. */
export function answerSearch(path: string, _opts: RequestOptions = {}, fail = false) {
  if (path !== "/v1/reporting/transactions") return null;
  if (fail) throw new Error("search failed");
  return { status: 200, data: { transaction_details: historyRows, total_pages: 1 } };
}
