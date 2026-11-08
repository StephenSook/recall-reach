import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { testDb } from "../../test/pglite";
import { pullRecalls } from "../cpsc/pull";
import { migrate } from "../db/migrate";
import type { Db, Queryable } from "../db/types";
import type { ImportedOrderLine } from "../import/shopExport";
import { createShop, storeOrderLines } from "../import/store";
import { prepareNotice } from "../notice/store";
import { createContactCipher } from "../privacy/contactCipher";
import { registerPushToken } from "../push/push";
import { runShopCheck } from "./run";
import { checkStoredShops } from "./sweep";
import type { PayPalClient } from "../paypal/client";
import { REFUND_SCOPE, type PlatformEnv } from "../paypal/platform";
import { createRecordKey } from "../privacy/recordKey";
import { reserveStatusRead, saveSellerStatus, startConnection, trackingIdFor } from "../shop/paypalConnection";

const fixture: Record<string, unknown>[] = JSON.parse(
  readFileSync(new URL("../../test/fixtures/cpsc/recalls_2026-10-01_to_2026-11-05.json", import.meta.url), "utf8"),
);
const brezza = fixture.filter((r) => r.RecallNumber === "27072");
const others = fixture.filter((r) => r.RecallNumber !== "27072");
const TODAY = "2026-11-05";

const line = (orderNumber: string, title: string): ImportedOrderLine => ({
  orderNumber,
  lineNo: 1,
  title,
  sku: null,
  quantity: 1,
  unitPriceCents: 5000,
  discountCents: 0,
  currency: "USD",
  orderedOn: "2026-09-15",
  paymentReference: null,
  buyerEmail: null,
});

describe("checking stored shops against new recalls", () => {
  let db: Awaited<ReturnType<typeof testDb>>;
  let shopId: string;
  const pull = (records: Record<string, unknown>[]) => {
    const fetchImpl = async () => new Response(JSON.stringify(records), { status: 200, headers: { "content-type": "application/json" } });
    return pullRecalls(db, { field: "RecallDate", start: "2026-10-01", end: "2026-11-05" }, { fetchImpl: fetchImpl as typeof fetch });
  };
  const addShop = async (kind: "DEMO" | "REAL", name = "A shop") => {
    const id = await createShop(db, { name, kind });
    await storeOrderLines(db, id, [line(`${name}-1`, "Baby Brezza SuperFast Sterilizer Dryer BRZ0083")], createContactCipher("k".repeat(32), id), "test");
    await runShopCheck(db, id, { today: TODAY });
    return id;
  };
  const brezzaRows = async (id: string) =>
    (
      await db.query<{ id: string; verdict: string; sale_path: string; checked_at: unknown }>(
        "select m.id, m.verdict, m.sale_path, m.checked_at from recall_matches m join recalls r using (recall_id) where m.shop_id = $1 and r.recall_number = '27072'",
        [id],
      )
    ).rows;
  const sweep = (over: { maxShops?: number; budgetMs?: number } = {}, on: Db = db) => checkStoredShops(on, { now: new Date(), ...over });

  beforeEach(async () => {
    db = await testDb();
    await migrate(db);
    await pull(others);
    // These came in well before the shop did. A recall seen just before a shop was made is checked again: see below.
    await db.query("update recalls set first_seen_at = now() - interval '1 hour'");
    shopId = await addShop("REAL");
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await db.close();
  });

  describe("for a shop connected to its own PayPal account", () => {
    const SECRET = "s".repeat(64);
    const key = createRecordKey("test-record-key-secret-0123456789abcdef");
    const searched: string[] = [];
    const seller: PayPalClient = {
      request: (async (_m: string, path: string) => {
        searched.push(path);
        if (path === "/v1/customer/disputes") return { status: 200, data: { items: [] } };
        if (path !== "/v1/reporting/transactions") throw new Error(path);
        const sale = { transaction_id: "SELLERTXN1", transaction_event_code: "T0005", transaction_status: "S", transaction_initiation_date: "2026-09-15T15:00:00+0000", transaction_amount: { currency_code: "USD", value: "50.00" }, invoice_id: "A shop-1" };
        return { status: 200, data: { transaction_details: [{ transaction_info: sale, cart_info: { item_details: [{ item_name: "Baby Brezza SuperFast Sterilizer Dryer BRZ0083", item_code: "" }] } }], total_pages: 1 } };
      }) as PayPalClient["request"],
    };
    const platform: PlatformEnv = { clientId: "platform-id", partnerId: "PARTNER12345", client: { request: async () => ({ status: 200, data: {} }) } as unknown as PayPalClient, actingFor: () => seller };
    beforeEach(async () => {
      searched.length = 0;
      await startConnection(db, { shopId, trackingId: trackingIdFor(key, shopId), now: new Date() });
      await saveSellerStatus(db, { shopId, read: (await reserveStatusRead(db, shopId))!, status: { merchantId: "SELLERPAYER1", paymentsReceivable: true, primaryEmailConfirmed: true, scopes: [REFUND_SCOPE] }, secret: SECRET, recordKey: key, now: new Date() });
    });
    const joinOf = async () => (await db.query<{ join_state: string }>("select m.join_state from recall_matches m join recalls r using (recall_id) where m.shop_id = $1 and r.recall_number = '27072'", [shopId])).rows[0]?.join_state;

    it("reads its PayPal sales again when a new recall matches one of them, so the sale joins its payment", async () => {
      await pull(brezza);
      await checkStoredShops(db, { now: new Date(), paypal: { platform, secret: SECRET } });
      expect(searched).toContain("/v1/reporting/transactions");
      expect(await joinOf()).toBe("IDENTIFIED");
    });

    it("asks PayPal nothing when no new recall matches a sale, or when PayPal isn't set up here", async () => {
      await checkStoredShops(db, { now: new Date(), paypal: { platform, secret: SECRET } });
      expect(searched).toEqual([]);
      await pull(brezza);
      await checkStoredShops(db, { now: new Date() });
      expect(searched).toEqual([]);
    });
  });

  it("puts a new recall on a shop that uploaded before it, with nobody pressing anything", async () => {
    expect(await brezzaRows(shopId)).toEqual([]);
    await pull(brezza);
    expect(await sweep()).toMatchObject({ shopsChecked: 1, shopsFailed: 0, shopsWaiting: 0 });
    expect(await brezzaRows(shopId)).toMatchObject([{ verdict: "MATCH", sale_path: "NOTICE_ONLY" }]);
  });

  it("says the new recall was checked", async () => {
    await pull(brezza);
    await sweep();
    const { rows } = await db.query<{ recalls_checked: number }>("select recalls_checked from shop_runs where shop_id = $1", [shopId]);
    expect(rows).toEqual([{ recalls_checked: fixture.length }]);
  });

  it("has nothing to do once a shop has caught up, and writes nothing", async () => {
    await pull(brezza);
    await sweep();
    const before = await brezzaRows(shopId);
    expect(await sweep()).toMatchObject({ shopsChecked: 0, shopsFailed: 0, shopsWaiting: 0 });
    expect(await brezzaRows(shopId)).toEqual(before);
  });

  it("doesn't check a shop against an older recall CPSC republished, and doesn't stay behind on it", async () => {
    const republished = { ...brezza[0], RecallID: 900001, RecallNumber: "99001", RecallDate: "1998-12-01T00:00:00", LastPublishDate: "2026-11-04T00:00:00" };
    const fetchImpl = async () => new Response(JSON.stringify([republished]), { status: 200, headers: { "content-type": "application/json" } });
    await pullRecalls(db, { field: "LastPublishDate", start: "2026-11-04", end: "2026-11-05" }, { fetchImpl: fetchImpl as typeof fetch });
    expect(await sweep()).toMatchObject({ shopsChecked: 0, shopsFailed: 0, shopsWaiting: 0 });
    const { rows } = await db.query("select 1 from recall_matches m join recalls r using (recall_id) where m.shop_id = $1 and r.recall_number = '99001'", [shopId]);
    expect(rows).toEqual([]);
  });

  it("keeps the shop's stated range true when a new recall comes in", async () => {
    await pull(brezza);
    await sweep();
    const { rows } = await db.query<{ recalls_to: string }>("select recalls_to from shop_runs where shop_id = $1", [shopId]);
    expect(rows).toEqual([{ recalls_to: "2026-11-05" }]);
  });

  it("keeps the shop's stated gaps true when a missing year comes in", async () => {
    const older = readFileSync(new URL("../../test/fixtures/cpsc/recall_22200.json", import.meta.url), "utf8");
    const before = await db.query<{ recall_years_missing: number[] }>("select recall_years_missing from shop_runs where shop_id = $1", [shopId]);
    expect(before.rows[0].recall_years_missing).toContain(2022);
    const fetchImpl = async () => new Response(older, { status: 200, headers: { "content-type": "application/json" } });
    await pullRecalls(db, { field: "RecallDate", start: "2022-01-01", end: "2022-12-31" }, { fetchImpl: fetchImpl as typeof fetch });
    await sweep();
    const after = await db.query<{ recall_years_missing: number[] }>("select recall_years_missing from shop_runs where shop_id = $1", [shopId]);
    expect(after.rows[0].recall_years_missing).not.toContain(2022);
  });

  it("doesn't miss a recall whose load began before the shop was made and committed after its first check", async () => {
    await pull(brezza);
    // Its row carries the time its transaction began, a moment before this shop existed.
    await db.query("update recalls set first_seen_at = (select created_at from shops where id = $1) - interval '1 second' where recall_number = '27072'", [shopId]);
    expect(await sweep()).toMatchObject({ shopsChecked: 1 });
    expect(await brezzaRows(shopId)).toHaveLength(1);
  });

  it("does nothing at all when no recall is new", async () => {
    expect(await sweep()).toMatchObject({ shopsChecked: 0, shopsFailed: 0, shopsWaiting: 0 });
  });

  describe("when one shop's check fails at the very end", () => {
    const failingFor = (bad: string): Db => {
      const wrap = (q: Queryable): Queryable => ({
        exec: q.exec.bind(q),
        query: ((sql: string, params?: unknown[]) => {
          if (sql.includes("update shops") && params?.[0] === bad) throw new Error("the database went away");
          return q.query(sql, params);
        }) as Queryable["query"],
      });
      return { ...db, query: wrap(db).query, exec: db.exec.bind(db), transaction: (fn) => db.transaction((tx) => fn(wrap(tx) as typeof tx)) };
    };
    const marker = async (id: string) => (await db.query<{ at: string }>("select recalls_checked_through::text as at from shops where id = $1", [id])).rows[0].at;

    it("keeps nothing from that shop, leaves its marker, still checks the others, and says so", async () => {
      const other = await addShop("REAL", "Another shop");
      await pull(brezza);
      const before = await marker(shopId);
      const errors = vi.spyOn(console, "error").mockImplementation(() => {});

      expect(await sweep({}, failingFor(shopId))).toMatchObject({ shopsChecked: 1, shopsFailed: 1, shopsWaiting: 0 });

      expect(await brezzaRows(shopId)).toEqual([]);
      expect(await marker(shopId)).toBe(before);
      expect(await brezzaRows(other)).toHaveLength(1);
      expect(errors.mock.calls.flat().join(" ")).toContain("the database went away");
    });

    it("tries that shop again next time, and only that shop", async () => {
      await addShop("REAL", "Another shop");
      await pull(brezza);
      vi.spyOn(console, "error").mockImplementation(() => {});
      await sweep({}, failingFor(shopId));

      expect(await sweep()).toMatchObject({ shopsChecked: 1, shopsFailed: 0 });
      expect(await brezzaRows(shopId)).toHaveLength(1);
    });
  });

  it("is safe to repeat: no second row, and a card the seller acted on stays as it was", async () => {
    await pull(brezza);
    await sweep();
    const [{ id: matchId }] = await brezzaRows(shopId);
    const { noticeId } = await prepareNotice(db, { shopId, matchId });
    const notice = async () => (await db.query("select * from notices where id = $1", [noticeId])).rows;
    const held = await notice();
    // What a family's answer or a seller's action leaves on the row must survive a repeat.
    await db.query("update recall_matches set verdict = 'SCOPE_GAP', reason = 'settled by a person' where id = $1", [matchId]);
    const row = await brezzaRows(shopId);

    await db.query("update shops set recalls_checked_through = now() - interval '1 year' where id = $1", [shopId]);
    expect(await sweep()).toMatchObject({ shopsChecked: 1, shopsFailed: 0 });

    expect(await brezzaRows(shopId)).toEqual(row);
    expect((await db.query("select reason from recall_matches where id = $1", [matchId])).rows).toEqual([{ reason: "settled by a person" }]);
    expect(await notice()).toEqual(held);
  });

  it("a marker never moves back", async () => {
    await pull(brezza);
    await sweep();
    const at = async () => (await db.query<{ at: string }>("select recalls_checked_through::text as at from shops where id = $1", [shopId])).rows[0].at;
    const held = await at();
    await db.query("update shops set recalls_checked_through = now() + interval '1 hour' where id = $1", [shopId]);
    const ahead = await at();
    const { rows } = await db.query<{ recall_id: number }>("select recall_id from recalls where recall_number = '27072'");
    await runShopCheck(db, shopId, { today: TODAY, onlyRecallIds: rows.map((r) => r.recall_id) });
    expect(await at()).toBe(ahead);
    expect(ahead > held).toBe(true);
  });

  it("checks a demo shop only while it is recent, and a real shop for as long as it holds a file", async () => {
    const recentDemo = await addShop("DEMO", "Recent demo");
    const oldDemo = await addShop("DEMO", "Old demo");
    await db.query("update shops set created_at = now() - interval '3 days' where id = $1 or id = $2", [oldDemo, shopId]);
    await pull(brezza);
    await sweep();
    expect(await brezzaRows(recentDemo)).toHaveLength(1);
    expect(await brezzaRows(oldDemo)).toEqual([]);
    expect(await brezzaRows(shopId)).toHaveLength(1);
  });

  it("does a limited number of shops at a time, and the rest wait for the next one", async () => {
    await addShop("REAL", "Second");
    await addShop("REAL", "Third");
    await pull(brezza);
    expect(await sweep({ maxShops: 2 })).toMatchObject({ shopsChecked: 2, shopsWaiting: 1 });
    expect(await sweep({ maxShops: 2 })).toMatchObject({ shopsChecked: 1, shopsWaiting: 0 });
  });

  it("does a real shop first, however many demo shops are behind", async () => {
    const demo = await addShop("DEMO", "Older demo");
    await db.query("update shops set recalls_checked_through = now() - interval '1 day' where id = $1", [demo]);
    await pull(brezza);
    await sweep({ maxShops: 1 });
    expect(await brezzaRows(shopId)).toHaveLength(1);
    expect(await brezzaRows(demo)).toEqual([]);
  });

  it("starts no new shop once its time is up", async () => {
    await pull(brezza);
    expect(await sweep({ budgetMs: -1 })).toMatchObject({ shopsChecked: 0, shopsWaiting: 1 });
  });

  it("uses the rules only: no Claude and no message, and reaches PayPal only to read a connected shop's sales again", () => {
    for (const file of ["./sweep.ts", "./run.ts"]) {
      const source = readFileSync(new URL(file, import.meta.url), "utf8");
      expect(source).not.toMatch(/^import (?!type)[^;]*from "[^"]*(agent|anthropic|notice)[^"]*"/im);
    }
    expect(readFileSync(new URL("./run.ts", import.meta.url), "utf8")).not.toMatch(/^import (?!type)[^;]*from "[^"]*paypal[^"]*"/im);
    const paypalImports = [...readFileSync(new URL("./sweep.ts", import.meta.url), "utf8").matchAll(/^import (?!type)[^;]*from "([^"]*paypal[^"]*)"/gim)].map((m) => m[1]).sort();
    expect(paypalImports).toEqual(["../paypal/callLog", "../shop/paypalConnection"]);
  });

  describe("buzzing a phone", () => {
    const TOKEN = "ExponentPushToken[phone]";
    const expo = () => vi.fn(async (_url: string, _init: RequestInit) => new Response(JSON.stringify({ data: [{ status: "ok" }] }), { status: 200 }));
    const sweepWith = (f: ReturnType<typeof expo>) => checkStoredShops(db, { now: new Date(), pushFetch: f as unknown as typeof fetch });
    const bodies = (f: ReturnType<typeof expo>) => f.mock.calls.flatMap((c) => (JSON.parse(String(c[1].body)) as { body: string }[]).map((m) => m.body));

    it("says a new recall reached something the shop sold, once", async () => {
      await registerPushToken(db, shopId, TOKEN);
      await pull(brezza);
      const f = expo();
      await sweepWith(f);
      expect(bodies(f)).toEqual(["Recall 27072: something you sold needs a look"]);
      await sweepWith(f);
      expect(f).toHaveBeenCalledTimes(1);
    });

    it("stays quiet about a recall the shop's first check already put on its queue", async () => {
      await pull(brezza);
      const fresh = await addShop("REAL", "Fresh shop");
      expect((await brezzaRows(fresh)).length).toBe(1);
      await db.query("update shops set recalls_checked_through = now() - interval '1 day' where id = $1", [fresh]);
      await db.query("update shops set recalls_checked_through = now() + interval '1 day' where id <> $1", [fresh]);
      await registerPushToken(db, fresh, TOKEN);
      const f = expo();
      expect(await sweepWith(f)).toMatchObject({ shopsChecked: 1, shopsFailed: 0 });
      expect(f).not.toHaveBeenCalled();
    });

    it("says listed for a store's listing", async () => {
      const store = await createShop(db, { name: "A store", kind: "REAL" });
      await db.query("insert into shop_items (shop_id, title, source) values ($1, 'Baby Brezza SuperFast Sterilizer Dryer BRZ0083', 'test')", [store]);
      await runShopCheck(db, store, { today: TODAY });
      await registerPushToken(db, store, TOKEN);
      await pull(brezza);
      const f = expo();
      await sweepWith(f);
      expect(bodies(f)).toEqual(["Recall 27072: something you listed needs a look"]);
    });

    it("stays quiet when a new recall only shares a word with what the shop sold", async () => {
      const store = await createShop(db, { name: "A store", kind: "REAL" });
      await storeOrderLines(db, store, [line("W-1", "Sterilizer Dryer")], createContactCipher("k".repeat(32), store), "test");
      await runShopCheck(db, store, { today: TODAY });
      await registerPushToken(db, store, TOKEN);
      await pull(brezza);
      const f = expo();
      await sweepWith(f);
      const { rows } = await db.query<{ strength: string }>("select m.strength from recall_matches m join recalls r using (recall_id) where m.shop_id = $1 and r.recall_number = '27072' and m.verdict <> 'CLEARED'", [store]);
      expect(rows.map((r) => r.strength)).toEqual(["PRODUCT_WORDS"]);
      expect(f).not.toHaveBeenCalled();
    });

    it("still finishes the check when Expo is down", async () => {
      vi.spyOn(console, "error").mockImplementation(() => {});
      await registerPushToken(db, shopId, TOKEN);
      await pull(brezza);
      const down = vi.fn(async () => {
        throw new TypeError("fetch failed");
      });
      expect(await checkStoredShops(db, { now: new Date(), pushFetch: down as unknown as typeof fetch })).toMatchObject({ shopsChecked: 1, shopsFailed: 0 });
      expect(await brezzaRows(shopId)).toHaveLength(1);
    });
  });
});
