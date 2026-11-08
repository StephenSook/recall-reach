import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { answerSearch } from "../../test/fakeHistory";
import { testDb } from "../../test/pglite";
import { pullRecalls } from "../cpsc/pull";
import { migrate } from "../db/migrate";
import { createShop } from "../import/store";
import { joinShop, runShopCheck } from "../match/run";
import { checkStoredShops } from "../match/sweep";
import { PayPalApiError, type Method, type PayPalClient, type RequestOptions } from "../paypal/client";
import { loadQueue } from "../queue/queue";
import { createContactCipher } from "../privacy/contactCipher";
import * as calendar from "../time/businessDay";
import { buyAsFamily, cancelPayPalBuy, catchLiveSale, finishPayPalBuy, LiveSaleRefused, startPayPalBuy } from "./liveCatch";
import { seedDemoShop } from "./seed";

const fixtureText = readFileSync(new URL("../../test/fixtures/cpsc/recalls_2026-10-01_to_2026-11-05.json", import.meta.url), "utf8");
const TODAY = "2026-11-06";
const NOW = new Date("2026-11-06T15:00:00Z");
const SITE = "https://site.test";
const KEY = "k".repeat(32);
const SESSION_KEY = "s".repeat(32);
const PAYER_EMAIL = "sentinel-payer@example.test";
const PAYER_NAME = "SENTINEL PAYER NAME";

interface FakeOrder {
  id: string;
  status: string;
  purchase_units: Record<string, unknown>[];
  payment_source?: unknown;
  payer?: unknown;
}

/** PayPal as measured on 2026-11-06: no capture until a person approves, and approving adds the payer's details. */
function fakePayPal(over: { approveHost?: string; failCreate?: boolean; failCapture?: boolean; firstOrder?: number; captureError?: (order: FakeOrder) => Error; failReadAfterCapture?: boolean } = {}) {
  const orders = new Map<string, FakeOrder>();
  const captures: { id: string; order: string; requestId?: string }[] = [];
  const bodies: Record<string, unknown>[] = [];
  let next = over.firstOrder ?? 0;
  let capturesFailed = false;
  const client: PayPalClient = {
    request: (async (method: Method, path: string, opts: RequestOptions = {}) => {
      const found = answerSearch(path);
      if (found) return found;
      const capturing = /^\/v2\/checkout\/orders\/([^/]+)\/capture$/.exec(path);
      if (method === "POST" && capturing) {
        const order = orders.get(capturing[1]);
        if (order && over.captureError) {
          capturesFailed = true;
          throw over.captureError(order);
        }
        if (!order || order.status !== "APPROVED" || over.failCapture) throw new PayPalApiError(422, method, path, "ORDER_NOT_APPROVED");
        const id = `CAPTURE-${order.id}`;
        const unit = order.purchase_units[0];
        order.status = "COMPLETED";
        unit.payments = { captures: [{ id, status: "COMPLETED", create_time: "2026-11-06T14:59:48Z", amount: unit.amount, supplementary_data: { related_ids: { order_id: order.id } } }] };
        captures.push({ id, order: order.id, requestId: opts.requestId });
        return { status: 201, data: { id: order.id, status: order.status } };
      }
      if (method === "POST" && path === "/v2/checkout/orders") {
        if (over.failCreate) throw new Error("PayPal create failed");
        const body = opts.body as { purchase_units: Record<string, unknown>[]; payment_source?: { paypal?: unknown; card?: unknown } };
        bodies.push(body);
        const id = `ORDER${next++}`;
        if (body.payment_source?.card) {
          const unit = body.purchase_units[0];
          const capture = { id: `CAPTURE-${id}`, status: "COMPLETED", create_time: "2026-11-06T14:59:48Z", amount: unit.amount };
          orders.set(id, { id, status: "COMPLETED", purchase_units: [{ ...unit, payments: { captures: [capture] } }] });
          return { status: 201, data: { id } };
        }
        orders.set(id, { id, status: "PAYER_ACTION_REQUIRED", purchase_units: body.purchase_units });
        const host = over.approveHost ?? "www.sandbox.paypal.com";
        return { status: 200, data: { id, status: "PAYER_ACTION_REQUIRED", links: [{ rel: "self", href: `https://api.sandbox.paypal.com/v2/checkout/orders/${id}`, method: "GET" }, { rel: "payer-action", href: `https://${host}/checkoutnow?token=${id}`, method: "GET" }] } };
      }
      const id = path.split("/").pop() ?? "";
      if (capturesFailed && over.failReadAfterCapture) throw new Error("PayPal gave no answer");
      const order = orders.get(id);
      if (order) return { status: 200, data: order };
      const capture = captures.find((c) => c.id === id);
      if (capture) return { status: 200, data: { id, status: "COMPLETED", amount: { currency_code: "USD", value: "1.00" }, supplementary_data: { related_ids: { order_id: capture.order } } } };
      throw new PayPalApiError(404, method, path, "NOT_FOUND");
    }) as PayPalClient["request"],
  };
  const approve = (id: string) => {
    const order = orders.get(id)!;
    order.status = "APPROVED";
    order.payer = { email_address: PAYER_EMAIL, name: { given_name: PAYER_NAME } };
    order.payment_source = { paypal: { email_address: PAYER_EMAIL, name: { given_name: PAYER_NAME } } };
  };
  return { client, orders, captures, bodies, approve };
}

describe("buying through PayPal's own approval page", () => {
  let db: Awaited<ReturnType<typeof testDb>>;
  let shopId: string;
  let paypal: ReturnType<typeof fakePayPal>;
  let shelfItem: string;
  beforeEach(async () => {
    vi.spyOn(calendar, "businessDay").mockReturnValue(TODAY);
    db = await testDb();
    await migrate(db);
    const fetchImpl = async () => new Response(fixtureText, { status: 200, headers: { "content-type": "application/json" } });
    await pullRecalls(db, { field: "RecallDate", start: "2026-10-01", end: "2026-11-05" }, { fetchImpl: fetchImpl as typeof fetch });
    const seeding = fakePayPal({ firstOrder: 1000 });
    ({ shopId } = await seedDemoShop(db, seeding.client, { today: TODAY, secret: KEY }));
    paypal = fakePayPal();
    shelfItem = (await db.query<{ id: string }>("select id from shop_items where shop_id = $1 and listed", [shopId])).rows[0].id;
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await db.close();
  });

  const SESSION = "browser-a";
  const start = (client = paypal.client, shop = shopId, item = shelfItem) => startPayPalBuy(db, client, { shopId: shop, sessionId: SESSION, shopItemId: item, siteUrl: SITE, sessionSecret: SESSION_KEY });
  const stateOf = (approveFor: { returnUrl: string }) => new URL(approveFor.returnUrl).searchParams.get("state") ?? "";
  const finish = (state: string, orderId: string, shop = shopId, today = TODAY, sessionId = SESSION) => finishPayPalBuy(db, paypal.client, { shopId: shop, sessionId, state, orderId, today, secret: KEY, sessionSecret: SESSION_KEY });
  const liveLines = async () => (await db.query<Record<string, unknown>>("select * from order_lines where shop_id = $1 and live_sale", [shopId])).rows;
  const approved = async () => {
    const started = await start();
    paypal.approve(started.orderId);
    return started;
  };

  const familyBuy = () => buyAsFamily(db, paypal.client, { shopId, shopItemId: shelfItem, today: TODAY, secret: KEY });
  const expireReservations = () => db.query("update order_lines set imported_at = now() - interval '6 minutes' where shop_id = $1 and live_sale", [shopId]);

  describe("sale reservations", () => {
    // PGlite serialises transactions, so this test does not prove advisory-lock safety across connections.
    it.each(["two starts", "a start and a family buy", "two family buys"])("allows exactly one of %s concurrently", async (kind) => {
      const attempts = kind === "two starts" ? [start(), start()] : kind === "two family buys" ? [familyBuy(), familyBuy()] : [start(), familyBuy()];
      const results = await Promise.allSettled(attempts);
      expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
      expect(results.filter((r) => r.status === "rejected")).toEqual([expect.objectContaining({ reason: expect.any(LiveSaleRefused) })]);
      expect(await liveLines()).toHaveLength(1);
      expect(paypal.bodies).toHaveLength(1);
    });

    it("takes the sale lock inside the transaction before checking or writing", async () => {
      const transaction = db.transaction.bind(db);
      const queries: { sql: string; params?: unknown[] }[] = [];
      vi.spyOn(db, "transaction").mockImplementation((fn) => transaction((tx) => fn({
        ...tx,
        query: (sql, params) => {
          queries.push({ sql, params });
          return tx.query(sql, params);
        },
      })));
      await start();
      expect(queries[0]).toEqual({ sql: "select pg_advisory_xact_lock(hashtext('shop-live-sale'), hashtext($1))", params: [shopId] });
      expect(queries.some((q) => q.sql.includes("not exists"))).toBe(true);
      expect(queries.some((q) => q.sql.includes("insert into order_lines"))).toBe(true);
      const { rows } = await db.query<{ distinct: boolean }>("select hashtext('shop-live-sale') <> hashtext('shop-paypal-connection') as distinct");
      expect(rows).toEqual([{ distinct: true }]);
    });

    it("commits the reservation before calling PayPal, with no transaction held across the call", async () => {
      const transaction = db.transaction.bind(db);
      let inTransaction = false;
      vi.spyOn(db, "transaction").mockImplementation(async (fn) => {
        inTransaction = true;
        try {
          return await transaction(fn);
        } finally {
          inTransaction = false;
        }
      });
      const request = paypal.client.request.bind(paypal.client);
      vi.spyOn(paypal.client, "request").mockImplementation(async (method, path, options) => {
        expect(inTransaction).toBe(false);
        expect(await liveLines()).toHaveLength(1);
        return request(method, path, options);
      });
      await start();
    });

    it("keeps a reservation when PayPal order creation has an unknown outcome", async () => {
      await expect(start(fakePayPal({ failCreate: true }).client)).rejects.toThrow("PayPal create failed");
      expect(await liveLines()).toHaveLength(1);
      await expect(start()).rejects.toBeInstanceOf(LiveSaleRefused);
      await expireReservations();
      await expect(start()).resolves.toHaveProperty("orderId");
    });

    it.each([
      [422, "POST", false, 0],
      [422, "POST", true, 1],
      [404, "GET", false, 1],
      [500, "POST", false, 1],
      [429, "POST", false, 1],
    ] as const)("handles create failure %s %s (uncertain: %s) with %s reservations kept", async (status, method, uncertain, kept) => {
      const err = new PayPalApiError(status, method, "/v2/checkout/orders");
      err.uncertain = uncertain;
      vi.spyOn(paypal.client, "request").mockRejectedValueOnce(err);
      await expect(start()).rejects.toBe(err);
      expect(await liveLines()).toHaveLength(kept);
    });

    it("keeps its own reservation unchanged through concurrent finishes", async () => {
      const started = await approved();
      const before = await liveLines();
      expect(before).toHaveLength(1);
      await expect(Promise.all([finish(stateOf(started), started.orderId), finish(stateOf(started), started.orderId)])).resolves.toEqual([undefined, undefined]);
      expect(await liveLines()).toEqual([{ ...before[0], capture_started: true, capture_pending: false }]);
      expect(paypal.captures).toHaveLength(1);
    });

    it("captures a legacy approved order without a reservation when the shop is free", async () => {
      const started = await approved();
      await db.query("delete from order_lines where shop_id = $1 and live_sale", [shopId]);
      await expect(finish(stateOf(started), started.orderId)).resolves.toBeUndefined();
      expect(paypal.orders.get(started.orderId)?.status).toBe("COMPLETED");
      expect(await liveLines()).toHaveLength(1);
      await finish(stateOf(started), started.orderId);
      expect(await liveLines()).toHaveLength(1);
      expect(paypal.captures).toHaveLength(1);
    });

    it("refuses a retry after its reservation was released and another order reserved the shop", async () => {
      paypal = fakePayPal({ failCapture: true });
      const first = await approved();
      await expect(finish(stateOf(first), first.orderId)).rejects.toThrow();
      expect(await liveLines()).toHaveLength(1);
      paypal.orders.get(first.orderId)!.status = "VOIDED";
      await cancelPayPalBuy(db, { shopId, sessionId: SESSION, state: stateOf(first), sessionSecret: SESSION_KEY, orderId: first.orderId }, paypal.client);
      expect(await liveLines()).toEqual([]);
      paypal.approve(first.orderId);
      const second = await start();
      const before = await liveLines();
      const capture = vi.spyOn(paypal.client, "request");
      await expect(finish(stateOf(first), first.orderId)).rejects.toThrow("That sale is on its way.");
      expect(capture.mock.calls.some(([, path]) => path.endsWith("/capture"))).toBe(false);
      expect(await liveLines()).toEqual(before);
      expect(before[0].order_number).toBe(paypal.orders.get(second.orderId)?.purchase_units[0].invoice_id);
      expect(paypal.orders.get(first.orderId)?.status).toBe("APPROVED");
    });

    it.each([false, true])("marks older unconfirmed reservations pending without hiding confirmed sales (payment purged: %s)", async (purged) => {
      const confirmed = await approved();
      await finish(stateOf(confirmed), confirmed.orderId);
      await catchLiveSale(db, paypal.client, { captureId: paypal.captures[0].id, now: NOW });
      if (purged) await db.query("delete from paypal_payments where shop_id = $1", [shopId]);
      const abandoned = await start();
      await db.exec("alter table order_lines drop column capture_pending");
      await db.exec(readFileSync(new URL("../../db/migrations/0070_capture_pending.sql", import.meta.url), "utf8"));
      const lines = await liveLines();
      expect(lines.find((l) => l.order_number === paypal.orders.get(confirmed.orderId)!.purchase_units[0].invoice_id)?.capture_pending).toBe(false);
      expect(lines.find((l) => l.order_number === paypal.orders.get(abandoned.orderId)!.purchase_units[0].invoice_id)?.capture_pending).toBe(true);
      expect((await db.query("select 1 from order_lines where shop_id = $1 and not live_sale and capture_pending", [shopId])).rows).toEqual([]);
    });

    it("leaves a confirmed sale unchanged when its signed cancellation is replayed", async () => {
      const started = await approved();
      await finish(stateOf(started), started.orderId);
      await catchLiveSale(db, paypal.client, { captureId: paypal.captures[0].id, now: NOW });
      const before = await liveLines();
      expect(await cancelPayPalBuy(db, { shopId, sessionId: SESSION, state: stateOf(started), sessionSecret: SESSION_KEY })).toBe(false);
      expect(await liveLines()).toEqual(before);
    });

    it.each(["APPROVED", "COMPLETED"])("keeps a reservation when PayPal says %s before its webhook arrives", async (status) => {
      const started = await approved();
      if (status === "COMPLETED") await finish(stateOf(started), started.orderId);
      const before = await liveLines();
      await cancelPayPalBuy(db, { shopId, sessionId: SESSION, state: stateOf(started), sessionSecret: SESSION_KEY, orderId: started.orderId }, paypal.client);
      expect(await liveLines()).toEqual(before);
    });

    it("keeps a sale captured after a cancellation read PayPal, so its webhook still finds it", async () => {
      const started = await start();
      const state = stateOf(started);
      // The cancel reads the order while it still needs the buyer. The capture lands before the cancel acts on that answer.
      const stale: PayPalClient = {
        request: (async (method: Method, path: string, opts?: RequestOptions) => {
          const answer = JSON.parse(JSON.stringify(await paypal.client.request(method, path, opts)));
          paypal.approve(started.orderId);
          await finish(state, started.orderId);
          return answer;
        }) as PayPalClient["request"],
      };
      expect(await cancelPayPalBuy(db, { shopId, sessionId: SESSION, state, sessionSecret: SESSION_KEY, orderId: started.orderId }, stale)).toBe(false);
      expect(await liveLines()).toHaveLength(1);
      expect(await catchLiveSale(db, paypal.client, { captureId: paypal.captures[0].id, now: NOW })).toBe("CAUGHT");
    });

    it("reports whether a signed cancellation actually released its reservation", async () => {
      const started = await start();
      const input = { shopId, sessionId: SESSION, state: stateOf(started), sessionSecret: SESSION_KEY, orderId: started.orderId };
      expect(await cancelPayPalBuy(db, input, paypal.client)).toBe(true);
      expect(await liveLines()).toEqual([]);
      expect(await cancelPayPalBuy(db, input, paypal.client)).toBe(false);
    });

    it("checks the cancel token's invoice against the signed order before releasing anything", async () => {
      const first = await start();
      await expireReservations();
      const second = await start();
      const before = await liveLines();
      await expect(cancelPayPalBuy(db, { shopId, sessionId: SESSION, state: stateOf(first), sessionSecret: SESSION_KEY, orderId: second.orderId }, paypal.client)).rejects.toBeInstanceOf(LiveSaleRefused);
      expect(await liveLines()).toEqual(before);
    });

    it("keeps the reservation when PayPal cannot read the cancel token", async () => {
      const started = await start();
      vi.spyOn(paypal.client, "request").mockRejectedValueOnce(new Error("PayPal gave no answer"));
      await expect(cancelPayPalBuy(db, { shopId, sessionId: SESSION, state: stateOf(started), sessionSecret: SESSION_KEY, orderId: started.orderId }, paypal.client)).rejects.toThrow();
      expect(await liveLines()).toHaveLength(1);
    });

    it("locks the live line before saving the webhook payment and clearing pending in one transaction", async () => {
      const started = await approved();
      await finish(stateOf(started), started.orderId);
      const transaction = db.transaction.bind(db);
      const queries: string[][] = [];
      vi.spyOn(db, "transaction").mockImplementation((fn) => transaction((tx) => {
        const statements: string[] = [];
        queries.push(statements);
        return fn({ ...tx, query: (sql, params) => {
          statements.push(sql);
          return tx.query(sql, params);
        } });
      }));
      await catchLiveSale(db, paypal.client, { captureId: paypal.captures[0].id, now: NOW });
      const confirmation = queries.find((statements) => statements.some((sql) => sql.includes("insert into paypal_payments")));
      expect(confirmation).toBeDefined();
      expect(confirmation![0]).toContain("pg_advisory_xact_lock");
      expect(confirmation![1]).toContain("select id from order_lines");
      expect(confirmation!.findIndex((sql) => sql.includes("insert into paypal_payments"))).toBeLessThan(confirmation!.findIndex((sql) => sql.includes("set capture_pending = false")));
    });

    it("rolls the webhook payment back if clearing pending fails, so cancellation cannot see half a confirmation", async () => {
      const started = await approved();
      await finish(stateOf(started), started.orderId);
      // As if the buyer's return never confirmed it, so the webhook is the first to.
      await db.query("delete from paypal_payments where shop_id = $1 and order_id = $2", [shopId, started.orderId]);
      await db.query("update order_lines set capture_pending = true where shop_id = $1 and live_sale", [shopId]);
      const transaction = db.transaction.bind(db);
      const query = db.query.bind(db);
      const refuseUpdate = (sql: string) => { if (sql.includes("set capture_pending = false")) throw new Error("confirmation failed"); };
      vi.spyOn(db, "query").mockImplementation((sql, params) => { refuseUpdate(sql); return query(sql, params); });
      vi.spyOn(db, "transaction").mockImplementation((fn) => transaction((tx) => fn({
        ...tx, query: (sql, params) => { refuseUpdate(sql); return tx.query(sql, params); },
      })));
      await expect(catchLiveSale(db, paypal.client, { captureId: paypal.captures[0].id, now: NOW })).rejects.toThrow("confirmation failed");
      expect((await db.query("select 1 from paypal_payments where shop_id = $1 and order_id = $2", [shopId, started.orderId])).rows).toEqual([]);
      expect((await liveLines())[0].capture_pending).toBe(true);
    });

    it.each(["shop check", "recall sweep"])("keeps abandoned reservations out of a %s until a completed capture is verified", async (check) => {
      const started = await start();
      const line = (await liveLines())[0];
      expect(line.capture_pending).toBe(true);
      const checkShop = async () => {
        if (check === "shop check") {
          await runShopCheck(db, shopId, { today: TODAY });
        } else {
          await db.query("update shops set recalls_checked_through = to_timestamp(0) where id = $1", [shopId]);
          const result = await checkStoredShops(db, { now: NOW, pushFetch: async () => new Response(null, { status: 200 }) });
          expect(result.shopsChecked).toBe(1);
          expect(result.shopsFailed).toBe(0);
        }
        expect((await db.query("select 1 from recall_matches where order_line_id = $1", [line.id])).rows).toEqual([]);
        expect((await joinShop(db, shopId, { today: TODAY })).joined.lines).not.toHaveProperty(String(line.id));
      };
      await checkShop();
      await expireReservations();
      await checkShop();
      paypal.approve(started.orderId);
      await finish(stateOf(started), started.orderId);
      expect((await liveLines())[0].capture_pending).toBe(false); // PayPal's own order shows the completed capture.
      expect(await catchLiveSale(db, paypal.client, { captureId: paypal.captures[0].id, now: NOW })).toBe("CAUGHT");
      expect((await liveLines())[0].capture_pending).toBe(false);
      expect((await db.query("select 1 from recall_matches where order_line_id = $1", [line.id])).rows.length).toBeGreaterThan(0);
    });

    it("captures with its own reservation and another shop's pending sale", async () => {
      const started = await approved();
      const other = await seedDemoShop(db, fakePayPal({ firstOrder: 2000 }).client, { today: TODAY, secret: KEY });
      const item = (await db.query<{ id: string }>("select id from shop_items where shop_id = $1 and listed", [other.shopId])).rows[0].id;
      await start(paypal.client, other.shopId, item);
      await expect(finish(stateOf(started), started.orderId)).resolves.toBeUndefined();
      expect(paypal.captures).toHaveLength(1);
      expect(await liveLines()).toHaveLength(1);
    });

    it("captures after approval even if another sale began after its reservation expired", async () => {
      const started = await approved();
      await expireReservations();
      await familyBuy();
      await expect(finish(stateOf(started), started.orderId)).resolves.toBeUndefined();
      expect(paypal.captures).toHaveLength(1);
      expect(await liveLines()).toHaveLength(2);
    });

    it("seals the configured demo contact on the reserved line only once", async () => {
      const started = await approved();
      const input = { shopId, sessionId: SESSION, state: stateOf(started), orderId: started.orderId, today: TODAY, secret: KEY, sessionSecret: SESSION_KEY, demoEmail: "demo@example.test" };
      await finishPayPalBuy(db, paypal.client, input);
      const before = await liveLines();
      expect(before).toHaveLength(1);
      expect(createContactCipher(KEY, shopId).open(String(before[0].buyer_email_enc))).toBe(input.demoEmail);
      await finishPayPalBuy(db, paypal.client, { ...input, demoEmail: "changed@example.test" });
      expect(await liveLines()).toEqual(before);
    });
  });

  describe("sending the buyer to PayPal", () => {
    it("asks for a PayPal payment that needs a person, with no card and no shipping", async () => {
      const started = await start();
      const body = paypal.bodies[0] as { intent: string; purchase_units: { invoice_id: string }[]; payment_source: { card?: unknown; paypal: { experience_context: Record<string, string> } } };
      expect(body.intent).toBe("CAPTURE");
      expect(body.payment_source.card).toBeUndefined();
      expect(body.payment_source.paypal.experience_context).toMatchObject({ user_action: "PAY_NOW", shipping_preference: "NO_SHIPPING", brand_name: "DEMO SHOP" });
      expect(body.payment_source.paypal.experience_context.return_url).toBe(started.returnUrl);
      expect(body.payment_source.paypal.experience_context.cancel_url).toBe(`${started.returnUrl}&cancelled=1`);
      expect(body.purchase_units[0].invoice_id).toMatch(/^DEMO-LIVE-[0-9a-f]{12}$/);
    });

    it("gives PayPal's own approval page, on the sandbox", async () => {
      const { approveUrl, orderId } = await start();
      expect(approveUrl).toBe(`https://www.sandbox.paypal.com/checkoutnow?token=${orderId}`);
    });

    it.each(["www.paypal.com", "evil.example"])("won't send anyone to %s", async (approveHost) => {
      await expect(start(fakePayPal({ approveHost }).client)).rejects.toThrow(/sandbox/);
      expect(await liveLines()).toHaveLength(1);
    });

    it("reserves the order's line but captures nothing until approval", async () => {
      const started = await start();
      expect(await liveLines()).toEqual([expect.objectContaining({ order_number: paypal.orders.get(started.orderId)?.purchase_units[0].invoice_id, live_sale: true, buyer_email_enc: null })]);
      expect(paypal.captures).toEqual([]);
    });

    it("only works on this demo shop's own listing", async () => {
      const other = await createShop(db, { name: "OTHER", kind: "DEMO" });
      await expect(start(paypal.client, other)).rejects.toBeInstanceOf(LiveSaleRefused);
      await expect(start(paypal.client, shopId, "not-a-uuid")).rejects.toBeInstanceOf(LiveSaleRefused);
      await db.query("update shops set kind = 'REAL' where id = $1", [shopId]);
      await expect(start()).rejects.toBeInstanceOf(LiveSaleRefused);
      expect(paypal.bodies).toEqual([]);
    });
  });

  describe("when the buyer comes back approved", () => {
    it("writes the sale from the shop's own listing, then captures it once", async () => {
      const started = await approved();
      await finish(stateOf(started), started.orderId);
      const { rows } = await db.query<{ title: string; price_cents: number }>("select title, price_cents from shop_items where id = $1", [shelfItem]);
      expect(await liveLines()).toEqual([expect.objectContaining({ title: rows[0].title, unit_price_cents: rows[0].price_cents, ordered_on: TODAY, live_sale: true, order_number: paypal.orders.get(started.orderId)?.purchase_units[0].invoice_id })]);
      expect(paypal.captures).toEqual([{ id: `CAPTURE-${started.orderId}`, order: started.orderId, requestId: expect.any(String) }]);
    });

    it("then the webhook does the rest: a card lands on the queue, as with the test card", async () => {
      const started = await approved();
      await finish(stateOf(started), started.orderId);
      expect((await loadQueue(db, shopId, "s")).pendingLiveSales).toBe(1);
      expect(await catchLiveSale(db, paypal.client, { captureId: paypal.captures[0].id, now: NOW })).toBe("CAUGHT");
      const row = (await loadQueue(db, shopId, "s")).rows.find((r) => r.recallNumber === "27018" && !r.isListing);
      expect(row).toMatchObject({ verdict: "MATCH", strength: "CONFIRMED", joinState: "IDENTIFIED" });
    });

    describe("with no webhook ever delivered", () => {
      const held = async () => (await db.query<{ capture_pending: boolean; payments: number }>(
        "select l.capture_pending, (select count(*)::int from paypal_payments p where p.shop_id = l.shop_id and p.order_number = l.order_number) as payments from order_lines l where l.shop_id = $1 and l.live_sale",
        [shopId],
      )).rows;

      it("confirms the sale as soon as PayPal says the capture completed", async () => {
        const started = await approved();
        await finish(stateOf(started), started.orderId);
        expect(await held()).toEqual([{ capture_pending: false, payments: 1 }]);
      });

      it("confirms on a reload that finds the order already completed", async () => {
        const started = await approved();
        await finish(stateOf(started), started.orderId);
        await db.query("delete from paypal_payments where shop_id = $1 and capture_id like 'CAPTURE-%' and order_id = $2", [shopId, started.orderId]);
        await db.query("update order_lines set capture_pending = true where shop_id = $1 and live_sale", [shopId]);
        await finish(stateOf(started), started.orderId);
        expect(await held()).toEqual([{ capture_pending: false, payments: 1 }]);
        expect(paypal.captures).toHaveLength(1);
      });

      it("confirms when the capture's answer was lost but PayPal's order says completed", async () => {
        paypal = fakePayPal({
          captureError: (order) => {
            const unit = order.purchase_units[0];
            order.status = "COMPLETED";
            unit.payments = { captures: [{ id: `CAPTURE-${order.id}`, status: "COMPLETED", create_time: "2026-11-06T14:59:48Z", amount: unit.amount }] };
            return new Error("PayPal gave no answer");
          },
        });
        const started = await approved();
        await finish(stateOf(started), started.orderId);
        expect(await held()).toEqual([{ capture_pending: false, payments: 1 }]);
      });
    });

    it("is safe to reload: no second capture, no second sale", async () => {
      const started = await approved();
      await finish(stateOf(started), started.orderId);
      await finish(stateOf(started), started.orderId);
      expect(paypal.captures).toHaveLength(1);
      expect(await liveLines()).toHaveLength(1);
    });

    it("a reload the next day doesn't change the sale", async () => {
      const started = await approved();
      await finish(stateOf(started), started.orderId);
      await finish(stateOf(started), started.orderId, shopId, "2026-11-07");
      expect(String((await liveLines())[0].ordered_on)).toContain(TODAY);
    });

    it("keeps the sale when a second return loses the race to capture it", async () => {
      paypal = fakePayPal({ captureError: (order) => {
        order.status = "COMPLETED";
        return new PayPalApiError(422, "POST", "/v2/checkout/orders/x/capture", "ORDER_ALREADY_CAPTURED");
      } });
      const started = await approved();
      await finish(stateOf(started), started.orderId);
      expect(await liveLines()).toHaveLength(1);
    });

    it("keeps the sale when a failed capture re-read still says APPROVED", async () => {
      paypal = fakePayPal({ captureError: () => {
        const err = new PayPalApiError(500, "POST", "/v2/checkout/orders/x/capture");
        err.uncertain = true;
        return err;
      } });
      const started = await approved();
      await expect(finish(stateOf(started), started.orderId)).rejects.toThrow();
      expect(await liveLines()).toHaveLength(1);
    });

    it.each(["confirmed flag", "payment row"])("preserves the %s when a late capture error re-reads an unpaid order", async (guard) => {
      const started = await approved();
      const request = paypal.client.request.bind(paypal.client);
      let before: Record<string, unknown>[] = [];
      vi.spyOn(paypal.client, "request").mockImplementation(async (method, path, options) => {
        const result = await request(method, path, options);
        if (method === "POST" && path.endsWith("/capture")) {
          await catchLiveSale(db, paypal.client, { captureId: paypal.captures[0].id, now: NOW });
          if (guard === "confirmed flag") {
            await db.query("delete from paypal_payments where shop_id = $1", [shopId]);
          } else {
            await db.query("update order_lines set capture_pending = true where shop_id = $1 and live_sale", [shopId]);
          }
          before = await liveLines();
          paypal.orders.get(started.orderId)!.status = "VOIDED";
          throw new PayPalApiError(422, method, path, "ORDER_NOT_APPROVED");
        }
        return result;
      });
      await expect(finish(stateOf(started), started.orderId)).rejects.toThrow();
      expect(before).toHaveLength(1);
      expect(await liveLines()).toEqual(before);
      expect((await db.query("select 1 from recall_matches where order_line_id = $1", [before[0].id])).rows.length).toBeGreaterThan(0);
    });

    it("releases an unpaid reservation under the sale lock when a failed capture re-reads VOIDED", async () => {
      paypal = fakePayPal({ captureError: (order) => {
        order.status = "VOIDED";
        return new PayPalApiError(422, "POST", "/v2/checkout/orders/x/capture", "ORDER_NOT_APPROVED");
      } });
      const started = await approved();
      const transaction = vi.spyOn(db, "transaction");
      await expect(finish(stateOf(started), started.orderId)).rejects.toThrow();
      expect(await liveLines()).toEqual([]);
      expect(transaction).toHaveBeenCalledTimes(2); // Return reservation, then guarded release.
    });

    it("keeps the sale when it can't find out: the capture may have happened, and its webhook needs the line", async () => {
      paypal = fakePayPal({ failReadAfterCapture: true, captureError: () => new PayPalApiError(500, "POST", "/v2/checkout/orders/x/capture") });
      const started = await approved();
      await expect(finish(stateOf(started), started.orderId)).rejects.toThrow();
      expect(await liveLines()).toHaveLength(1);
    });

    it("never stores the payer's email or name, and a sale here has no address to write to", async () => {
      const started = await approved();
      await finish(stateOf(started), started.orderId);
      await catchLiveSale(db, paypal.client, { captureId: paypal.captures[0].id, now: NOW });
      const lines = await liveLines();
      expect(lines[0].buyer_email_enc).toBeNull();
      for (const table of ["order_lines", "paypal_payments", "recall_matches"]) {
        const { rows } = await db.query(`select * from ${table} where shop_id = $1`, [shopId]);
        const stored = JSON.stringify(rows);
        expect(stored).not.toContain(PAYER_EMAIL);
        expect(stored).not.toContain(PAYER_NAME);
      }
    });

    it("retains an approved reservation when PayPal refuses the capture", async () => {
      paypal = fakePayPal({ failCapture: true });
      const started = await approved();
      await expect(finish(stateOf(started), started.orderId)).rejects.toThrow();
      expect(await liveLines()).toHaveLength(1);
    });
  });

  describe("refusing a return it can't trust", () => {
    const refusesWithoutTouchingAnything = async (attempt: () => Promise<unknown>) => {
      const before = await liveLines();
      await expect(attempt()).rejects.toBeInstanceOf(LiveSaleRefused);
      expect(paypal.captures).toEqual([]);
      expect(await liveLines()).toEqual(before);
    };

    it("a state that was tampered with", async () => {
      const started = await approved();
      const state = stateOf(started);
      await refusesWithoutTouchingAnything(() => finish(`${state.slice(0, -2)}xx`, started.orderId));
      await refusesWithoutTouchingAnything(() => finish("", started.orderId));
    });

    it("another shop's state", async () => {
      const started = await approved();
      const other = await createShop(db, { name: "OTHER", kind: "DEMO" });
      await refusesWithoutTouchingAnything(() => finish(stateOf(started), started.orderId, other));
    });

    it("the same shop in another browser", async () => {
      const started = await approved();
      await refusesWithoutTouchingAnything(() => finish(stateOf(started), started.orderId, shopId, TODAY, "browser-b"));
    });

    it("an order that isn't the one this state started", async () => {
      const first = await approved();
      await expireReservations();
      const second = await approved();
      await refusesWithoutTouchingAnything(() => finish(stateOf(first), second.orderId));
    });

    it("an order nobody approved", async () => {
      const started = await start();
      await refusesWithoutTouchingAnything(() => finish(stateOf(started), started.orderId));
    });

    it("an order for a different amount", async () => {
      const started = await approved();
      const unit = paypal.orders.get(started.orderId)!.purchase_units[0] as { items: { unit_amount: { value: string } }[] };
      unit.items[0].unit_amount.value = "0.01";
      await refusesWithoutTouchingAnything(() => finish(stateOf(started), started.orderId));
    });

    it("an order whose total was discounted below the listed price", async () => {
      const started = await approved();
      const unit = paypal.orders.get(started.orderId)!.purchase_units[0] as { amount: { value: string } };
      unit.amount.value = "0.01";
      await refusesWithoutTouchingAnything(() => finish(stateOf(started), started.orderId));
    });

    it("an order in another currency", async () => {
      const started = await approved();
      const unit = paypal.orders.get(started.orderId)!.purchase_units[0] as { amount: { currency_code: string } };
      unit.amount.currency_code = "EUR";
      await refusesWithoutTouchingAnything(() => finish(stateOf(started), started.orderId));
    });

    it("something that isn't a PayPal id", async () => {
      const started = await approved();
      await refusesWithoutTouchingAnything(() => finish(stateOf(started), "../../v1/oauth2/token"));
    });
  });
});
