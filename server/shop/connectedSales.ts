// A connected shop's own sales: PayPal's Transaction Search on the shop's own account, acting for it with
// PayPal-Auth-Assertion, joined locally to the order file the shop gave. What PayPal returns is kept only for the join,
// ages out with the rest of the PayPal data, and never goes to Claude or anyone else.
import type { Db, Queryable } from "../db/types";
import { runShopCheck } from "../match/run";
import type { PayPalClient } from "../paypal/client";
import { failedMonths, searchTransactions, type SearchCoverage } from "../paypal/transactions";
import { businessDay } from "../time/businessDay";
import { recordSalesRead } from "./paypalConnection";

const DAY_MS = 86_400_000;

/**
 * Reads the shop's sales from PayPal and saves them, under the shop's lock. With notAfter, no request starts after it.
 * A read that stopped partway saves nothing, and is recorded as incomplete, so refunds from the shop's account wait for a
 * full one even where an earlier read left payments behind: a page it never read could hold a second payment for a sale.
 */
export async function readConnectedShopSales(db: Queryable, client: PayPalClient, input: { shopId: string; now: Date; notAfter?: number }): Promise<{ complete: boolean; payments: number; coverage: SearchCoverage }> {
  const { rows } = await db.query<{ first: string | null }>("select min(ordered_on)::text as first from order_lines where shop_id = $1", [input.shopId]);
  // From the day before the file's first order. searchTransactions caps it at what PayPal keeps.
  const from = rows[0]?.first ? new Date(Date.parse(`${rows[0].first}T00:00:00Z`) - DAY_MS) : new Date(input.now.getTime() - 90 * DAY_MS);
  const { payments, coverage } = await searchTransactions(client, { from, to: input.now }, { notAfter: input.notAfter });
  if (coverage.complete && payments.length > 0) {
    // One statement however many payments, so the work under the shop's lock stays short. A search row has no order id:
    // its transaction id is the capture's, and it is what makes the row unique here.
    await db.query(
      `insert into paypal_payments (shop_id, order_id, order_number, capture_id, capture_status, captured_at, amount_cents, currency, items)
       select $1, p.id, p.order_number, p.id, p.status, p.paid_at, p.cents, p.currency, p.items
       from jsonb_to_recordset($2::jsonb) as p(id text, order_number text, status text, paid_at timestamptz, cents integer, currency text, items jsonb)
       on conflict (shop_id, order_id) do nothing`,
      [input.shopId, JSON.stringify(payments.map((p) => ({ id: p.transactionId, order_number: p.invoiceId, status: p.status, paid_at: p.paidAt, cents: p.amountCents, currency: p.currency, items: p.items })))],
    );
  }
  await recordSalesRead(db, { shopId: input.shopId, complete: coverage.complete, now: input.now });
  return { complete: coverage.complete, payments: payments.length, coverage };
}

/** Checks the shop against the recalls with what that read saved. Run after the shop's lock is released, as an upload's check is. */
export async function checkConnectedShop(db: Db, input: { shopId: string; now: Date; coverage: SearchCoverage }): Promise<void> {
  await runShopCheck(db, input.shopId, { today: businessDay(input.now), paypalSearched: input.coverage.complete, failedMonths: failedMonths(input.coverage.failedWindows), search: input.coverage });
}
