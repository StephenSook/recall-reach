import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { answerSearch } from "../../test/fakeHistory";
import { testDb } from "../../test/pglite";
import { pullRecalls } from "../cpsc/pull";
import { migrate } from "../db/migrate";
import { createShop } from "../import/store";
import { PayPalApiError, type Method, type PayPalClient, type RequestOptions } from "../paypal/client";
import { loadQueue } from "../queue/queue";
import { catchLiveSale, finishPayPalBuy, LiveSaleRefused, startPayPalBuy } from "./liveCatch";
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
function fakePayPal(over: { approveHost?: string; failCapture?: boolean; firstOrder?: number; captureError?: (order: FakeOrder) => Error; failReadAfterCapture?: boolean } = {}) {
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

  describe("sending the buyer to PayPal", () => {
    it("asks for a PayPal payment that needs a person, with no card and no shipping", async () => {
      const started = await start();
      const body = paypal.bodies[0] as { intent: string; purchase_units: { invoice_id: string }[]; payment_source: { card?: unknown; paypal: { experience_context: Record<string, string> } } };
      expect(body.intent).toBe("CAPTURE");
      expect(body.payment_source.card).toBeUndefined();
      expect(body.payment_source.paypal.experience_context).toMatchObject({ user_action: "PAY_NOW", shipping_preference: "NO_SHIPPING" });
      expect(body.payment_source.paypal.experience_context.return_url).toBe(started.returnUrl);
      expect(body.payment_source.paypal.experience_context.cancel_url).toBe(`${SITE}/api/demo/buy/paypal/return?cancelled=1`);
      expect(body.purchase_units[0].invoice_id).toMatch(/^DEMO-LIVE-[0-9a-f]{12}$/);
    });

    it("gives PayPal's own approval page, on the sandbox", async () => {
      const { approveUrl, orderId } = await start();
      expect(approveUrl).toBe(`https://www.sandbox.paypal.com/checkoutnow?token=${orderId}`);
    });

    it.each(["www.paypal.com", "evil.example"])("won't send anyone to %s", async (approveHost) => {
      await expect(start(fakePayPal({ approveHost }).client)).rejects.toThrow(/sandbox/);
    });

    it("writes nothing and captures nothing yet: the buyer may never come back", async () => {
      await start();
      expect(await liveLines()).toEqual([]);
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

    it("removes the sale when PayPal gave no clear answer and the order still isn't paid", async () => {
      paypal = fakePayPal({ captureError: () => {
        const err = new PayPalApiError(500, "POST", "/v2/checkout/orders/x/capture");
        err.uncertain = true;
        return err;
      } });
      const started = await approved();
      await expect(finish(stateOf(started), started.orderId)).rejects.toThrow();
      expect(await liveLines()).toEqual([]);
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

    it("leaves nothing behind if the capture fails", async () => {
      paypal = fakePayPal({ failCapture: true });
      const started = await approved();
      await expect(finish(stateOf(started), started.orderId)).rejects.toThrow();
      expect(await liveLines()).toEqual([]);
    });
  });

  describe("refusing a return it can't trust", () => {
    const refusesWithoutTouchingAnything = async (attempt: () => Promise<unknown>) => {
      await expect(attempt()).rejects.toBeInstanceOf(LiveSaleRefused);
      expect(paypal.captures).toEqual([]);
      expect(await liveLines()).toEqual([]);
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
