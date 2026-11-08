import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { testDb } from "../../test/pglite";
import { migrate } from "../db/migrate";
import { createShop } from "../import/store";
import { readItem, searchItems } from "./sources";

describe("agent item sources while capture is pending", () => {
  let db: Awaited<ReturnType<typeof testDb>>;
  let shopId: string;
  let saleId: string;
  let listingId: string;
  beforeEach(async () => {
    db = await testDb();
    await migrate(db);
    shopId = await createShop(db, { name: "SOURCE TEST", kind: "DEMO" });
    saleId = (await db.query<{ id: string }>(
      `insert into order_lines (shop_id, order_number, line_no, title, quantity, unit_price_cents, currency, ordered_on, source, capture_pending)
       values ($1, 'PENDING', 1, 'Pending bath seat', 1, 100, 'USD', '2026-11-06', 'test', true) returning id`, [shopId],
    )).rows[0].id;
    listingId = (await db.query<{ id: string }>(
      "insert into shop_items (shop_id, title, source) values ($1, 'Listed bath seat', 'test') returning id", [shopId],
    )).rows[0].id;
  });
  afterEach(async () => { await db.close(); });

  it("does not read a pending order line, but still reads a listing and the confirmed sale", async () => {
    expect(await readItem(db, shopId, { kind: "order_line", id: saleId })).toBeNull();
    expect(await readItem(db, shopId, { kind: "shop_item", id: listingId })).toMatchObject({ title: "Listed bath seat" });
    await db.query("update order_lines set capture_pending = false where id = $1", [saleId]);
    expect(await readItem(db, shopId, { kind: "order_line", id: saleId })).toMatchObject({ title: "Pending bath seat" });
  });

  it("omits pending order lines from search without hiding listings or confirmed sales", async () => {
    const pending = await searchItems(db, shopId, "bath seat");
    expect(pending.map((r) => r.record.id)).toEqual([listingId]);
    await db.query("update order_lines set capture_pending = false where id = $1", [saleId]);
    expect((await searchItems(db, shopId, "bath seat")).map((r) => r.record.id).sort()).toEqual([saleId, listingId].sort());
  });
});
