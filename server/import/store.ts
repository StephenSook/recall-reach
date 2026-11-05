import type { Queryable } from "../db/types";
import type { ContactCipher } from "../privacy/contactCipher";
import type { ImportedOrderLine } from "./shopExport";

export async function createShop(db: Queryable, shop: { name: string; kind: "DEMO" | "REAL" }): Promise<string> {
  const { rows } = await db.query<{ id: string }>("insert into shops (name, kind) values ($1, $2) returning id", [
    shop.name,
    shop.kind,
  ]);
  return rows[0].id;
}

/** Saves a shop's order lines. Re-importing an order updates it in place. Emails are sealed first. */
export async function storeOrderLines(
  db: Queryable,
  shopId: string,
  lines: ImportedOrderLine[],
  cipher: ContactCipher,
  source: string,
): Promise<{ inserted: number; updated: number }> {
  let inserted = 0;
  let updated = 0;
  for (const l of lines) {
    const { rows } = await db.query<{ inserted: boolean }>(
      `insert into order_lines (shop_id, order_number, line_no, title, sku, quantity, unit_price_cents,
         discount_cents, currency, ordered_on, payment_reference, buyer_email_enc, source)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::date, $11, $12, $13)
       on conflict (shop_id, order_number, line_no) do update set
         title = excluded.title, sku = excluded.sku, quantity = excluded.quantity,
         unit_price_cents = excluded.unit_price_cents, discount_cents = excluded.discount_cents,
         currency = excluded.currency, ordered_on = excluded.ordered_on,
         payment_reference = excluded.payment_reference, buyer_email_enc = excluded.buyer_email_enc,
         source = excluded.source, imported_at = now()
       returning (xmax = 0) as inserted`,
      [
        shopId,
        l.orderNumber,
        l.lineNo,
        l.title,
        l.sku,
        l.quantity,
        l.unitPriceCents,
        l.discountCents,
        l.currency,
        l.orderedOn,
        l.paymentReference,
        l.buyerEmail ? cipher.seal(l.buyerEmail) : null,
        source,
      ],
    );
    if (rows[0].inserted) inserted++;
    else updated++;
  }
  return { inserted, updated };
}
