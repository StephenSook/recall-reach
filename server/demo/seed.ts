// The DEMO SHOP: labelled shop data, real CPSC recalls, real sandbox payments.
//
// What is real and what is not, and the app says so on screen:
// - Recalls are real and read from the database here, never retyped (research/DEMO-CASES.md).
// - Past payments are real sandbox captures made once, read back through PayPal's Transaction Search on every
//   run (historyPool.ts). A sale made a moment ago can't be found there yet, and nothing refunds these.
// - The refundable sales are real captures made just now, because each refund uses one up.
// - The shop, its listings and prices are demo data. Order dates marked "seeded" are chosen to fall before the
//   recall. The refundable sales are not seeded: their captures really are after the recall.
import { randomBytes, randomUUID } from "node:crypto";
import type { Db } from "../db/types";
import type { ImportedOrderLine } from "../import/shopExport";
import { createShop, storeOrderLines } from "../import/store";
import { runShopCheck, type RunSummary } from "../match/run";
import type { PayPalClient } from "../paypal/client";
import { createCardOrder } from "../paypal/orders";
import { failedMonths, searchTransactions } from "../paypal/transactions";
import { createContactCipher } from "../privacy/contactCipher";
import { poolPayments } from "./historyPool";

export const DEMO_LABEL = "DEMO SHOP";

// PayPal's sandbox accepts this test number (measured 2026-11-05). It is not a real card.
export const SANDBOX_TEST_CARD = { number: "4111111111111111", expiry: "2030-12", securityCode: "123" };

/** Far enough back to hold the standing pool, and two or three 31-day windows of PayPal's search. */
const LOOK_BACK_DAYS = 62;
const SEEDED = "order date seeded";

interface DemoLine {
  title: string;
  sku: string;
  priceCents: number;
  discountCents?: number;
}

interface DemoCase {
  recallNumber: string;
  /** The golden path needs this recall. The others just don't reach the queue if it isn't loaded. */
  required?: boolean;
  lines: DemoLine[];
  /** The standing payment's own order number. Without one, a line can only link by its SKU. */
  poolOrderNumber?: string;
  /** A real capture is made now, for a sale that can be refunded. */
  freshCapture?: boolean;
  /** Days before the recall to date the order. Absent means the order really is today. */
  seededDaysBeforeRecall?: number;
  /** Dated beside the standing payment with this SKU, because a SKU only links a payment within a week of the order. */
  seededNearPaymentSku?: string;
  /** Shown beside every recall this line comes near, so it says only what is true of the line itself. */
  label: string;
  orderDiscountCents?: number;
}

const CASES: DemoCase[] = [
  // NOTICE ONLY: a confirmed match sold before the recall.
  { recallNumber: "27072", required: true, poolOrderNumber: "DEMO-HIST-BREZZA", seededDaysBeforeRecall: 51, label: SEEDED, lines: [{ title: "Baby Brezza SuperFast Sterilizer Dryer BRZ0083", sku: "DEMO-BREZZA", priceCents: 9500 }] },
  // REFUND ELIGIBLE: really sold after the recall.
  { recallNumber: "27027", required: true, freshCapture: true, label: "sold today, with a sandbox capture made today", lines: [{ title: "Papablic bedside sleeper, gray stars and moon", sku: "DEMO-PAPABLIC", priceCents: 9000 }] },
  // MIXED BASKET: the refund is the sleeper's share of the order, not the whole payment.
  {
    recallNumber: "27027",
    required: true,
    freshCapture: true,
    label: "one order with a clothing lot and a discount, sold today",
    orderDiscountCents: 1000,
    lines: [
      { title: "Papablic bedside sleeper, gray stars and moon, like new", sku: "DEMO-PAPABLIC-2", priceCents: 9000, discountCents: 750 },
      { title: "Boys clothing lot, size 4", sku: "DEMO-LOT", priceCents: 3000, discountCents: 250 },
    ],
  },
  // SCOPE GAP: the shop's words can't show whether this unit is covered.
  { recallNumber: "27040", required: true, poolOrderNumber: "DEMO-HIST-COSTWAY", seededDaysBeforeRecall: 30, label: SEEDED, lines: [{ title: "Costway high chair", sku: "DEMO-COSTWAY", priceCents: 4000 }] },
  // CAN'T TELL: CPSC's list is only on its own site, so no answer can settle it.
  { recallNumber: "26724", poolOrderNumber: "DEMO-HIST-LITTLELOVES", seededDaysBeforeRecall: 40, label: SEEDED, lines: [{ title: "Little Loves & Co. boys short set", sku: "DEMO-LITTLELOVES", priceCents: 1800 }] },
  // NEAR MISS: the same brand as a recall, and another product, so it clears with its reason.
  { recallNumber: "27072", poolOrderNumber: "DEMO-HIST-BREZZA-FORMULA", seededDaysBeforeRecall: 20, label: SEEDED, lines: [{ title: "Baby Brezza Formula Pro Advanced", sku: "DEMO-BREZZA-FORMULA", priceCents: 12000 }] },
  // AMBIGUOUS JOIN: two lines reuse one SKU and one payment could belong to either, so nothing goes out on either.
  { recallNumber: "26688", seededNearPaymentSku: "DEMO-TALECO", label: SEEDED, lines: [{ title: "G Taleco Gear Baby Jumper", sku: "DEMO-TALECO", priceCents: 3500 }] },
  { recallNumber: "26688", seededNearPaymentSku: "DEMO-TALECO", label: SEEDED, lines: [{ title: "G Taleco Gear Baby Jumper", sku: "DEMO-TALECO", priceCents: 3500 }] },
  // A real listing with a strong real-world scope gap. It reaches the queue once recall 22200 (2022) is loaded.
  { recallNumber: "22200", poolOrderNumber: "DEMO-HIST-MAMAROO", seededDaysBeforeRecall: 90, label: SEEDED, lines: [{ title: "4moms MamaRoo Multi-Motion Swing", sku: "DEMO-MAMAROO", priceCents: 8500 }] },
];
// CANNOT IDENTIFY has no line on purpose: the pool's $42 payment says only an amount, and is counted as unidentified.

/** Still on the shelf, on a real recall: what a family can buy for the live catch. Recall 27018 lists model MY002. */
const SHELF_ITEM = { title: "ONTHEWEI baby bath seat MY002", sku: "DEMO-ONTHEWEI", priceCents: 2800, currency: "USD", recallNumber: "27018", required: true };

const daysBefore = (day: string, days: number) => new Date(Date.parse(`${day}T00:00:00Z`) - days * 86_400_000).toISOString().slice(0, 10);

/** Creates a fresh demo shop for one session, reads PayPal's history, then runs the real check against it. */
export async function seedDemoShop(
  db: Db,
  client: PayPalClient,
  opts: { today: string; secret: string; demoEmail?: string; now?: Date },
): Promise<{ shopId: string; run: RunSummary }> {
  const now = opts.now ?? new Date();
  const { rows: recalls } = await db.query<{ recall_number: string; recall_date: string }>(
    "select recall_number, recall_date from recalls where recall_number = any($1::text[])",
    [[...CASES.map((c) => c.recallNumber), SHELF_ITEM.recallNumber]],
  );
  const recallDate = new Map(recalls.map((r) => [r.recall_number, r.recall_date]));
  for (const c of [...CASES, SHELF_ITEM]) {
    if (c.required && !recallDate.has(c.recallNumber)) throw new Error(`demo recall ${c.recallNumber} is not loaded; run pnpm load:recalls`);
  }

  const { payments, coverage } = await searchTransactions(client, { from: new Date(now.getTime() - LOOK_BACK_DAYS * 86_400_000), to: now });
  const pool = poolPayments(payments);
  const dayOf = (sku: string) => pool.find((p) => p.items.some((i) => i.sku === sku))?.paidAt?.slice(0, 10) ?? opts.today;

  // PayPal refuses a repeated invoice id, so a new sale gets a number of its own.
  const batch = randomBytes(4).toString("hex");
  const orders = CASES.map((demoCase, i) => {
    const orderNumber = demoCase.poolOrderNumber ?? `DEMO-${batch}-${i + 1}`;
    const orderedOn = demoCase.seededNearPaymentSku
      ? dayOf(demoCase.seededNearPaymentSku)
      : demoCase.seededDaysBeforeRecall === undefined
        ? opts.today
        : daysBefore(recallDate.get(demoCase.recallNumber) ?? opts.today, demoCase.seededDaysBeforeRecall);
    const lines: ImportedOrderLine[] = demoCase.lines.map((l, n) => ({
      orderNumber,
      lineNo: n + 1,
      title: l.title,
      sku: l.sku,
      quantity: 1,
      unitPriceCents: l.priceCents,
      discountCents: l.discountCents ?? 0,
      currency: "USD",
      orderedOn,
      paymentReference: null,
      buyerEmail: opts.demoEmail ?? null,
    }));
    return { demoCase, orderNumber, lines };
  });

  const fresh = await Promise.all(
    orders
      .filter((o) => o.demoCase.freshCapture)
      .map((o) =>
        createCardOrder(client, {
          orderNumber: o.orderNumber,
          currency: "USD",
          discountCents: o.demoCase.orderDiscountCents ?? 0,
          lines: o.demoCase.lines.map((l) => ({ title: l.title, sku: l.sku, quantity: 1, unitPriceCents: l.priceCents })),
          requestId: randomUUID(),
          card: SANDBOX_TEST_CARD,
        }),
      ),
  );

  const shopId = await createShop(db, { name: DEMO_LABEL, kind: "DEMO" });
  const cipher = createContactCipher(opts.secret, shopId);
  for (const o of orders) await storeOrderLines(db, shopId, o.lines, cipher, `${DEMO_LABEL}: ${o.demoCase.label}`);

  const insertPayment = `insert into paypal_payments (shop_id, order_id, order_number, capture_id, capture_status, captured_at, amount_cents, currency, items)
     values ($1, $2, $3, $4, $5, $6::timestamptz, $7, $8, $9::jsonb)`;
  for (const o of fresh) {
    await db.query(insertPayment, [
      shopId,
      o.orderId,
      o.invoiceId,
      o.capture?.id ?? null,
      o.capture?.status ?? null,
      o.capture?.createTime ?? null,
      o.capture?.amountCents ?? null,
      o.capture?.currency ?? null,
      JSON.stringify(o.items.map((i) => ({ name: i.name, sku: i.sku }))),
    ]);
  }
  // A search row has no order id. Its transaction id is the capture's, and it is what makes the row unique here.
  for (const p of pool) {
    await db.query(insertPayment, [shopId, p.transactionId, p.invoiceId, p.transactionId, p.status, p.paidAt, p.amountCents, p.currency, JSON.stringify(p.items)]);
  }
  await db.query(
    "insert into shop_items (shop_id, sku, title, price_cents, currency, listed, source) values ($1, $2, $3, $4, $5, true, $6)",
    [shopId, SHELF_ITEM.sku, SHELF_ITEM.title, SHELF_ITEM.priceCents, SHELF_ITEM.currency, `${DEMO_LABEL}: listed, still on the shelf`],
  );
  const run = await runShopCheck(db, shopId, {
    today: opts.today,
    paypalSearched: coverage.complete,
    failedMonths: failedMonths(coverage.failedWindows),
    search: coverage,
  });
  return { shopId, run };
}
