import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { testDb } from "../../test/pglite";
import { migrate } from "../db/migrate";
import { createShop } from "../import/store";
import { createRecordKey } from "../privacy/recordKey";
import { reserveStatusRead, saveSellerStatus, startConnection, trackingIdFor } from "../shop/paypalConnection";
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
  };

  it("acts for a connected shop, with PayPal-Auth-Assertion naming its seller on every call", async () => {
    await connect();
    const chosen = await payPalClientForShop(db, shopId, ENV);
    expect(chosen.actingForShop).toBe(true);
    await chosen.client.request("GET", "/v2/payments/captures/CAP1");
    const assertion = seen[0].get("paypal-auth-assertion") ?? "";
    expect(JSON.parse(Buffer.from(assertion.split(".")[1], "base64url").toString())).toEqual({ iss: "platform-id", payer_id: "SELLERPAYER1" });
  });

  it("uses the platform's own account for a shop that isn't connected, or whose last answer wasn't connected", async () => {
    expect((await payPalClientForShop(db, shopId, ENV)).actingForShop).toBe(false);
    await connect({ merchantId: "SELLERPAYER1", paymentsReceivable: false, primaryEmailConfirmed: true, scopes: [REFUND_SCOPE] });
    expect((await payPalClientForShop(db, shopId, ENV)).actingForShop).toBe(false);
  });

  it("uses the platform's own account when the platform app isn't set up here", async () => {
    await connect();
    const env = { ...ENV, PAYPAL_PLATFORM_CLIENT_ID: undefined } as unknown as NodeJS.ProcessEnv;
    expect((await payPalClientForShop(db, shopId, env)).actingForShop).toBe(false);
  });
});
