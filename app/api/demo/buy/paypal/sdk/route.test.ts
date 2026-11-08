import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { testDb } from "@/test/pglite";
import { migrate } from "@/server/db/migrate";
import { createShop } from "@/server/import/store";
import { checkoutState } from "@/server/demo/liveCatch";
import type { PayPalClient, RequestOptions } from "@/server/paypal/client";
import * as orderHelpers from "@/server/paypal/orders";
import { sessionCookie } from "@/server/session/session";
import { POST as create } from "./route";
import { POST as capture } from "./capture/route";
import { POST as hosted } from "../route";
import { GET as returned } from "../return/route";

const SITE = "http://localhost";
const SESSION_SECRET = "s".repeat(32);
const DATA_KEY = "k".repeat(32);
const CLIENT_SECRET = "CLIENT-SECRET-SENTINEL";
let db: Awaited<ReturnType<typeof testDb>>;
let client: PayPalClient;
let cookie: string | undefined;
let shopId: string;
let itemId: string;
let sessionId: string;
const timing = vi.hoisted(() => ({ now: 0 }));
let failCreate = false;
let failCapture = false;

type Body = { intent: string; purchase_units: { invoice_id: string; custom_id: string; amount: unknown; items: unknown }[]; payment_source: { paypal: { experience_context: { return_url: string; cancel_url: string } } } };
const orders = new Map<string, { id: string; status: string; purchase_units: Body["purchase_units"] }>();
const bodies: Body[] = [];
const captures: { path: string; options: RequestOptions }[] = [];

vi.mock("@/server/db/pg", () => ({ getDb: () => db }));
vi.mock("@/server/web/rateLimit", async (original) => {
  const actual = await original<typeof import("@/server/web/rateLimit")>();
  return { ...actual, createRateLimiter: (options: Parameters<typeof actual.createRateLimiter>[0]) => actual.createRateLimiter({ ...options, now: () => timing.now }) };
});
vi.mock("@/server/paypal/client", async (original) => ({ ...await original<typeof import("@/server/paypal/client")>(), payPalClientFromEnv: () => client }));
vi.mock("next/headers", () => ({ cookies: async () => ({ get: () => cookie ? { value: cookie } : undefined }) }));

const request = (path: string, fields: Record<string, string>, origin: string | null = SITE) => new Request(`${SITE}${path}`, {
  method: "POST", headers: origin ? { origin } : {}, body: new URLSearchParams(fields),
});
const createRequest = (fields: Record<string, string> = { shopItemId: itemId }, origin: string | null = SITE) => request("/api/demo/buy/paypal/sdk", fields, origin);
const captureRequest = (fields: Record<string, string>, origin: string | null = SITE) => request("/api/demo/buy/paypal/sdk/capture", fields, origin);
const signIn = (shop = shopId) => {
  const signed = sessionCookie(SESSION_SECRET, shop);
  cookie = signed.value;
  sessionId = signed.sessionId;
};
const start = async () => {
  const response = await create(createRequest());
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toBe("no-store");
  const text = await response.text();
  for (const secret of [CLIENT_SECRET, SESSION_SECRET, DATA_KEY]) expect(text).not.toContain(secret);
  return JSON.parse(text) as { orderId: string; state: string };
};
const approve = (id: string) => { orders.get(id)!.status = "APPROVED"; };
const liveLines = async () => (await db.query("select order_number from order_lines where shop_id = $1 and live_sale", [shopId])).rows;

describe("the v6 shelf checkout routes", () => {
  beforeEach(async () => {
    timing.now += 2 * 60 * 60_000;
    vi.stubEnv("SESSION_SECRET", SESSION_SECRET);
    vi.stubEnv("SHOP_DATA_KEY", DATA_KEY);
    vi.stubEnv("PAYPAL_CLIENT_SECRET", CLIENT_SECRET);
    vi.stubEnv("RENDER_EXTERNAL_URL", "");
    orders.clear(); bodies.length = 0; captures.length = 0;
    failCreate = false; failCapture = false;
    db = await testDb();
    await migrate(db);
    shopId = await createShop(db, { name: "DEMO SHOP", kind: "DEMO" });
    itemId = (await db.query<{ id: string }>("insert into shop_items (shop_id, title, sku, price_cents, currency, source) values ($1, 'Shelf item', 'SHELF-1', 100, 'USD', 'test') returning id", [shopId])).rows[0].id;
    signIn();
    client = {
      request: vi.fn(async (method, path, options = {}) => {
        if (method === "POST" && path === "/v2/checkout/orders") {
          if (failCreate) throw new Error(CLIENT_SECRET);
          const body = options.body as Body;
          bodies.push(body);
          const id = `ORDER-${bodies.length}`;
          orders.set(id, { id, status: "PAYER_ACTION_REQUIRED", purchase_units: body.purchase_units });
          return { status: 201, data: { id, links: [{ rel: "payer-action", href: `https://www.sandbox.paypal.com/checkoutnow?token=${id}` }] } };
        }
        if (path.endsWith("/capture")) {
          if (failCapture) throw new Error(CLIENT_SECRET);
          const id = path.split("/").at(-2)!;
          expect(orders.get(id)?.status).toBe("APPROVED");
          const invoice = orders.get(id)!.purchase_units[0].invoice_id;
          expect((await db.query("select 1 from order_lines where shop_id = $1 and order_number = $2 and live_sale", [shopId, invoice])).rows).toHaveLength(1); // The webhook can arrive before capture returns.
          orders.get(id)!.status = "COMPLETED";
          captures.push({ path, options });
          return { status: 201, data: {} };
        }
        return { status: 200, data: orders.get(path.split("/").at(-1)!) };
      }) as PayPalClient["request"],
    };
  });
  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

  it("sends the hosted path's exact order fields, apart from each sale's fresh number and signed state", async () => {
    const old = await hosted(request("/api/demo/buy/paypal", { shopItemId: itemId }));
    expect(old.status).toBe(303);
    await db.query("update order_lines set imported_at = now() - interval '6 minutes' where shop_id = $1 and live_sale", [shopId]);
    const checkout = await start();
    const [before, after] = bodies;
    const orderNumber = after.purchase_units[0].invoice_id;
    expect(orderNumber).toMatch(/^DEMO-LIVE-[0-9a-f]{12}$/);
    expect(orderNumber).not.toBe(before.purchase_units[0].invoice_id);
    expect(checkout.state).toBe(checkoutState(SESSION_SECRET, shopId, sessionId, itemId, orderNumber));
    expect(after).toEqual({
      ...before,
      purchase_units: [{ ...before.purchase_units[0], invoice_id: orderNumber, custom_id: orderNumber }],
      payment_source: { paypal: { experience_context: {
        ...before.payment_source.paypal.experience_context,
        return_url: `${SITE}/api/demo/buy/paypal/return?state=${encodeURIComponent(checkout.state)}`,
        cancel_url: `${SITE}/api/demo/buy/paypal/return?state=${encodeURIComponent(checkout.state)}&cancelled=1`,
      } } },
    });
    expect(after.purchase_units[0]).toMatchObject({
      amount: { currency_code: "USD", value: "1.00", breakdown: { item_total: { currency_code: "USD", value: "1.00" } } },
      items: [{ name: "Shelf item", sku: "SHELF-1", quantity: "1", unit_amount: { currency_code: "USD", value: "1.00" } }],
    });
    expect(await liveLines()).toHaveLength(2);
    expect(Object.keys(checkout).sort()).toEqual(["orderId", "state"]);
  });

  it("calls the existing capture helper and writes only one sale when repeated", async () => {
    const spy = vi.spyOn(orderHelpers, "captureOrder");
    const checkout = await start();
    approve(checkout.orderId);
    const response = await capture(captureRequest(checkout));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ captured: true });
    expect(spy).toHaveBeenCalledWith(client, checkout.orderId, `capture-${checkout.orderId}`);
    expect(captures).toEqual([{ path: `/v2/checkout/orders/${checkout.orderId}/capture`, options: { requestId: `capture-${checkout.orderId}`, body: {} } }]);
    expect((await capture(captureRequest(checkout))).status).toBe(200);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(await liveLines()).toHaveLength(1);
  });

  it("refuses a second sale at create while allowing the reserved order's capture", async () => {
    const first = await start();
    const response = await create(createRequest());
    expect(response.status).toBe(409);
    expect(await response.text()).toContain("That sale is on its way.");
    approve(first.orderId);
    expect((await capture(captureRequest(first))).status).toBe(200);
    expect(bodies).toHaveLength(1);
    expect(captures).toHaveLength(1);
    expect(await liveLines()).toHaveLength(1);
  });

  it.each([false, true])("the hosted return captures after approval (legacy reservation missing: %s)", async (legacy) => {
    expect((await hosted(request("/api/demo/buy/paypal", { shopItemId: itemId }))).status).toBe(303);
    const url = new URL(bodies[0].payment_source.paypal.experience_context.return_url);
    const orderId = "ORDER-1";
    approve(orderId);
    if (legacy) {
      await db.query("delete from order_lines where shop_id = $1 and live_sale", [shopId]);
    }
    const before = await liveLines();
    url.searchParams.set("token", orderId);
    const response = await returned(new Request(url));
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe(`${SITE}/queue`);
    expect(orders.get(orderId)?.status).toBe("COMPLETED");
    expect(captures).toHaveLength(1);
    expect(await liveLines()).toHaveLength(before.length + (legacy ? 1 : 0));
    expect((await returned(new Request(url))).headers.get("location")).toBe(`${SITE}/queue`);
    expect(captures).toHaveLength(1);
    expect(await liveLines()).toHaveLength(before.length + (legacy ? 1 : 0));
  });

  it("refuses the hosted return when its reservation is missing and a different order holds the shop", async () => {
    const first = await start();
    approve(first.orderId);
    await db.query("delete from order_lines where shop_id = $1 and live_sale", [shopId]);
    await start();
    const before = await liveLines();
    const url = new URL(bodies[0].payment_source.paypal.experience_context.return_url);
    url.searchParams.set("token", first.orderId);
    const response = await returned(new Request(url));
    expect(decodeURIComponent(response.headers.get("location") ?? "")).toContain("That sale is on its way.");
    expect(orders.get(first.orderId)?.status).toBe("APPROVED");
    expect(captures).toEqual([]);
    expect(await liveLines()).toEqual(before);
  });

  it("keeps the signed reservation when cancellation has no token, including a repeat cancel", async () => {
    await start();
    const cancelUrl = bodies[0].payment_source.paypal.experience_context.cancel_url;
    const before = await liveLines();
    expect(before).toHaveLength(1);
    const response = await returned(new Request(cancelUrl));
    expect(decodeURIComponent(response.headers.get("location") ?? "")).toContain("Nothing was cancelled here. If you paid at PayPal, the sale shows on your queue once PayPal confirms it.");
    expect(await liveLines()).toEqual(before);
    await returned(new Request(cancelUrl));
    expect(await liveLines()).toEqual(before);
    expect(captures).toEqual([]);
  });

  it("keeps a captured sale awaiting its webhook when cancellation has no token", async () => {
    const checkout = await start();
    approve(checkout.orderId);
    expect((await capture(captureRequest(checkout))).status).toBe(200);
    const before = (await db.query("select * from order_lines where shop_id = $1 and live_sale", [shopId])).rows;
    expect(before).toEqual([expect.objectContaining({ capture_pending: true })]);
    expect((await db.query("select 1 from paypal_payments where shop_id = $1", [shopId])).rows).toEqual([]);
    const cancelUrl = bodies[0].payment_source.paypal.experience_context.cancel_url;
    expect(new URL(cancelUrl).searchParams.has("token")).toBe(false);
    const response = await returned(new Request(cancelUrl));
    expect(decodeURIComponent(response.headers.get("location") ?? "")).toContain("Nothing was cancelled here. If you paid at PayPal, the sale shows on your queue once PayPal confirms it.");
    expect((await db.query("select * from order_lines where shop_id = $1 and live_sale", [shopId])).rows).toEqual(before);
  });

  it.each(["APPROVED", "COMPLETED", "confirmed without token"])("does not claim nothing sold when cancellation retains a sale (%s)", async (status) => {
    const checkout = await start();
    const url = new URL(bodies[0].payment_source.paypal.experience_context.cancel_url);
    if (status === "confirmed without token") {
      await db.query("update order_lines set capture_pending = false where shop_id = $1 and live_sale", [shopId]);
    } else {
      approve(checkout.orderId);
      if (status === "COMPLETED") expect((await capture(captureRequest(checkout))).status).toBe(200);
      url.searchParams.set("token", checkout.orderId);
    }
    const before = await liveLines();
    const response = await returned(new Request(url));
    const location = decodeURIComponent(response.headers.get("location") ?? "");
    expect(location).toContain("Nothing was cancelled here. If you paid at PayPal, the sale shows on your queue once PayPal confirms it.");
    expect(location).not.toContain("Nothing was sold.");
    expect(await liveLines()).toEqual(before);
  });

  it.each(["missing", "forged", "other session", "other shop"])("refuses a cancellation with %s state", async (kind) => {
    await start();
    const url = new URL(bodies[0].payment_source.paypal.experience_context.cancel_url);
    if (kind === "missing") url.searchParams.delete("state");
    if (kind === "forged") url.searchParams.set("state", `${url.searchParams.get("state")}changed`);
    if (kind === "other session") signIn();
    if (kind === "other shop") signIn(await createShop(db, { name: "OTHER", kind: "DEMO" }));
    const before = await liveLines();
    const calls = vi.mocked(client.request).mock.calls.length;
    const response = await returned(new Request(url));
    expect(decodeURIComponent(response.headers.get("location") ?? "")).toContain("That item can't be bought here.");
    expect(await liveLines()).toEqual(before);
    expect(vi.mocked(client.request).mock.calls).toHaveLength(calls);
  });

  it.each(["unlisted", "other shop", "real shop", "bad id"])("refuses a %s item at creation", async (kind) => {
    if (kind === "unlisted") await db.query("update shop_items set listed = false where id = $1", [itemId]);
    if (kind === "other shop") signIn(await createShop(db, { name: "Other", kind: "DEMO" }));
    if (kind === "real shop") await db.query("update shops set kind = 'REAL' where id = $1", [shopId]);
    if (kind === "bad id") itemId = "bad-id";
    expect((await create(createRequest())).status).toBe(409);
    expect(bodies).toEqual([]);
  });

  it.each(["forged state", "wrong order", "other session", "other shop", "unapproved", "real shop"])("refuses capture with %s", async (kind) => {
    const checkout = await start();
    if (kind !== "unapproved") approve(checkout.orderId);
    if (kind === "forged state") checkout.state += "changed";
    if (kind === "wrong order") {
      await db.query("update order_lines set imported_at = now() - interval '6 minutes' where shop_id = $1 and live_sale", [shopId]);
      checkout.orderId = (await start()).orderId;
    }
    if (kind === "other session") signIn();
    if (kind === "other shop") signIn(await createShop(db, { name: "Other", kind: "DEMO" }));
    if (kind === "real shop") await db.query("update shops set kind = 'REAL' where id = $1", [shopId]);
    const before = await liveLines();
    expect((await capture(captureRequest(checkout))).status).toBe(409);
    expect(captures).toEqual([]);
    expect(await liveLines()).toEqual(before);
  });

  for (const [name, route, makeRequest] of [["create", create, createRequest], ["capture", capture, captureRequest]] as const) {
    describe(name, () => {
      it("requires a session and the site's exact Origin", async () => {
        cookie = undefined;
        expect((await route(makeRequest({}))).status).toBe(401);
        signIn();
        for (const origin of [null, "null", "https://other.example"]) expect((await route(makeRequest({}, origin))).status).toBe(401);
        expect(client.request).not.toHaveBeenCalled();
      });
      it("limits each shop to ten attempts an hour", async () => {
        for (let i = 0; i < 10; i++) expect((await route(makeRequest({}))).status).toBe(409);
        expect((await route(makeRequest({}))).status).toBe(429);
      });
      it("limits all shops together to sixty attempts an hour", async () => {
        for (let i = 0; i < 60; i++) {
          if (i % 10 === 0) signIn(await createShop(db, { name: "Other", kind: "DEMO" }));
          expect((await route(makeRequest({}))).status).toBe(409);
        }
        signIn();
        expect((await route(makeRequest({}))).status).toBe(429);
      });
      it("returns only fixed failure text, with no secrets, even if PayPal's error contains one", async () => {
        const checkout = await start();
        approve(checkout.orderId);
        if (name === "create") await db.query("update order_lines set imported_at = now() - interval '6 minutes' where shop_id = $1 and live_sale", [shopId]);
        failCreate = true; failCapture = true;
        const response = await route(makeRequest(name === "create" ? { shopItemId: itemId } : checkout));
        expect(response.status).toBe(502);
        expect(response.headers.get("cache-control")).toBe("no-store");
        const text = await response.text();
        for (const secret of [CLIENT_SECRET, SESSION_SECRET, DATA_KEY]) expect(text).not.toContain(secret);
      });
    });
  }
});
