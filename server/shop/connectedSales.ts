// A connected shop's own sales: PayPal's Transaction Search on the shop's own account, acting for it with
// PayPal-Auth-Assertion, joined locally to the order file the shop gave. What PayPal returns is kept only for the join,
// ages out with the rest of the PayPal data, and never goes to Claude or anyone else.
import type { Db } from "../db/types";
import { runShopCheck } from "../match/run";
import type { PayPalClient } from "../paypal/client";
import { failedMonths, searchTransactions } from "../paypal/transactions";
import { businessDay } from "../time/businessDay";

const DAY_MS = 86_400_000;

export async function readConnectedShopSales(db: Db, client: PayPalClient, input: { shopId: string; now: Date }): Promise<{ complete: boolean; payments: number }> {
  const { rows } = await db.query<{ first: string | null }>("select min(ordered_on)::text as first from order_lines where shop_id = $1", [input.shopId]);
  // From the day before the file's first order. searchTransactions caps it at what PayPal keeps.
  const from = rows[0]?.first ? new Date(Date.parse(`${rows[0].first}T00:00:00Z`) - DAY_MS) : new Date(input.now.getTime() - 90 * DAY_MS);
  const { payments, coverage } = await searchTransactions(client, { from, to: input.now });
  // A search row has no order id. Its transaction id is the capture's, and it is what makes the row unique here.
  for (const p of payments) {
    await db.query(
      `insert into paypal_payments (shop_id, order_id, order_number, capture_id, capture_status, captured_at, amount_cents, currency, items)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb)
       on conflict (shop_id, order_id) do nothing`,
      [input.shopId, p.transactionId, p.invoiceId, p.transactionId, p.status, p.paidAt, p.amountCents, p.currency, JSON.stringify(p.items)],
    );
  }
  await runShopCheck(db, input.shopId, { today: businessDay(input.now), paypalSearched: coverage.complete, failedMonths: failedMonths(coverage.failedWindows), search: coverage });
  return { complete: coverage.complete, payments: payments.length };
}
