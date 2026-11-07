import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { answerSearch } from "../../test/fakeHistory";
import { testDb } from "../../test/pglite";
import { pullRecalls } from "../cpsc/pull";
import { migrate } from "../db/migrate";
import { createShop } from "../import/store";
import { modelTokens } from "../match/verdict";
import type { Method, PayPalClient, RequestOptions } from "../paypal/client";
import { registerPushToken } from "../push/push";
import { loadQueue } from "../queue/queue";
import { buyAsFamily, catchLiveSale, LiveSaleRefused } from "./liveCatch";
import { seedDemoShop } from "./seed";

const fixtureText = readFileSync(new URL("../../test/fixtures/cpsc/recalls_2026-10-01_to_2026-11-05.json", import.meta.url), "utf8");
const TODAY = "2026-11-06";
const NOW = new Date("2026-11-06T15:00:00Z");
const CAPTURED_AT = "2026-11-06T14:59:48Z"; // twelve seconds before NOW
const PAYPAL_ITEM_NAME = "SENTINEL PAYPAL ITEM NAME";

/** PayPal behind the real client interface. The item name it answers with is deliberately not the shop's. */
function fakePayPal(over: { captureStatus?: string; failCreate?: boolean } = {}) {
  const store = new Map<string, unknown>();
  const reads: string[] = [];
  const captures: string[] = [];
  let next = 0;
  const client: PayPalClient = {
    request: (async (method: Method, path: string, opts: RequestOptions = {}) => {
      const found = answerSearch(path);
      if (found) return found;
      if (method === "POST") {
        if (over.failCreate) throw new Error("PayPal said no");
        const id = `ORDER${next}`;
        const unit = (opts.body as { purchase_units: { amount: unknown; items?: { name: string }[] }[] }).purchase_units[0];
        const capture = {
          id: `CAPTURE${next}`,
          status: over.captureStatus ?? "COMPLETED",
          create_time: CAPTURED_AT,
          amount: unit.amount,
          supplementary_data: { related_ids: { order_id: id } },
        };
        next++;
        store.set(capture.id, capture);
        store.set(id, { id, status: "COMPLETED", purchase_units: [{ ...unit, items: unit.items?.map((i) => ({ ...i, name: PAYPAL_ITEM_NAME })), payments: { captures: [capture] } }] });
        captures.push(capture.id);
        return { status: 201, data: { id } };
      }
      reads.push(path);
      return { status: 200, data: store.get(path.split("/").pop() ?? "") };
    }) as PayPalClient["request"],
  };
  return { client, reads, captures };
}

describe("a sale as it happens", () => {
  let db: Awaited<ReturnType<typeof testDb>>;
  let shopId: string;
  let paypal: ReturnType<typeof fakePayPal>;
  let shelfItem: string;
  beforeEach(async () => {
    db = await testDb();
    await migrate(db);
    const fetchImpl = async () => new Response(fixtureText, { status: 200, headers: { "content-type": "application/json" } });
    await pullRecalls(db, { field: "RecallDate", start: "2026-10-01", end: "2026-11-05" }, { fetchImpl: fetchImpl as typeof fetch });
    paypal = fakePayPal();
    ({ shopId } = await seedDemoShop(db, paypal.client, { today: TODAY, secret: "k".repeat(32) }));
    shelfItem = (await db.query<{ id: string }>("select id from shop_items where shop_id = $1 and listed", [shopId])).rows[0].id;
  });
  afterEach(async () => {
    await db.close();
  });

  const buy = () => buyAsFamily(db, paypal.client, { shopId, shopItemId: shelfItem, today: TODAY, secret: "k".repeat(32) });
  const line = async () => (await db.query<Record<string, unknown>>("select * from order_lines where shop_id = $1 and live_sale", [shopId])).rows[0];
  const catchIt = (captureId = paypal.captures.at(-1) ?? "", now = NOW) => catchLiveSale(db, paypal.client, { captureId, now });
  const queueRow = async (lineId: unknown) => (await loadQueue(db, shopId, "s")).rows.find((r) => r.recordId === lineId);

  describe("the demo shop's shelf", () => {
    it("has a recalled item still listed, on a real recall, which the queue says to pull", async () => {
      const row = (await loadQueue(db, shopId, "s")).rows.find((r) => r.isListing && r.verdict !== "CLEARED");
      expect(row).toMatchObject({ recallNumber: "27018", verdict: "MATCH", stillListed: true });
    });

    it("names a model CPSC's own record lists for that recall, so the match is real", async () => {
      const { rows } = await db.query<{ title: string; description: string; item: string }>(
        "select r.title, r.description, (select title from shop_items where shop_id = $1 and listed limit 1) as item from recalls r where r.recall_number = '27018'",
        [shopId],
      );
      expect(modelTokens(`${rows[0].title} ${rows[0].description}`)).toContain("MY002");
      expect(rows[0].item).toContain("MY002");
    });
  });

  describe("buying it", () => {
    it("writes the sale from the shop's own listing, whatever PayPal calls the item", async () => {
      await buy();
      const { rows } = await db.query<{ title: string; sku: string; unit_price_cents: number }>("select title, sku, price_cents as unit_price_cents from shop_items where id = $1", [shelfItem]);
      expect(await line()).toMatchObject({ title: rows[0].title, sku: rows[0].sku, unit_price_cents: rows[0].unit_price_cents, ordered_on: TODAY, live_sale: true });
      expect(JSON.stringify(await line())).not.toContain(PAYPAL_ITEM_NAME);
    });

    it("gives every sale its own order number, because PayPal refuses a repeat", async () => {
      const first = await buy();
      await catchIt();
      expect((await buy()).orderNumber).not.toBe(first.orderNumber);
    });

    it("leaves nothing behind if PayPal refuses the payment", async () => {
      paypal = fakePayPal({ failCreate: true });
      await expect(buy()).rejects.toThrow();
      expect(await line()).toBeUndefined();
    });

    it("only works on a demo shop", async () => {
      await db.query("update shops set kind = 'REAL' where id = $1", [shopId]);
      await expect(buy()).rejects.toBeInstanceOf(LiveSaleRefused);
      expect(paypal.captures).toHaveLength(2); // only the seed's
    });

    it("only works on this shop's own listing", async () => {
      const other = await createShop(db, { name: "OTHER", kind: "DEMO" });
      await expect(buyAsFamily(db, paypal.client, { shopId: other, shopItemId: shelfItem, today: TODAY, secret: "k".repeat(32) })).rejects.toBeInstanceOf(LiveSaleRefused);
    });

    it("refuses something that is not an id", async () => {
      await expect(buyAsFamily(db, paypal.client, { shopId, shopItemId: "not-a-uuid", today: TODAY, secret: "k".repeat(32) })).rejects.toBeInstanceOf(LiveSaleRefused);
    });

    it("does not put it in the queue yet: nothing has been checked", async () => {
      await buy();
      expect(await queueRow((await line()).id)).toBeUndefined();
      expect((await loadQueue(db, shopId, "s")).pendingLiveSales).toBe(1);
    });
  });

  describe("when PayPal's webhook says it was captured", () => {
    it("puts a card in the queue with no one pressing anything", async () => {
      await buy();
      expect(await catchIt()).toBe("CAUGHT");
      const row = await queueRow((await line()).id);
      expect(row).toMatchObject({ recallNumber: "27018", verdict: "MATCH", strength: "CONFIRMED", salePath: "REFUND_ELIGIBLE", joinState: "IDENTIFIED" });
      expect((await loadQueue(db, shopId, "s")).pendingLiveSales).toBe(0);
    });

    it("confirms it through PayPal's API, and does not trust the event", async () => {
      await buy();
      const before = paypal.reads.length;
      await catchIt();
      expect(paypal.reads.slice(before).some((p) => p.includes("/v2/payments/captures/"))).toBe(true);
      expect(paypal.reads.slice(before).some((p) => p.includes("/v2/checkout/orders/"))).toBe(true);
    });

    it("does nothing for a capture that is not completed", async () => {
      paypal = fakePayPal({ captureStatus: "PENDING" });
      await buy();
      expect(await catchIt()).toBe("NOT_COMPLETED");
      expect(await queueRow((await line()).id)).toBeUndefined();
    });

    it("does nothing for the seed's own captures, or anything else without a live sale", async () => {
      const before = (await db.query("select checked_at from recall_matches order by id")).rows;
      expect(await catchIt(paypal.captures[0])).toBe("NOT_A_LIVE_SALE");
      expect((await db.query("select checked_at from recall_matches order by id")).rows).toEqual(before);
      expect((await db.query("select 1 from live_catch_runs")).rows).toEqual([]);
    });

    it("checks that one line only, and leaves the shop's coverage line alone", async () => {
      await buy();
      const others = (await db.query("select id, checked_at from recall_matches order by id")).rows;
      const runs = (await db.query("select id from shop_runs")).rows;
      await catchIt();
      const after = (await db.query<{ id: string; checked_at: unknown }>("select id, checked_at from recall_matches order by id")).rows;
      for (const row of others as { id: string; checked_at: unknown }[]) expect(after.find((a) => a.id === row.id)?.checked_at).toEqual(row.checked_at);
      expect((await db.query("select id from shop_runs")).rows).toEqual(runs);
    });

    it("keeps the shop's title and its own sale date, whatever PayPal says", async () => {
      await buy();
      const before = await line();
      await catchIt(paypal.captures.at(-1), new Date("2026-11-07T15:00:00Z"));
      expect(await line()).toMatchObject({ title: before.title, ordered_on: TODAY });
      expect(JSON.stringify(await line())).not.toContain(PAYPAL_ITEM_NAME);
    });

    it("is one card and one measurement however many times PayPal delivers it", async () => {
      await buy();
      expect(await catchIt()).toBe("CAUGHT");
      expect(await catchIt(paypal.captures.at(-1), new Date(NOW.getTime() + 60_000))).toBe("ALREADY");
      expect((await db.query("select 1 from live_catch_runs")).rows).toHaveLength(1);
      expect((await queueRow((await line()).id))?.caughtSeconds).toBe(12);
    });

    it("never calls Claude: this path can't reach the agent or the question writer", () => {
      const source = readFileSync(new URL("./liveCatch.ts", import.meta.url), "utf8");
      expect(source).not.toMatch(/agent\/|anthropic/i);
    });

    it("logs nothing about the sale", async () => {
      const logged = [vi.spyOn(console, "log"), vi.spyOn(console, "info"), vi.spyOn(console, "warn"), vi.spyOn(console, "error")];
      await buy();
      await catchIt();
      for (const spy of logged) {
        expect(spy).not.toHaveBeenCalled();
        spy.mockRestore();
      }
    });
  });

  describe("how long it took", () => {
    it("shows the seconds while the payment is held, and records them", async () => {
      await buy();
      await catchIt();
      expect((await queueRow((await line()).id))?.caughtSeconds).toBe(12);
      const { rows } = await db.query<{ seconds: string }>("select seconds::text as seconds from live_catch_runs");
      expect(Number(rows[0].seconds)).toBe(12);
    });

    it("stops showing them when the payment is purged, because the time goes with it", async () => {
      await buy();
      await catchIt();
      const lineId = (await line()).id;
      await db.query("delete from paypal_payments where shop_id = $1 and order_number = (select order_number from order_lines where id = $2)", [shopId, lineId]);
      expect((await queueRow(lineId))?.caughtSeconds).toBeNull();
    });

    it("copies PayPal's capture time nowhere the purge can't reach", async () => {
      await buy();
      await catchIt();
      const lineId = (await line()).id;
      const kept = [
        ...(await db.query("select * from order_lines where id = $1", [lineId])).rows,
        ...(await db.query("select * from recall_matches where order_line_id = $1", [lineId])).rows,
        ...(await db.query("select * from shop_runs where shop_id = $1", [shopId])).rows,
        ...(await db.query("select * from live_catch_runs")).rows,
      ];
      const asText = JSON.stringify(kept);
      expect(asText).not.toContain("14:59:48");
      expect(asText).not.toContain(new Date(CAPTURED_AT).toISOString());
      expect(JSON.stringify(await queueRow(lineId))).not.toContain("14:59:48");
    });

    it("gets a notice ready for a new sale when the shop turned that on for its recall, and sends nothing", async () => {
      const on = await db.query("insert into standing_notices (shop_id, recall_id) select $1, m.recall_id from recall_matches m where m.shop_id = $1 and m.shop_item_id = $2 and m.verdict <> 'CLEARED' returning recall_id", [shopId, shelfItem]);
      expect(on.rows.length).toBeGreaterThan(0);
      await buy();
      await catchIt();
      const { rows } = await db.query<{ verdict: string; notices: string; sent: string }>(
        `select m.verdict, (select count(*)::text from notices n where n.match_id = m.id) as notices, (select count(*)::text from notices n where n.match_id = m.id and n.sent_at is not null) as sent
         from recall_matches m where m.order_line_id = $1`,
        [(await line()).id],
      );
      expect(rows.length).toBeGreaterThan(0);
      for (const r of rows) {
        expect(r.notices).toBe(r.verdict === "MATCH" ? "1" : "0");
        expect(r.sent).toBe("0");
      }
    });

    it("gets no notice ready for a new sale otherwise", async () => {
      await buy();
      await catchIt();
      const { rows } = await db.query("select 1 from notices n join recall_matches m on m.id = n.match_id where m.order_line_id = $1", [(await line()).id]);
      expect(rows).toEqual([]);
    });

    it("keeps only the seconds in the measurement: no shop, sale or PayPal id", async () => {
      await buy();
      await catchIt();
      const { rows } = await db.query<Record<string, unknown>>("select * from live_catch_runs");
      expect(Object.keys(rows[0]).sort()).toEqual(["caught_at", "id", "seconds"]);
    });
  });

  describe("pressing again while a sale is on its way", () => {
    it("refuses in plain words, and makes no second capture", async () => {
      await buy();
      const made = paypal.captures.length;
      await expect(buy()).rejects.toMatchObject({ name: "LiveSaleRefused", message: "That sale is on its way. PayPal can take a minute or two to tell us." });
      expect(paypal.captures.length).toBe(made);
      const { rows } = await db.query("select 1 from order_lines where shop_id = $1 and live_sale", [shopId]);
      expect(rows).toHaveLength(1);
    });

    it("lets another sale start once the card has landed", async () => {
      await buy();
      await catchIt();
      await expect(buy()).resolves.toMatchObject({ orderNumber: expect.stringContaining("DEMO-LIVE-") });
    });

    it("doesn't block the shop for good if PayPal never tells us", async () => {
      await buy();
      await db.query("update order_lines set imported_at = now() - interval '6 minutes' where shop_id = $1 and live_sale", [shopId]);
      await expect(buy()).resolves.toMatchObject({ orderNumber: expect.stringContaining("DEMO-LIVE-") });
    });

    it("leaves other shops alone", async () => {
      await buy();
      const other = await seedDemoShop(db, paypal.client, { today: TODAY, secret: "k".repeat(32) });
      const item = (await db.query<{ id: string }>("select id from shop_items where shop_id = $1 and listed", [other.shopId])).rows[0].id;
      await expect(buyAsFamily(db, paypal.client, { shopId: other.shopId, shopItemId: item, today: TODAY, secret: "k".repeat(32) })).resolves.toBeDefined();
    });
  });

  describe("the phone's buzz when the card lands", () => {
    const TOKEN = "ExponentPushToken[phone]";
    const BUYER = "sentinel-buyer@example.test";
    const expo = () => vi.fn(async (_url: string, _init: RequestInit) => new Response(JSON.stringify({ data: [{ status: "ok" }] }), { status: 200 }));
    const buyWithEmail = () => buyAsFamily(db, paypal.client, { shopId, shopItemId: shelfItem, today: TODAY, secret: "k".repeat(32), demoEmail: BUYER });
    const catchWith = (f: ReturnType<typeof expo>) => catchLiveSale(db, paypal.client, { captureId: paypal.captures.at(-1) ?? "", now: NOW, pushFetch: f as unknown as typeof fetch });

    it("carries a public recall number and our own card id, and nothing PayPal returned or any buyer", async () => {
      await registerPushToken(db, shopId, TOKEN);
      await buyWithEmail();
      const f = expo();
      expect(await catchWith(f)).toBe("CAUGHT");
      const { id } = (await line()) as { id: string };
      const cardId = (await loadQueue(db, shopId, "s")).rows.find((r) => r.recordId === id && r.verdict === "MATCH")?.matchId;

      // The whole request, field by field, so nothing can be added to it and still pass.
      expect(f).toHaveBeenCalledTimes(1);
      const [url, init] = f.mock.calls[0];
      expect(url).toBe("https://exp.host/--/api/v2/push/send");
      expect(Object.keys(init).sort()).toEqual(["body", "headers", "method", "signal"]);
      expect(init.method).toBe("POST");
      expect(init.headers).toEqual({ "content-type": "application/json", accept: "application/json" });
      expect(JSON.parse(String(init.body))).toEqual([
        { to: TOKEN, title: "Recall Reach", body: "Recall 27018: something you sold needs a look", data: { path: `/queue#sale-${cardId}` }, sound: "default", priority: "high", channelId: "cards" },
      ]);
    });

    it("doesn't buzz twice when PayPal delivers the same sale twice", async () => {
      await registerPushToken(db, shopId, TOKEN);
      await buyWithEmail();
      const f = expo();
      await catchWith(f);
      expect(await catchWith(f)).toBe("ALREADY");
      expect(f).toHaveBeenCalledTimes(1);
    });

    it("says nothing to anyone when no phone asked", async () => {
      await buyWithEmail();
      const f = expo();
      expect(await catchWith(f)).toBe("CAUGHT");
      expect(f).not.toHaveBeenCalled();
    });

    it("still catches the sale when Expo is down", async () => {
      vi.spyOn(console, "error").mockImplementation(() => {});
      await registerPushToken(db, shopId, TOKEN);
      await buyWithEmail();
      const down = vi.fn(async () => {
        throw new TypeError("fetch failed");
      });
      expect(await catchLiveSale(db, paypal.client, { captureId: paypal.captures.at(-1) ?? "", now: NOW, pushFetch: down as unknown as typeof fetch })).toBe("CAUGHT");
      expect((await queueRow((await line()).id))?.verdict).toBeDefined();
    });
  });
});
