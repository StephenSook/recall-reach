import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { testDb } from "../../test/pglite";
import { migrate } from "../db/migrate";
import { createContactCipher } from "../privacy/contactCipher";
import type { ImportedOrderLine } from "./shopExport";
import { createShop, storeOrderLines } from "./store";

const SECRET = "k".repeat(32);
const LINE: ImportedOrderLine = {
  orderNumber: "#T1",
  lineNo: 1,
  title: "TEST DATA stroller",
  sku: "TEST-SKU",
  quantity: 1,
  unitPriceCents: 3000,
  discountCents: 100,
  currency: "USD",
  orderedOn: "2026-03-14",
  paymentReference: "pyid-1",
  buyerEmail: "test-buyer@example.test",
};

describe("storeOrderLines", () => {
  let db: Awaited<ReturnType<typeof testDb>>;
  beforeEach(async () => {
    db = await testDb();
    await migrate(db);
  });
  afterEach(async () => {
    await db.close();
  });

  const rows = (shopId: string) =>
    db.query<Record<string, unknown>>("select * from order_lines where shop_id = $1 order by order_number, line_no", [shopId]);

  it("stores lines with the email encrypted, and opens only with that shop's cipher", async () => {
    const shopId = await createShop(db, { name: "DEMO SHOP", kind: "DEMO" });
    const cipher = createContactCipher(SECRET, shopId);
    expect(await storeOrderLines(db, shopId, [LINE], cipher, "test export")).toEqual({ inserted: 1, updated: 0 });
    const [row] = (await rows(shopId)).rows;
    expect(row).toMatchObject({ order_number: "#T1", line_no: 1, title: "TEST DATA stroller", ordered_on: "2026-03-14", unit_price_cents: 3000, source: "test export" });
    expect(JSON.stringify(row)).not.toMatch(/[\w.+-]+@[\w-]+\.[\w.]+/);
    expect(cipher.open(String(row.buyer_email_enc))).toBe(LINE.buyerEmail);
  });

  it("stores no contact value when the file has no email", async () => {
    const shopId = await createShop(db, { name: "DEMO SHOP", kind: "DEMO" });
    await storeOrderLines(db, shopId, [{ ...LINE, buyerEmail: null }], createContactCipher(SECRET, shopId), "test export");
    expect((await rows(shopId)).rows[0].buyer_email_enc).toBeNull();
  });

  it("re-importing the same order updates in place", async () => {
    const shopId = await createShop(db, { name: "DEMO SHOP", kind: "DEMO" });
    const cipher = createContactCipher(SECRET, shopId);
    await storeOrderLines(db, shopId, [LINE], cipher, "test export");
    expect(await storeOrderLines(db, shopId, [{ ...LINE, title: "TEST DATA stroller v2" }], cipher, "test export")).toEqual({ inserted: 0, updated: 1 });
    const stored = (await rows(shopId)).rows;
    expect(stored).toHaveLength(1);
    expect(stored[0].title).toBe("TEST DATA stroller v2");
  });

  it("keeps two shops' orders apart, and deleting a shop deletes its lines", async () => {
    const a = await createShop(db, { name: "A", kind: "DEMO" });
    const b = await createShop(db, { name: "B", kind: "DEMO" });
    await storeOrderLines(db, a, [LINE], createContactCipher(SECRET, a), "x");
    await storeOrderLines(db, b, [LINE], createContactCipher(SECRET, b), "x");
    await db.query("delete from shops where id = $1", [a]);
    expect((await rows(a)).rows).toEqual([]);
    expect((await rows(b)).rows).toHaveLength(1);
  });
});
