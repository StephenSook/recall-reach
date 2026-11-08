import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { testDb } from "../../test/pglite";
import { migrate } from "../db/migrate";
import { createShop } from "../import/store";
import { REFUND_SCOPE } from "../paypal/platform";
import { createRecordKey } from "../privacy/recordKey";
import { connectedMerchant, disconnectShop, forgetMerchant, readConnection, recordConnectRefusal, saveSellerStatus, startConnection, trackingIdFor } from "./paypalConnection";

const key = createRecordKey("test-record-key-secret-0123456789abcdef");
const SECRET = "s".repeat(64);
const NOW = new Date("2026-11-08T03:00:00.000Z");
const READY = { merchantId: "SELLERPAYER1", paymentsReceivable: true, primaryEmailConfirmed: true, scopes: [REFUND_SCOPE] };

describe("a shop's PayPal connection", () => {
  let db: Awaited<ReturnType<typeof testDb>>;
  let shopId: string;
  beforeEach(async () => {
    db = await testDb();
    await migrate(db);
    shopId = await createShop(db, { name: "A SHOP", kind: "REAL" });
  });
  afterEach(async () => {
    await db.close();
  });

  it("tracks a shop with an HMAC of its id, never the id itself", () => {
    const t = trackingIdFor(key, shopId);
    expect(t).toMatch(/^[0-9a-f]{40,64}$/);
    expect(t).not.toContain(shopId.replace(/-/g, ""));
    expect(trackingIdFor(key, shopId)).toBe(t);
  });

  it("is nothing until the shop starts, then waiting on PayPal until PayPal's answer says connected", async () => {
    expect(await readConnection(db, { shopId, secret: SECRET })).toBeNull();
    await startConnection(db, { shopId, trackingId: trackingIdFor(key, shopId), now: NOW });
    expect(await readConnection(db, { shopId, secret: SECRET })).toMatchObject({ connected: false, status: null, startedAt: NOW.toISOString() });
    await saveSellerStatus(db, { shopId, status: READY, secret: SECRET, recordKey: key, now: NOW });
    expect(await readConnection(db, { shopId, secret: SECRET })).toMatchObject({ connected: true, status: READY, readAt: NOW.toISOString(), refusal: null });
    expect(await connectedMerchant(db, { shopId, secret: SECRET })).toBe("SELLERPAYER1");
  });

  it("isn't connected when PayPal says payments aren't receivable yet", async () => {
    await startConnection(db, { shopId, trackingId: trackingIdFor(key, shopId), now: NOW });
    await saveSellerStatus(db, { shopId, status: { ...READY, paymentsReceivable: false }, secret: SECRET, recordKey: key, now: NOW });
    expect((await readConnection(db, { shopId, secret: SECRET }))?.connected).toBe(false);
    expect(await connectedMerchant(db, { shopId, secret: SECRET })).toBeNull();
  });

  it("keeps the seller's merchant id encrypted, and findable only by its HMAC", async () => {
    await startConnection(db, { shopId, trackingId: trackingIdFor(key, shopId), now: NOW });
    await saveSellerStatus(db, { shopId, status: READY, secret: SECRET, recordKey: key, now: NOW });
    const { rows } = await db.query<{ row: string }>("select row_to_json(c)::text as row from shop_paypal_connections c");
    expect(rows[0].row).not.toContain("SELLERPAYER1");
  });

  it("keeps PayPal's own words when it refuses", async () => {
    await startConnection(db, { shopId, trackingId: trackingIdFor(key, shopId), now: NOW });
    await recordConnectRefusal(db, { shopId, refusal: "PayPal answered HTTP 422, FEATURES_UNAUTHORIZED (PayPal-Debug-Id f1)" });
    expect((await readConnection(db, { shopId, secret: SECRET }))?.refusal).toBe("PayPal answered HTTP 422, FEATURES_UNAUTHORIZED (PayPal-Debug-Id f1)");
  });

  it("is gone when the shop disconnects, when PayPal says the seller took consent back, and with the shop", async () => {
    const connect = async () => {
      await startConnection(db, { shopId, trackingId: trackingIdFor(key, shopId), now: NOW });
      await saveSellerStatus(db, { shopId, status: READY, secret: SECRET, recordKey: key, now: NOW });
    };
    await connect();
    await disconnectShop(db, shopId);
    expect(await readConnection(db, { shopId, secret: SECRET })).toBeNull();
    await connect();
    await forgetMerchant(db, key("paypal-merchant", "SELLERPAYER1"));
    expect(await readConnection(db, { shopId, secret: SECRET })).toBeNull();
    await connect();
    await db.query("delete from shops where id = $1", [shopId]);
    expect((await db.query("select 1 from shop_paypal_connections")).rows).toHaveLength(0);
  });

  it("is labelled as the shop's own", async () => {
    const { rows } = await db.query<{ c: string }>("select obj_description('shop_paypal_connections'::regclass, 'pg_class') as c");
    expect(rows[0].c).toBe("data-source: shop-owned");
  });
});
