import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { testDb } from "../../test/pglite";
import { migrate } from "../db/migrate";
import { createShop } from "../import/store";
import { REFUND_SCOPE, type SellerStatus } from "../paypal/platform";
import { createRecordKey } from "../privacy/recordKey";
import {
  clearSellerStatus,
  connectedMerchant,
  disconnectShop,
  forgetAfterRead,
  readConnection,
  recordConnectRefusal,
  reserveStatusRead,
  saveSellerStatus,
  shopsLinkedTo,
  startConnection,
  trackingIdFor,
} from "./paypalConnection";

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

  const start = () => startConnection(db, { shopId, trackingId: trackingIdFor(key, shopId), now: NOW });
  const reserve = async () => (await reserveStatusRead(db, shopId))!;
  const save = async (status: SellerStatus = READY, read?: Awaited<ReturnType<typeof reserve>>) =>
    saveSellerStatus(db, { shopId, read: read ?? (await reserve()), status, secret: SECRET, recordKey: key, now: NOW });
  const connected = async () => (await readConnection(db, { shopId, secret: SECRET }))?.connected ?? false;

  it("tracks a shop with an HMAC of its id, never the id itself", () => {
    const t = trackingIdFor(key, shopId);
    expect(t).toMatch(/^[0-9a-f]{40,64}$/);
    expect(t).not.toContain(shopId.replace(/-/g, ""));
    expect(trackingIdFor(key, shopId)).toBe(t);
  });

  it("is nothing until the shop starts, then waiting on PayPal until PayPal's answer says connected", async () => {
    expect(await readConnection(db, { shopId, secret: SECRET })).toBeNull();
    expect(await reserveStatusRead(db, shopId)).toBeNull();
    await start();
    expect(await readConnection(db, { shopId, secret: SECRET })).toMatchObject({ connected: false, status: null, startedAt: NOW.toISOString() });
    expect(await save()).toBe(true);
    expect(await readConnection(db, { shopId, secret: SECRET })).toMatchObject({ connected: true, status: READY, readAt: NOW.toISOString(), refusal: null });
    expect(await connectedMerchant(db, { shopId, secret: SECRET })).toBe("SELLERPAYER1");
  });

  it("isn't connected when PayPal says payments aren't receivable yet", async () => {
    await start();
    await save({ ...READY, paymentsReceivable: false });
    expect(await connected()).toBe(false);
    expect(await connectedMerchant(db, { shopId, secret: SECRET })).toBeNull();
  });

  it("keeps the seller's merchant id encrypted, and findable only by its HMAC", async () => {
    await start();
    await save();
    const { rows } = await db.query<{ row: string }>("select row_to_json(c)::text as row from shop_paypal_connections c");
    expect(rows[0].row).not.toContain("SELLERPAYER1");
  });

  it("keeps PayPal's own words when it refuses", async () => {
    await start();
    await recordConnectRefusal(db, { shopId, refusal: "PayPal answered HTTP 422, FEATURES_UNAUTHORIZED (PayPal-Debug-Id f1)" });
    expect((await readConnection(db, { shopId, secret: SECRET }))?.refusal).toBe("PayPal answered HTTP 422, FEATURES_UNAUTHORIZED (PayPal-Debug-Id f1)");
  });

  it("is gone when the shop disconnects, and with the shop", async () => {
    await start();
    await save();
    await disconnectShop(db, shopId);
    expect(await readConnection(db, { shopId, secret: SECRET })).toBeNull();
    await start();
    await save();
    await db.query("delete from shops where id = $1", [shopId]);
    expect((await db.query("select 1 from shop_paypal_connections")).rows).toHaveLength(0);
  });

  it("finds the shops linked to a seller by the HMAC of its merchant id only", async () => {
    await start();
    await save();
    expect(await shopsLinkedTo(db, key("paypal-merchant", "SELLERPAYER1"))).toEqual([{ shopId, trackingId: trackingIdFor(key, shopId) }]);
    expect(await shopsLinkedTo(db, key("paypal-merchant", "OTHERSELLER9"))).toEqual([]);
  });

  describe("when checks overlap", () => {
    it("keeps the answer asked last, whichever lands first, even within one millisecond", async () => {
      await start();
      const first = await reserve();
      const second = await reserve();
      expect(await clearSellerStatus(db, { shopId, read: second, now: NOW })).toBe(true);
      expect(await save(READY, first)).toBe(false);
      expect(await connected()).toBe(false);

      const third = await reserve();
      const fourth = await reserve();
      expect(await save(READY, fourth)).toBe(true);
      expect(await clearSellerStatus(db, { shopId, read: third, now: NOW })).toBe(false);
      expect(await connected()).toBe(true);
    });

    it("lets no read from before a reconnect write to the new attempt, even after a delete and a fresh row", async () => {
      await start();
      const stale = await reserve();
      await disconnectShop(db, shopId);
      await start();
      expect(await save(READY, stale)).toBe(false);
      expect(await connectedMerchant(db, { shopId, secret: SECRET })).toBeNull();

      const old = await reserve();
      await start();
      expect(await save(READY, old)).toBe(false);
      expect(await connected()).toBe(false);
    });

    it("forgets after a read only while it's the same attempt and seller, and no later read has landed", async () => {
      const seller = key("paypal-merchant", "SELLERPAYER1");
      await start();
      await save();
      const revoke = await reserve();
      await save();
      expect(await forgetAfterRead(db, { shopId, read: revoke, merchantIdHmac: seller })).toBe(false);
      expect(await connected()).toBe(true);

      const wrongSeller = await reserve();
      expect(await forgetAfterRead(db, { shopId, read: wrongSeller, merchantIdHmac: key("paypal-merchant", "OTHERSELLER9") })).toBe(false);
      expect(await clearSellerStatus(db, { shopId, read: await reserve(), now: NOW, merchantIdHmac: key("paypal-merchant", "OTHERSELLER9") })).toBe(false);
      expect(await connected()).toBe(true);

      expect(await forgetAfterRead(db, { shopId, read: await reserve(), merchantIdHmac: seller })).toBe(true);
      expect(await readConnection(db, { shopId, secret: SECRET })).toBeNull();
    });
  });

  it("is labelled as the shop's own", async () => {
    const { rows } = await db.query<{ c: string }>("select obj_description('shop_paypal_connections'::regclass, 'pg_class') as c");
    expect(rows[0].c).toBe("data-source: shop-owned");
  });
});
