// A recalled item sells, and a card reaches the seller's queue with no one pressing anything. The line comes from
// the shop's own listing, and the check is the local one. PayPal's webhook only says when to look.
import { randomBytes, randomUUID } from "node:crypto";
import type { Db } from "../db/types";
import type { ImportedOrderLine } from "../import/shopExport";
import { storeOrderLines } from "../import/store";
import { runShopCheck } from "../match/run";
import type { PayPalClient } from "../paypal/client";
import { createCardOrder, getOrder, orderIdOfCapture } from "../paypal/orders";
import { createContactCipher } from "../privacy/contactCipher";
import { businessDay } from "../time/businessDay";
import { DEMO_LABEL, SANDBOX_TEST_CARD } from "./seed";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class LiveSaleRefused extends Error {
  constructor() {
    super("That item can't be bought here.");
    this.name = "LiveSaleRefused";
  }
}

/** A family buys a listed item on the demo shop, with the sandbox test card, so no one needs a PayPal login. */
export async function buyAsFamily(
  db: Db,
  client: PayPalClient,
  input: { shopId: string; shopItemId: string; today: string; secret: string; demoEmail?: string },
): Promise<{ orderNumber: string }> {
  if (!UUID.test(input.shopItemId)) throw new LiveSaleRefused();
  const { rows } = await db.query<{ title: string; sku: string | null; price_cents: number | null; currency: string | null }>(
    `select i.title, i.sku, i.price_cents, i.currency from shop_items i join shops s on s.id = i.shop_id
     where i.id = $1 and i.shop_id = $2 and i.listed and s.kind = 'DEMO'`,
    [input.shopItemId, input.shopId],
  );
  const item = rows[0];
  if (!item || !item.price_cents || !item.currency) throw new LiveSaleRefused();

  const orderNumber = `DEMO-LIVE-${randomBytes(6).toString("hex")}`;
  const line: ImportedOrderLine = {
    orderNumber,
    lineNo: 1,
    title: item.title,
    sku: item.sku,
    quantity: 1,
    unitPriceCents: item.price_cents,
    discountCents: 0,
    currency: item.currency,
    orderedOn: input.today,
    paymentReference: null,
    buyerEmail: input.demoEmail ?? null,
  };
  // Written first: PayPal's webhook can arrive before this call returns.
  await storeOrderLines(db, input.shopId, [line], createContactCipher(input.secret, input.shopId), `${DEMO_LABEL}: sold just now, with a sandbox capture`);
  await db.query("update order_lines set live_sale = true where shop_id = $1 and order_number = $2", [input.shopId, orderNumber]);
  try {
    await createCardOrder(client, {
      orderNumber,
      currency: item.currency,
      discountCents: 0,
      lines: [{ title: item.title, sku: item.sku, quantity: 1, unitPriceCents: item.price_cents }],
      requestId: randomUUID(),
      card: SANDBOX_TEST_CARD,
    });
  } catch (err) {
    await db.query("delete from order_lines where shop_id = $1 and order_number = $2", [input.shopId, orderNumber]);
    throw err;
  }
  return { orderNumber };
}

export type CatchResult = "CAUGHT" | "ALREADY" | "NOT_COMPLETED" | "NOT_A_LIVE_SALE";

/**
 * A capture PayPal says completed. Confirmed through PayPal's API, joined by the shop's invoice number, and checked
 * for that one line. Safe to repeat: PayPal delivers again if an attempt fails.
 */
export async function catchLiveSale(db: Db, client: PayPalClient, input: { captureId: string; now: Date }): Promise<CatchResult> {
  const orderId = await orderIdOfCapture(client, input.captureId);
  if (!orderId) return "NOT_A_LIVE_SALE";
  const order = await getOrder(client, orderId);
  if (!order.invoiceId) return "NOT_A_LIVE_SALE";
  const { rows } = await db.query<{ id: string; shop_id: string }>("select id, shop_id from order_lines where order_number = $1 and live_sale", [order.invoiceId]);
  const line = rows[0];
  if (!line) return "NOT_A_LIVE_SALE";
  const capture = order.capture;
  if (capture?.id !== input.captureId || capture.status !== "COMPLETED") return "NOT_COMPLETED";

  await db.query(
    `insert into paypal_payments (shop_id, order_id, order_number, capture_id, capture_status, captured_at, amount_cents, currency, items)
     values ($1, $2, $3, $4, $5, $6::timestamptz, $7, $8, $9::jsonb)
     on conflict (shop_id, order_id) do nothing`,
    [
      line.shop_id,
      order.orderId,
      order.invoiceId,
      capture.id,
      capture.status,
      capture.createTime,
      capture.amountCents,
      capture.currency,
      JSON.stringify(order.items.map((i) => ({ name: i.name, sku: i.sku }))),
    ],
  );
  await runShopCheck(db, line.shop_id, { today: businessDay(input.now), onlyRecordId: line.id });

  const caught = await db.query(
    "update recall_matches set caught_at = $2 where order_line_id = $1 and verdict <> 'CLEARED' and caught_at is null returning id",
    [line.id, input.now.toISOString()],
  );
  if (caught.rows.length === 0) return "ALREADY";
  const capturedAt = Date.parse(capture.createTime ?? "");
  if (!Number.isNaN(capturedAt)) {
    const seconds = Math.max(0, Math.round((input.now.getTime() - capturedAt) / 100) / 10);
    await db.query("insert into live_catch_runs (seconds, caught_at) values ($1, $2)", [seconds, input.now.toISOString()]);
  }
  return "CAUGHT";
}
