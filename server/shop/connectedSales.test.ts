import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { answerSearch } from "../../test/fakeHistory";
import { testDb } from "../../test/pglite";
import { migrate } from "../db/migrate";
import { HISTORY_POOL } from "../demo/historyPool";
import { createShop, storeOrderLines } from "../import/store";
import { joinShop } from "../match/run";
import type { Method, PayPalClient } from "../paypal/client";
import { createContactCipher } from "../privacy/contactCipher";
import { readConnectedShopSales } from "./connectedSales";

const NOW = new Date("2026-11-08T03:00:00.000Z");
const SECRET = "s".repeat(64);
const sold = HISTORY_POOL.find((p) => p.orderNumber && p.lines.length > 0)!;
const searching = (fail = false): PayPalClient => ({
  request: (async (method: Method, path: string) => {
    const found = answerSearch(path, fail);
    if (found) return found;
    throw new Error(`unexpected ${method} ${path}`);
  }) as PayPalClient["request"],
});

describe("a connected shop's own sales, read from its own PayPal account", () => {
  let db: Awaited<ReturnType<typeof testDb>>;
  let shopId: string;
  beforeEach(async () => {
    db = await testDb();
    await migrate(db);
    shopId = await createShop(db, { name: "A SHOP", kind: "REAL" });
    const line = sold.lines[0];
    await storeOrderLines(
      db,
      shopId,
      [{ orderNumber: sold.orderNumber!, lineNo: 1, title: line.title, sku: line.sku, quantity: 1, unitPriceCents: line.unitPriceCents, discountCents: 0, currency: "USD", orderedOn: "2026-11-05", paymentReference: null } as never],
      createContactCipher(SECRET, shopId),
      "a test order file we made for the sandbox shop",
    );
  });
  afterEach(async () => {
    await db.close();
  });

  it("joins the shop's file to its PayPal payments by order number, and says PayPal was searched", async () => {
    const read = await readConnectedShopSales(db, searching(), { shopId, now: NOW });
    expect(read.complete).toBe(true);
    expect(read.payments).toBeGreaterThan(0);
    const { joined } = await joinShop(db, shopId, { today: "2026-11-08" });
    expect(Object.values(joined.lines).map((l) => l.state)).toContain("IDENTIFIED");
    const { rows } = await db.query<{ paypal_searched: boolean }>("select paypal_searched from shop_runs where shop_id = $1 order by finished_at desc limit 1", [shopId]);
    expect(rows[0].paypal_searched).toBe(true);
  });

  it("says when PayPal couldn't be searched, and claims no search", async () => {
    const read = await readConnectedShopSales(db, searching(true), { shopId, now: NOW });
    expect(read.complete).toBe(false);
    const { rows } = await db.query<{ paypal_searched: boolean }>("select paypal_searched from shop_runs where shop_id = $1 order by finished_at desc limit 1", [shopId]);
    expect(rows[0].paypal_searched).toBe(false);
  });

  it("saves and joins nothing from a read that stopped partway, so an unread page can't hide a second payment", async () => {
    // Page 1 of the first window answers with the shop's own sale; page 2 never comes (the deadline, or PayPal failing).
    const partial: PayPalClient = {
      request: (async (_m: Method, path: string, opts?: { query?: Record<string, unknown> }) => {
        if (path === "/v1/customer/disputes") return { status: 200, data: { items: [] } };
        const page = Number(opts?.query?.page ?? 1);
        if (page > 1) throw new Error("too late to send this request");
        const full = answerSearch(path)!;
        return { status: 200, data: { ...(full.data as object), total_pages: 2 } };
      }) as PayPalClient["request"],
    };
    const read = await readConnectedShopSales(db, partial, { shopId, now: NOW });
    expect(read.complete).toBe(false);
    expect((await db.query("select 1 from paypal_payments where shop_id = $1", [shopId])).rows).toHaveLength(0);
    const { joined } = await joinShop(db, shopId, { today: "2026-11-08" });
    expect(Object.values(joined.lines).map((l) => l.state)).not.toContain("IDENTIFIED");
  });
});
