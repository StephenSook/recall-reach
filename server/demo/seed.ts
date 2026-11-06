// The DEMO SHOP: labelled shop data, real CPSC recalls, real sandbox captures.
//
// What is real and what is not, and the app says so on screen:
// - Recalls are real and read from the database here, never retyped (research/DEMO-CASES.md).
// - Captures are real sandbox card payments, dated when created, so always today.
// - The shop, its listings and prices are demo data. Order dates marked "seeded" are chosen to fall
//   before the recall. The REFUND ELIGIBLE case is not seeded: its capture really is after the recall.
import { randomBytes, randomUUID } from "node:crypto";
import type { Db } from "../db/types";
import type { ImportedOrderLine } from "../import/shopExport";
import { createShop, storeOrderLines } from "../import/store";
import { runShopCheck, type RunSummary } from "../match/run";
import type { PayPalClient } from "../paypal/client";
import { createCardOrder } from "../paypal/orders";
import { createContactCipher } from "../privacy/contactCipher";

export const DEMO_LABEL = "DEMO SHOP";

// PayPal's sandbox accepts this test number (measured 2026-11-05). It is not a real card.
export const SANDBOX_TEST_CARD = { number: "4111111111111111", expiry: "2030-12", securityCode: "123" };

interface DemoCase {
  recallNumber: string;
  title: string;
  sku: string;
  priceCents: number;
  /** Days before the recall to date the order. Null means the order really is today. */
  seededDaysBeforeRecall: number | null;
  /** Shown beside every recall this line comes near, so it says only what is true of the line itself. */
  label: string;
}

const CASES: DemoCase[] = [
  {
    recallNumber: "27072",
    title: "Baby Brezza SuperFast Sterilizer Dryer BRZ0083",
    sku: "DEMO-BREZZA",
    priceCents: 9500,
    seededDaysBeforeRecall: 51,
    label: "order date seeded",
  },
  {
    recallNumber: "27027",
    title: "Papablic bedside sleeper, gray stars and moon",
    sku: "DEMO-PAPABLIC",
    priceCents: 9000,
    seededDaysBeforeRecall: null,
    label: "sold today, with a sandbox capture made today",
  },
  {
    recallNumber: "27040",
    title: "Costway high chair",
    sku: "DEMO-COSTWAY",
    priceCents: 4000,
    seededDaysBeforeRecall: 30,
    label: "order date seeded",
  },
];

/** Still on the shelf, on a real recall: what a family can buy for the live catch. Recall 27018 lists model MY002. */
const SHELF_ITEM = { title: "ONTHEWEI baby bath seat MY002", sku: "DEMO-ONTHEWEI", priceCents: 2800, currency: "USD", recallNumber: "27018" };

const daysBefore = (day: string, days: number) => new Date(Date.parse(`${day}T00:00:00Z`) - days * 86_400_000).toISOString().slice(0, 10);

/** Creates a fresh demo shop for one session, then runs the real check against it. */
export async function seedDemoShop(
  db: Db,
  client: PayPalClient,
  opts: { today: string; secret: string; demoEmail?: string },
): Promise<{ shopId: string; run: RunSummary }> {
  const { rows: recalls } = await db.query<{ recall_number: string; recall_date: string }>(
    "select recall_number, recall_date from recalls where recall_number = any($1::text[])",
    [[...CASES.map((c) => c.recallNumber), SHELF_ITEM.recallNumber]],
  );
  const recallDate = new Map(recalls.map((r) => [r.recall_number, r.recall_date]));
  for (const c of [...CASES, SHELF_ITEM]) {
    if (!recallDate.has(c.recallNumber)) throw new Error(`demo recall ${c.recallNumber} is not loaded; run pnpm load:recalls`);
  }

  // PayPal refuses a repeated invoice id, so every shop's order numbers are its own.
  const batch = randomBytes(4).toString("hex");
  const lines: (ImportedOrderLine & { demoCase: DemoCase })[] = CASES.map((demoCase, i) => ({
    demoCase,
    orderNumber: `DEMO-${batch}-${i + 1}`,
    lineNo: 1,
    title: demoCase.title,
    sku: demoCase.sku,
    quantity: 1,
    unitPriceCents: demoCase.priceCents,
    discountCents: 0,
    currency: "USD",
    orderedOn:
      demoCase.seededDaysBeforeRecall === null
        ? opts.today
        : daysBefore(recallDate.get(demoCase.recallNumber)!, demoCase.seededDaysBeforeRecall),
    paymentReference: null,
    buyerEmail: opts.demoEmail ?? null,
  }));

  const orders = await Promise.all(
    lines.map((l) =>
      createCardOrder(client, {
        orderNumber: l.orderNumber,
        currency: l.currency,
        discountCents: 0,
        lines: [{ title: l.title, sku: l.sku, quantity: 1, unitPriceCents: l.unitPriceCents }],
        requestId: randomUUID(),
        card: SANDBOX_TEST_CARD,
      }),
    ),
  );

  const shopId = await createShop(db, { name: DEMO_LABEL, kind: "DEMO" });
  const cipher = createContactCipher(opts.secret, shopId);
  for (const l of lines) {
    const { demoCase, ...line } = l;
    await storeOrderLines(db, shopId, [line], cipher, `${DEMO_LABEL}: ${demoCase.label}`);
  }
  for (const o of orders) {
    await db.query(
      `insert into paypal_payments (shop_id, order_id, order_number, capture_id, capture_status, captured_at, amount_cents, currency, items)
       values ($1, $2, $3, $4, $5, $6::timestamptz, $7, $8, $9::jsonb)`,
      [
        shopId,
        o.orderId,
        o.invoiceId,
        o.capture?.id ?? null,
        o.capture?.status ?? null,
        o.capture?.createTime ?? null,
        o.capture?.amountCents ?? null,
        o.capture?.currency ?? null,
        JSON.stringify(o.items.map((i) => ({ name: i.name, sku: i.sku }))),
      ],
    );
  }
  await db.query(
    "insert into shop_items (shop_id, sku, title, price_cents, currency, listed, source) values ($1, $2, $3, $4, $5, true, $6)",
    [shopId, SHELF_ITEM.sku, SHELF_ITEM.title, SHELF_ITEM.priceCents, SHELF_ITEM.currency, `${DEMO_LABEL}: listed, still on the shelf`],
  );
  // PayPal's history has not been searched here: these payments are only the ones this seed just made.
  const run = await runShopCheck(db, shopId, { today: opts.today });
  return { shopId, run };
}
