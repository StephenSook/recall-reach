// A recalled item sells, and a card reaches the seller's queue with no one pressing anything. The line comes from
// the shop's own listing, and the check is the local one. PayPal's webhook only says when to look.
import { createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import type { Db, Queryable } from "../db/types";
import type { ImportedOrderLine } from "../import/shopExport";
import { storeOrderLines } from "../import/store";
import { runShopCheck } from "../match/run";
import { prepareStandingNotices } from "../notice/standing";
import { PayPalApiError, type PayPalClient } from "../paypal/client";
import { callsBelongTo } from "../paypal/callLog";
import { captureOrder, createCardOrder, createPayPalOrder, getOrder, orderIdOfCapture, type OrderFacts } from "../paypal/orders";
import { createContactCipher } from "../privacy/contactCipher";
import { pushNewCards } from "../push/push";
import { SALE_ON_ITS_WAY_MINUTES } from "../queue/queue";
import { businessDay } from "../time/businessDay";
import { DEMO_LABEL, SANDBOX_TEST_CARD } from "./seed";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class LiveSaleRefused extends Error {
  constructor(message = "That item can't be bought here.") {
    super(message);
    this.name = "LiveSaleRefused";
  }
}

/** Each sale is real, and PayPal can take a minute or two to report one, so a second press mustn't make a second sale. */
async function refuseWhileOneIsOnItsWay(db: Queryable, shopId: string): Promise<void> {
  const { rows } = await db.query(
    `select 1 from order_lines l where l.shop_id = $1 and l.live_sale and l.imported_at > now() - make_interval(mins => $2)
     and not exists (select 1 from recall_matches m where m.order_line_id = l.id and m.caught_at is not null) limit 1`,
    [shopId, SALE_ON_ITS_WAY_MINUTES],
  );
  if (rows.length > 0) throw new LiveSaleRefused("That sale is on its way. PayPal can take a minute or two to tell us.");
}

/** Like the shop connection lock, with a separate namespace. The check and reservation share this transaction. */
async function withSaleLock<T>(db: Db, shopId: string, run: (tx: Queryable) => Promise<T>): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.query("select pg_advisory_xact_lock(hashtext('shop-live-sale'), hashtext($1))", [shopId]);
    return run(tx);
  });
}

/**
 * A failed checkout may release only a reservation that no completed payment has confirmed. Once a capture has begun only
 * that capture's own run may release it, having seen it fail: anyone else's read of PayPal may be from before it began.
 */
async function releaseReservation(db: Db, shopId: string, orderNumber: string, opts: { evenIfCaptureStarted?: boolean } = {}): Promise<boolean> {
  return withSaleLock(db, shopId, async (tx) => {
    const { rows } = await tx.query(
      `delete from order_lines l where l.shop_id = $1 and l.order_number = $2 and l.capture_pending
       and (not l.capture_started or $3::boolean)
       and not exists (select 1 from paypal_payments p where p.shop_id = l.shop_id and p.order_number = l.order_number)
       returning l.id`,
      [shopId, orderNumber, Boolean(opts.evenIfCaptureStarted)],
    );
    return rows.length > 0;
  });
}

/** The API response and webhook confirm a sale with the same atomic writes, excluding cancellation. */
async function confirmLiveSale(db: Db, shopId: string, order: OrderFacts): Promise<string | null> {
  const capture = order.capture;
  if (!capture || capture.status !== "COMPLETED") return null;
  return withSaleLock(db, shopId, async (tx) => {
    const { rows } = await tx.query<{ id: string }>(
      "select id from order_lines where shop_id = $1 and order_number = $2 and live_sale",
      [shopId, order.invoiceId],
    );
    const line = rows[0];
    if (!line) return null;
    await tx.query(
      `insert into paypal_payments (shop_id, order_id, order_number, capture_id, capture_status, captured_at, amount_cents, currency, items)
       values ($1, $2, $3, $4, $5, $6::timestamptz, $7, $8, $9::jsonb)
       on conflict (shop_id, order_id) do nothing`,
      [shopId, order.orderId, order.invoiceId, capture.id, capture.status, capture.createTime, capture.amountCents, capture.currency,
        JSON.stringify(order.items.map((i) => ({ name: i.name, sku: i.sku })))],
    );
    await tx.query("update order_lines set capture_pending = false where id = $1", [line.id]);
    return line.id;
  });
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
async function writeLiveSale(db: Queryable, input: { shopId: string; today: string; secret: string; demoEmail?: string }, item: ListedItem, orderNumber: string): Promise<void> {
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
  await db.query("update order_lines set live_sale = true, capture_pending = true where shop_id = $1 and order_number = $2", [input.shopId, orderNumber]);
}

/** A family buys a listed item on the demo shop, with the sandbox test card, so no one needs a PayPal login. */
export async function buyAsFamily(
  db: Db,
  client: PayPalClient,
  input: { shopId: string; shopItemId: string; today: string; secret: string; demoEmail?: string },
): Promise<{ orderNumber: string }> {
  const item = await listedItem(db, input.shopId, input.shopItemId);
  const orderNumber = newOrderNumber();
  await withSaleLock(db, input.shopId, async (tx) => {
    await refuseWhileOneIsOnItsWay(tx, input.shopId);
    await writeLiveSale(tx, input, item, orderNumber);
  });
  try {
    const order = await createCardOrder(client, {
      orderNumber,
      currency: item.currency,
      discountCents: 0,
      lines: [{ title: item.title, sku: item.sku, quantity: 1, unitPriceCents: item.price_cents }],
      requestId: randomUUID(),
      card: SANDBOX_TEST_CARD,
    });
    if (order.invoiceId !== orderNumber) throw new LiveSaleRefused();
    await confirmLiveSale(db, input.shopId, order);
  } catch (err) {
    // A lost response or failed GET after the POST may hide a completed capture. Only a clear POST refusal releases it.
    if (err instanceof PayPalApiError && err.method === "POST" && !err.uncertain && [400, 401, 403, 404, 422].includes(err.status)) {
      await releaseReservation(db, input.shopId, orderNumber);
    }
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
 * The same sale through PayPal's own approval page, where a person logs in. Reserves the line while the buyer approves;
 * an abandoned reservation stops blocking after SALE_ON_ITS_WAY_MINUTES. The return address is signed for this order.
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
  await withSaleLock(db, input.shopId, async (tx) => {
    await refuseWhileOneIsOnItsWay(tx, input.shopId);
    // No contact is stored at start. The configured demo contact is sealed with SHOP_DATA_KEY on return.
    await writeLiveSale(tx, { shopId: input.shopId, today: businessDay(), secret: input.sessionSecret }, item, orderNumber);
  });
  try {
    const { orderId, approveUrl } = await createPayPalOrder(client, {
      orderNumber,
      currency: item.currency,
      discountCents: 0,
      lines: [{ title: item.title, sku: item.sku, quantity: 1, unitPriceCents: item.price_cents }],
      requestId: randomUUID(),
      returnUrl,
      cancelUrl: `${returnUrl}&cancelled=1`,
      brandName: DEMO_LABEL,
    });
    return { orderId, approveUrl, returnUrl };
  } catch (err) {
    if (err instanceof PayPalApiError && err.method === "POST" && !err.uncertain && [400, 401, 403, 404, 422].includes(err.status)) {
      await releaseReservation(db, input.shopId, orderNumber);
    }
    throw err;
  }
}

/** The state's parts, if this server signed them for this shop. */
function readState(state: string, shopId: string, sessionId: string, sessionSecret: string): { shopItemId: string; orderNumber: string } | null {
  const [shopItemId = "", orderNumber = "", signature = ""] = state.split(".");
  if (!UUID.test(shopItemId) || !ORDER_NUMBER.test(orderNumber)) return null;
  const given = Buffer.from(signature);
  const expected = Buffer.from(stateSignature(sessionSecret, shopId, sessionId, shopItemId, orderNumber));
  return given.length === expected.length && timingSafeEqual(given, expected) ? { shopItemId, orderNumber } : null;
}

/** A signed cancellation can release only this browser's reservation, never a confirmed sale. */
export async function cancelPayPalBuy(
  db: Db,
  input: { shopId: string; sessionId: string; state: string; sessionSecret: string; orderId?: string },
  client?: PayPalClient,
): Promise<boolean> {
  const signed = readState(input.state, input.shopId, input.sessionId, input.sessionSecret);
  if (!signed) throw new LiveSaleRefused();
  if (input.orderId === undefined) return false;
  if (!client || !PAYPAL_ID.test(input.orderId)) throw new LiveSaleRefused();
  const order = await getOrder(client, input.orderId);
  if (order.invoiceId !== signed.orderNumber) throw new LiveSaleRefused();
  if (order.status === "APPROVED" || order.status === "COMPLETED") return false;
  // VOIDED is final: no capture can land after this read, whatever began before it.
  return releaseReservation(db, input.shopId, signed.orderNumber, { evenIfCaptureStarted: order.status === "VOIDED" });
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

  // Only once, including concurrent returns. Legacy returns may reserve only when the shop is free.
  await withSaleLock(db, input.shopId, async (tx) => {
    const written = await tx.query("select 1 from order_lines where shop_id = $1 and order_number = $2", [input.shopId, signed.orderNumber]);
    if (written.rows.length === 0) {
      await refuseWhileOneIsOnItsWay(tx, input.shopId);
      await writeLiveSale(tx, input, item, signed.orderNumber);
    } else if (input.demoEmail) {
      await tx.query("update order_lines set buyer_email_enc = $3 where shop_id = $1 and order_number = $2 and buyer_email_enc is null", [
        input.shopId, signed.orderNumber, createContactCipher(input.secret, input.shopId).seal(input.demoEmail),
      ]);
    }
    await tx.query("update order_lines set capture_started = true where shop_id = $1 and order_number = $2", [input.shopId, signed.orderNumber]);
  });
  // A sale doesn't wait on a webhook that may never come. The capture stands if this fails, and the webhook confirms it too.
  const confirm = async (completed: OrderFacts | null) => {
    if (!completed) return;
    await confirmLiveSale(db, input.shopId, completed).catch((err: unknown) => {
      console.error("sale confirmation failed:", err instanceof Error ? err.name : "unknown error");
    });
  };
  if (order.status === "COMPLETED") return confirm(order);
  try {
    await captureOrder(client, input.orderId, `capture-${input.orderId}`);
  } catch (err) {
    // The error alone can't say: another return may have captured it, or this try may have. PayPal's order can.
    const after = await getOrder(client, input.orderId).catch(() => null);
    if (after?.status === "COMPLETED") return confirm(after);
    // APPROVED can still complete. An unreadable order also leaves the capture's outcome unknown.
    if (after && after.status !== "APPROVED") await releaseReservation(db, input.shopId, signed.orderNumber, { evenIfCaptureStarted: true });
    throw err;
  }
  await confirm(await getOrder(client, input.orderId).catch(() => null));
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
  callsBelongTo(line.shop_id);
  const capture = order.capture;
  if (capture?.id !== input.captureId || capture.status !== "COMPLETED") return "NOT_COMPLETED";

  const lineId = await confirmLiveSale(db, line.shop_id, order);
  if (!lineId) return "NOT_A_LIVE_SALE";
  await runShopCheck(db, line.shop_id, { today: businessDay(input.now), onlyRecordId: lineId });
  // After the check is saved, so a problem here can't undo it. The owner's card still shows anything not prepared.
  await prepareStandingNotices(db, line.shop_id).catch((err: unknown) => {
    console.error("standing notices failed:", err instanceof Error ? err.name : "unknown error");
  });

  const caught = await db.query<{ id: string }>(
    "update recall_matches set caught_at = $2 where order_line_id = $1 and verdict <> 'CLEARED' and caught_at is null returning id",
    [lineId, input.now.toISOString()],
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
