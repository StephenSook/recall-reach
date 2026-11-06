import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { testDb } from "../../test/pglite";
import { pullRecalls } from "../cpsc/pull";
import { migrate } from "../db/migrate";
import { NoticeRefused, prepareNotice } from "../notice/store";
import type { PayPalClient } from "../paypal/client";
import { approveRefund, RefundRefused } from "../paypal/refunds";
import { loadQueue, toCards } from "../queue/queue";
import { deleteOwnShop, purgeOldOwnShops } from "./ownFile";
import { StoreFeedRefused, type StoreFeedDeps } from "./storeFeed";
import { importStoreListings } from "./storeListings";

const fixtureText = readFileSync(new URL("../../test/fixtures/cpsc/recalls_2026-10-01_to_2026-11-05.json", import.meta.url), "utf8");
const TODAY = "2026-11-06";
const paypalMustNotBeCalled: PayPalClient = {
  request: (async () => {
    throw new Error("a store's listings connect no PayPal account");
  }) as PayPalClient["request"],
};

const LISTINGS = [
  { title: "Baby Brezza SuperFast Sterilizer Dryer BRZ0083", listed: true },
  { title: "Baby Brezza SuperFast Sterilizer Dryer BRZ0083 used", listed: false },
  { title: "Costway high chair", listed: true },
  { title: "Picture book lot", listed: true },
];

/** A real feed as far as the reader can tell, so the vendor sentinel has to be dropped by the real code, not by this test. */
const feedDeps = (products: unknown[]): StoreFeedDeps => ({
  resolve: async () => ["23.227.38.65"],
  get: async ({ path }) => (path === "/robots.txt" ? { status: 404, location: null, body: "" } : { status: 200, location: null, body: JSON.stringify({ products }) }),
  sleep: async () => {},
});
const FEED_PRODUCTS = LISTINGS.map((l) => ({ title: l.title, vendor: "CONSIGNOR-SENTINEL", handle: "HANDLE-SENTINEL", body_html: "BODY-SENTINEL", variants: [{ available: l.listed, price: "PRICE-SENTINEL", sku: "SKU-SENTINEL" }] }));

describe("a store checked by its public listings", () => {
  let db: Awaited<ReturnType<typeof testDb>>;
  beforeEach(async () => {
    db = await testDb();
    await migrate(db);
    const fetchImpl = async () => new Response(fixtureText, { status: 200, headers: { "content-type": "application/json" } });
    await pullRecalls(db, { field: "RecallDate", start: "2026-10-01", end: "2026-11-05" }, { fetchImpl: fetchImpl as typeof fetch });
  });
  afterEach(async () => {
    await db.close();
  });

  const load = (products: unknown[] = FEED_PRODUCTS) => importStoreListings(db, { typed: "mystore.com", today: TODAY, deps: feedDeps(products) });

  it("makes a real shop under the store's name and runs the same matcher on its titles", async () => {
    const { shopId, listings, complete } = await load();
    expect({ listings, complete }).toEqual({ listings: 4, complete: true });
    const q = await loadQueue(db, shopId, "s");
    expect(q.shop).toEqual({ name: "mystore.com", kind: "REAL" });
    expect(q.listings).toEqual({ total: 4, forSale: 3 });
    const brezza = q.rows.find((r) => r.recallNumber === "27072" && r.stillListed);
    expect(brezza).toMatchObject({ isListing: true, itemTitle: "Baby Brezza SuperFast Sterilizer Dryer BRZ0083", verdict: "MATCH", orderedOn: null, salePath: null, joinState: null });
    expect(q.rows.find((r) => r.recallNumber === "27040")).toMatchObject({ verdict: "SCOPE_GAP", isListing: true });
  });

  it("keeps a sold-out listing on the record, marked as not for sale", async () => {
    const { shopId } = await load();
    const row = (await loadQueue(db, shopId, "s")).rows.find((r) => r.itemTitle.endsWith("used"));
    expect(row).toMatchObject({ isListing: true, stillListed: false });
  });

  it("stores a title and whether it's for sale, and nothing else from the feed, in any table", async () => {
    const { shopId } = await load();
    const { rows } = await db.query<Record<string, unknown>>("select sku, description, price_cents, currency, title, listed from shop_items where shop_id = $1 order by title", [shopId]);
    for (const r of rows) expect(r).toMatchObject({ sku: null, description: "", price_cents: null, currency: null });
    expect(rows.map((r) => r.title)).toContain("Picture book lot");

    const { rows: columns } = await db.query<{ table_name: string; column_name: string }>(
      "select table_name, column_name from information_schema.columns where table_schema = 'public' and data_type in ('text', 'jsonb', 'json', 'character varying')",
    );
    expect(columns.length).toBeGreaterThan(20);
    for (const { table_name, column_name } of columns) {
      const { rows: hits } = await db.query(`select 1 from "${table_name}" where "${column_name}"::text like '%SENTINEL%' limit 1`);
      expect(hits, `${table_name}.${column_name}`).toEqual([]);
    }
  });

  it("can't send anything or refund anything: there's no buyer and no PayPal account", async () => {
    const { shopId } = await load();
    const q = await loadQueue(db, shopId, "s");
    expect(q.coverage).toMatchObject({ paypalSearched: false, searchWindows: 0 });
    const row = q.rows.find((r) => r.recallNumber === "27072");
    await expect(approveRefund(db, paypalMustNotBeCalled, { shopId, sessionId: "s", matchId: row?.matchId ?? "" })).rejects.toBeInstanceOf(RefundRefused);
    await expect(prepareNotice(db, { shopId, matchId: row?.matchId ?? "" })).rejects.toBeInstanceOf(NoticeRefused);
    expect((await db.query("select 1 from notices")).rows).toEqual([]);
  });

  it("deletes everything when asked, and after seven days by itself", async () => {
    const asked = await load();
    expect(await deleteOwnShop(db, asked.shopId)).toBe(true);
    expect((await db.query("select 1 from shop_items where shop_id = $1", [asked.shopId])).rows).toEqual([]);
    expect((await db.query("select 1 from recall_matches where shop_id = $1", [asked.shopId])).rows).toEqual([]);

    const old = await load();
    const NOW = new Date("2026-11-20T12:00:00Z");
    await db.query("update shops set created_at = $2::timestamptz where id = $1", [old.shopId, "2026-11-12T11:00:00Z"]);
    expect(await purgeOldOwnShops(db, NOW)).toBe(1);
    expect((await db.query("select 1 from shop_items where shop_id = $1", [old.shopId])).rows).toEqual([]);
  });

  it("leaves nothing behind when the store can't be read", async () => {
    const deps: StoreFeedDeps = { ...feedDeps([]), resolve: async () => ["127.0.0.1"] };
    await expect(importStoreListings(db, { typed: "mystore.com", today: TODAY, deps })).rejects.toBeInstanceOf(StoreFeedRefused);
    expect((await db.query("select 1 from shops")).rows).toEqual([]);
  });

  it("leaves nothing behind when the check itself fails", async () => {
    const breaking = new Proxy(db, {
      get(target, key, receiver) {
        if (key === "transaction") {
          return async () => {
            throw new Error("check failed");
          };
        }
        return Reflect.get(target, key, receiver);
      },
    });
    await expect(importStoreListings(breaking, { typed: "mystore.com", today: TODAY, deps: feedDeps(FEED_PRODUCTS) })).rejects.toThrow("check failed");
    expect((await db.query("select 1 from shops")).rows).toEqual([]);
  });

  it("says when it stopped early", async () => {
    const many = Array.from({ length: 1000 }, (_, i) => ({ title: `Plain item ${i}` }));
    const { complete, listings, shopId } = await load(many);
    expect({ complete, listings }).toEqual({ complete: false, listings: 1000 });
    expect((await loadQueue(db, shopId, "s")).listings?.total).toBe(1000);
  });

  it("gives a file's shop and a demo shop no listing view", async () => {
    const { rows } = await db.query<{ id: string }>("insert into shops (name, kind) values ('File shop', 'REAL') returning id");
    expect((await loadQueue(db, rows[0].id, "s")).listings).toBeNull();
    const demo = await db.query<{ id: string }>("insert into shops (name, kind) values ('DEMO', 'DEMO') returning id");
    await db.query("insert into shop_items (shop_id, title, source) values ($1, 'Shelf', 'seed')", [demo.rows[0].id]);
    expect((await loadQueue(db, demo.rows[0].id, "s")).listings).toBeNull();
  });

  it("cards lead with the strongest evidence, so a shared word never sits above a brand or model", async () => {
    const { shopId } = await load();
    const { cards } = toCards((await loadQueue(db, shopId, "s")).rows);
    const order = { CONFIRMED: 0, BRAND: 1, PRODUCT_WORDS: 2, NO_SHARED_WORDS: 3 };
    const ranks = cards.map((c) => order[c.lead.strength]);
    expect(ranks).toEqual([...ranks].sort((a, b) => a - b));
  });
});
