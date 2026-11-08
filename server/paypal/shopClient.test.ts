import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { testDb } from "../../test/pglite";
import { migrate } from "../db/migrate";
import { createShop } from "../import/store";
import { createRecordKey } from "../privacy/recordKey";
import { recordSalesRead, reserveStatusRead, saveSellerStatus, startConnection, trackingIdFor } from "../shop/paypalConnection";
import { REFUND_SCOPE } from "./platform";
import { payPalClientForShop } from "./shopClient";

const key = createRecordKey("test-record-key-secret-0123456789abcdef");
const SECRET = "s".repeat(64);
const NOW = new Date("2026-11-08T03:00:00.000Z");
const ENV = {
  PAYPAL_CLIENT_ID: "own-id",
  PAYPAL_CLIENT_SECRET: "own-secret",
  PAYPAL_PLATFORM_CLIENT_ID: "platform-id",
  PAYPAL_PLATFORM_CLIENT_SECRET: "platform-secret",
  PAYPAL_PARTNER_MERCHANT_ID: "PARTNER12345",
  SHOP_DATA_KEY: SECRET,
} as unknown as NodeJS.ProcessEnv;

describe("which PayPal account a shop's refunds go from", () => {
  let db: Awaited<ReturnType<typeof testDb>>;
  let shopId: string;
  const seen: Headers[] = [];
  beforeEach(async () => {
    db = await testDb();
    await migrate(db);
    shopId = await createShop(db, { name: "A SHOP", kind: "REAL" });
    seen.length = 0;
    vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
      if (String(url).endsWith("/v1/oauth2/token")) return Response.json({ access_token: "t", expires_in: 3600 });
      seen.push(new Headers(init?.headers));
      return Response.json({});
    });
  });
  afterEach(async () => {
    vi.unstubAllGlobals();
    await db.close();
  });

  const connect = async (status = { merchantId: "SELLERPAYER1", paymentsReceivable: true, primaryEmailConfirmed: true, scopes: [REFUND_SCOPE] }) => {
    await startConnection(db, { shopId, trackingId: trackingIdFor(key, shopId), now: NOW });
    await saveSellerStatus(db, { shopId, read: (await reserveStatusRead(db, shopId))!, status, secret: SECRET, recordKey: key, now: NOW });
    await recordSalesRead(db, { shopId, complete: true, now: NOW });
  };

  it("acts for a connected shop, with PayPal-Auth-Assertion naming its seller on every call", async () => {
    await connect();
    const chosen = await payPalClientForShop(db, shopId, ENV);
    expect(chosen.actingForShop).toBe(true);
    await chosen.client!.request("GET", "/v2/payments/captures/CAP1");
    const assertion = seen[0].get("paypal-auth-assertion") ?? "";
    expect(JSON.parse(Buffer.from(assertion.split(".")[1], "base64url").toString())).toEqual({ iss: "platform-id", payer_id: "SELLERPAYER1" });
  });

  it("gives a real shop no PayPal account at all until PayPal says it's connected, never the demo's", async () => {
    expect(await payPalClientForShop(db, shopId, ENV)).toEqual({ client: null, actingForShop: false, refused: "NOT_CONNECTED" });
    await connect({ merchantId: "SELLERPAYER1", paymentsReceivable: false, primaryEmailConfirmed: true, scopes: [REFUND_SCOPE] });
    expect(await payPalClientForShop(db, shopId, ENV)).toEqual({ client: null, actingForShop: false, refused: "NOT_CONNECTED" });
  });

  it("refuses refunds from a connected shop until its latest sales read covered everything", async () => {
    await connect();
    await recordSalesRead(db, { shopId, complete: false, now: NOW });
    expect(await payPalClientForShop(db, shopId, ENV)).toEqual({ client: null, actingForShop: false, refused: "SALES_INCOMPLETE" });
    await recordSalesRead(db, { shopId, complete: true, now: NOW });
    expect((await payPalClientForShop(db, shopId, ENV)).actingForShop).toBe(true);
  });

  it("gives a real shop no PayPal account when the platform app isn't set up here", async () => {
    await connect();
    const env = { ...ENV, PAYPAL_PLATFORM_CLIENT_ID: undefined } as unknown as NodeJS.ProcessEnv;
    expect(await payPalClientForShop(db, shopId, env)).toEqual({ client: null, actingForShop: false, refused: "NOT_CONNECTED" });
  });

  it("gives a demo shop the demo's own sandbox account", async () => {
    const demo = await createShop(db, { name: "DEMO SHOP", kind: "DEMO" });
    const chosen = await payPalClientForShop(db, demo, ENV);
    expect(chosen.actingForShop).toBe(false);
    expect(chosen.client).not.toBeNull();
  });
});
