// A recalled item sells, and a card reaches the seller's queue with no one pressing anything. The line comes from
// the shop's own listing, and the check is the local one. PayPal's webhook only says when to look.
import { createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import type { Db } from "../db/types";
import type { ImportedOrderLine } from "../import/shopExport";
import { storeOrderLines } from "../import/store";
import { runShopCheck } from "../match/run";
import type { PayPalClient } from "../paypal/client";
import { captureOrder, createCardOrder, createPayPalOrder, getOrder, orderIdOfCapture } from "../paypal/orders";
import { createContactCipher } from "../privacy/contactCipher";
import { pushNewCards } from "../push/push";
import { businessDay } from "../time/businessDay";
import { DEMO_LABEL, SANDBOX_TEST_CARD } from "./seed";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class LiveSaleRefused extends Error {
  constructor() {
    super("That item can't be bought here.");
    this.name = "LiveSaleRefused";
  }
}

interface ListedItem {
  title: string;
  sku: string | null;
  price_cents: number;
  currency: string;
}

/** An item this demo shop lists at a price, or a refusal. */
async function listedItem(db: Db, shopId: string, shopItemId: string): Promise<ListedItem> {
  if (!UUID.test(shopItemId)) throw new LiveSaleRefused();
  const { rows } = await db.query<{ title: string; sku: string | null; price_cents: number | null; currency: string | null }>(
    `select i.title, i.sku, i.price_cents, i.currency from shop_items i join shops s on s.id = i.shop_id
     where i.id = $1 and i.shop_id = $2 and i.listed and s.kind = 'DEMO'`,
    [shopItemId, shopId],
  );
  const item = rows[0];
  if (!item || !item.price_cents || !item.currency) throw new LiveSaleRefused();
  return { ...item, price_cents: item.price_cents, currency: item.currency };
}

const newOrderNumber = () => `DEMO-LIVE-${randomBytes(6).toString("hex")}`;

/** The sale, from the shop's own listing. Written before the capture: PayPal's webhook can arrive before that call returns. */
async function writeLiveSale(db: Db, input: { shopId: string; today: string; secret: string; demoEmail?: string }, item: ListedItem, orderNumber: string): Promise<void> {
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
  await storeOrderLines(db, input.shopId, [line], createContactCipher(input.secret, input.shopId), `${DEMO_LABEL}: sold just now, with a sandbox capture`);
  await db.query("update order_lines set live_sale = true where shop_id = $1 and order_number = $2", [input.shopId, orderNumber]);
}

/** A family buys a listed item on the demo shop, with the sandbox test card, so no one needs a PayPal login. */
export async function buyAsFamily(
  db: Db,
  client: PayPalClient,
  input: { shopId: string; shopItemId: string; today: string; secret: string; demoEmail?: string },
): Promise<{ orderNumber: string }> {
  const item = await listedItem(db, input.shopId, input.shopItemId);
  const orderNumber = newOrderNumber();
  await writeLiveSale(db, input, item, orderNumber);
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

const PAYPAL_RETURN = "/api/demo/buy/paypal/return";
const ORDER_NUMBER = /^DEMO-LIVE-[0-9a-f]{12}$/;
const PAYPAL_ID = /^[A-Za-z0-9-]+$/;

/** Each part has a fixed shape, checked before this is compared, so joining them can't make two states read alike. */
const stateSignature = (sessionSecret: string, shopId: string, sessionId: string, shopItemId: string, orderNumber: string) =>
  createHmac("sha256", sessionSecret).update(`paypal-return:${shopId}:${sessionId}:${shopItemId}:${orderNumber}`).digest("base64url");

/** What the return address carries, tied to this shop in this browser. */
export const checkoutState = (sessionSecret: string, shopId: string, sessionId: string, shopItemId: string, orderNumber: string) =>
  `${shopItemId}.${orderNumber}.${stateSignature(sessionSecret, shopId, sessionId, shopItemId, orderNumber)}`;

/**
 * The same sale through PayPal's own approval page, where a person logs in. Nothing is stored here: the buyer may never
 * come back. The return address is signed, so it can't be pointed at another shop, item or order.
 */
export async function startPayPalBuy(
  db: Db,
  client: PayPalClient,
  input: { shopId: string; sessionId: string; shopItemId: string; siteUrl: string; sessionSecret: string },
): Promise<{ orderId: string; approveUrl: string; returnUrl: string }> {
  const item = await listedItem(db, input.shopId, input.shopItemId);
  const orderNumber = newOrderNumber();
  const state = checkoutState(input.sessionSecret, input.shopId, input.sessionId, input.shopItemId, orderNumber);
  const returnUrl = `${input.siteUrl}${PAYPAL_RETURN}?state=${encodeURIComponent(state)}`;
  const { orderId, approveUrl } = await createPayPalOrder(client, {
    orderNumber,
    currency: item.currency,
    discountCents: 0,
    lines: [{ title: item.title, sku: item.sku, quantity: 1, unitPriceCents: item.price_cents }],
    requestId: randomUUID(),
    returnUrl,
    cancelUrl: `${input.siteUrl}${PAYPAL_RETURN}?cancelled=1`,
    brandName: DEMO_LABEL,
  });
  return { orderId, approveUrl, returnUrl };
}

/** The state's parts, if this server signed them for this shop. */
function readState(state: string, shopId: string, sessionId: string, sessionSecret: string): { shopItemId: string; orderNumber: string } | null {
  const [shopItemId = "", orderNumber = "", signature = ""] = state.split(".");
  if (!UUID.test(shopItemId) || !ORDER_NUMBER.test(orderNumber)) return null;
  const given = Buffer.from(signature);
  const expected = Buffer.from(stateSignature(sessionSecret, shopId, sessionId, shopItemId, orderNumber));
  return given.length === expected.length && timingSafeEqual(given, expected) ? { shopItemId, orderNumber } : null;
}

/**
 * The buyer is back from PayPal. The address proves nothing about the payment, so the order is read from PayPal and must
 * be the one this state started, approved, at the listed price. Then the webhook does the rest, as with the test card.
 */
export async function finishPayPalBuy(
  db: Db,
  client: PayPalClient,
  input: { shopId: string; sessionId: string; state: string; orderId: string; today: string; secret: string; sessionSecret: string; demoEmail?: string },
): Promise<void> {
  const signed = readState(input.state, input.shopId, input.sessionId, input.sessionSecret);
  if (!signed || !PAYPAL_ID.test(input.orderId)) throw new LiveSaleRefused();
  const item = await listedItem(db, input.shopId, signed.shopItemId);
  const order = await getOrder(client, input.orderId);
  const atListedPrice =
    order.items.length === 1 && order.items[0].quantity === 1 && order.items[0].unitCents === item.price_cents && order.amountCents === item.price_cents && order.currency === item.currency;
  if (order.invoiceId !== signed.orderNumber || !atListedPrice || (order.status !== "APPROVED" && order.status !== "COMPLETED")) throw new LiveSaleRefused();

  // Only once: a reload must not change the sale.
  const written = await db.query("select 1 from order_lines where shop_id = $1 and order_number = $2", [input.shopId, signed.orderNumber]);
  if (written.rows.length === 0) await writeLiveSale(db, input, item, signed.orderNumber);
  if (order.status === "COMPLETED") return;
  try {
    await captureOrder(client, input.orderId, `capture-${input.orderId}`);
  } catch (err) {
    // The error alone can't say: another return may have captured it, or this try may have. PayPal's order can.
    const after = await getOrder(client, input.orderId).catch(() => null);
    if (after?.status === "COMPLETED") return;
    // Not paid, so nothing is sold. With no answer at all, a capture's webhook may still need this line.
    if (after) await db.query("delete from order_lines where shop_id = $1 and order_number = $2", [input.shopId, signed.orderNumber]);
    throw err;
  }
}

export type CatchResult = "CAUGHT" | "ALREADY" | "NOT_COMPLETED" | "NOT_A_LIVE_SALE";

/**
 * A capture PayPal says completed. Confirmed through PayPal's API, joined by the shop's invoice number, and checked
 * for that one line. Safe to repeat: PayPal delivers again if an attempt fails.
 */
export async function catchLiveSale(db: Db, client: PayPalClient, input: { captureId: string; now: Date; pushFetch?: typeof fetch }): Promise<CatchResult> {
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

  const caught = await db.query<{ id: string }>(
    "update recall_matches set caught_at = $2 where order_line_id = $1 and verdict <> 'CLEARED' and caught_at is null returning id",
    [line.id, input.now.toISOString()],
  );
  if (caught.rows.length === 0) return "ALREADY";
  const capturedAt = Date.parse(capture.createTime ?? "");
  if (!Number.isNaN(capturedAt)) {
    const seconds = Math.max(0, Math.round((input.now.getTime() - capturedAt) / 100) / 10);
    await db.query("insert into live_catch_runs (seconds, caught_at) values ($1, $2)", [seconds, input.now.toISOString()]);
  }
  await pushNewCards(db, line.shop_id, caught.rows.map((r) => r.id), input.pushFetch);
  return "CAUGHT";
}
