import { readFileSync } from "node:fs";
import type { Queryable } from "../server/db/types";
import { pullRecalls } from "../server/cpsc/pull";
import type { Db } from "../server/db/types";
import { createShop, storeOrderLines } from "../server/import/store";
import { createContactCipher } from "../server/privacy/contactCipher";

// One existing CPSC fixture. These are test records, not evidence of shop use or payments.
export const storedRecall = JSON.parse(readFileSync(new URL("./fixtures/cpsc/recall_22200.json", import.meta.url), "utf8"))[0];

export async function doorLedgerShop(db: Db): Promise<string> {
  await pullRecalls(db, { field: "RecallDate", start: "2022-08-01", end: "2022-08-31" }, {
    fetchImpl: (async () => new Response(JSON.stringify([storedRecall]), { headers: { "content-type": "application/json" } })) as typeof fetch,
  });
  return createShop(db, { name: "Test shop", kind: "REAL" });
}

export async function doorLedgerSale(db: Queryable, shopId: string, input: { date?: string; email?: string; order?: string; title?: string; verdict?: string; strength?: string } = {}) {
  const order = input.order ?? "PRIVATE-ORDER";
  await storeOrderLines(db, shopId, [{
    orderNumber: order, lineNo: 1, title: input.title ?? "Shop's name for this swing", sku: "PRIVATE-SKU", quantity: 1,
    unitPriceCents: 12345, discountCents: 0, currency: "USD", orderedOn: input.date ?? "2022-07-01",
    paymentReference: "PRIVATE-PAYMENT", buyerEmail: input.email ?? null,
  }], createContactCipher("test-secret-".repeat(4), shopId), "Test file");
  const { rows: lines } = await db.query<{ id: string }>("select id from order_lines where shop_id = $1 and order_number = $2", [shopId, order]);
  const { rows: matches } = await db.query<{ id: string }>(
    `insert into recall_matches (shop_id, recall_id, recall_sha256, order_line_id, verdict, strength, matched, missing, reason)
     select $1, recall_id, raw_sha256, $2, $3, $4, '[]', '[]', 'Test match'
     from recalls where recall_number = $5 returning id`,
    [shopId, lines[0].id, input.verdict ?? "MATCH", input.strength ?? "CONFIRMED", storedRecall.RecallNumber],
  );
  return { lineId: lines[0].id, matchId: matches[0].id };
}
