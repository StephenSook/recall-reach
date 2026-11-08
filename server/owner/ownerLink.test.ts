import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { testDb } from "../../test/pglite";
import { migrate } from "../db/migrate";
import { createShop } from "../import/store";
import { REFUND_SCOPE } from "../paypal/platform";
import { createRecordKey } from "../privacy/recordKey";
import { reserveStatusRead, saveSellerStatus, startConnection, trackingIdFor } from "../shop/paypalConnection";
import { linkOwner, markOwnerSignedIn, readOwnerLink, shopForOwner, unlinkOwner } from "./ownerLink";

const key = createRecordKey("test-record-key-secret-0123456789abcdef");
const SECRET = "s".repeat(64);
const NOW = new Date("2026-11-08T12:00:00.000Z");

describe("a shop owner's PayPal login", () => {
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
  const link = (shop: string, payerId: string) => linkOwner(db, { shopId: shop, payerId, recordKey: key, now: NOW });

  it("links a real shop to the login, and that login finds the shop again", async () => {
    expect(await link(shopId, "OWNERPAYER12")).toBe("LINKED");
    expect(await shopForOwner(db, { payerId: "OWNERPAYER12", recordKey: key })).toBe(shopId);
    expect(await shopForOwner(db, { payerId: "SOMEONEELSE1", recordKey: key })).toBeNull();
    expect(await readOwnerLink(db, shopId)).toMatchObject({ linkedAt: NOW.toISOString(), isSeller: null, signedInAt: null });
  });

  it("keeps only an HMAC of the PayPal account id", async () => {
    await link(shopId, "OWNERPAYER12");
    const { rows } = await db.query<{ row: string }>("select row_to_json(s)::text as row from shops s");
    expect(rows[0].row).not.toContain("OWNERPAYER12");
  });

  it("lets one PayPal login open one shop only, and says so for a second", async () => {
    const other = await createShop(db, { name: "B SHOP", kind: "REAL" });
    await link(shopId, "OWNERPAYER12");
    expect(await link(shopId, "OWNERPAYER12")).toBe("ALREADY_LINKED");
    expect(await link(other, "OWNERPAYER12")).toBe("LINKED_ELSEWHERE");
    expect(await shopForOwner(db, { payerId: "OWNERPAYER12", recordKey: key })).toBe(shopId);
  });

  it("moves a shop to a new login only by linking that login, and lets the old one go", async () => {
    await link(shopId, "OWNERPAYER12");
    expect(await link(shopId, "NEWOWNER1234")).toBe("LINKED");
    expect(await shopForOwner(db, { payerId: "OWNERPAYER12", recordKey: key })).toBeNull();
    expect(await shopForOwner(db, { payerId: "NEWOWNER1234", recordKey: key })).toBe(shopId);
  });

  it("never links a demo shop", async () => {
    const demo = await createShop(db, { name: "DEMO SHOP", kind: "DEMO" });
    expect(await link(demo, "OWNERPAYER12")).toBe("NOT_A_REAL_SHOP");
    expect(await shopForOwner(db, { payerId: "OWNERPAYER12", recordKey: key })).toBeNull();
  });

  it("records, as a measured fact, whether the login is the PayPal account the shop's refunds go from", async () => {
    await startConnection(db, { shopId, trackingId: trackingIdFor(key, shopId), now: NOW });
    await saveSellerStatus(db, { shopId, read: (await reserveStatusRead(db, shopId))!, status: { merchantId: "SELLERPAYER1", paymentsReceivable: true, primaryEmailConfirmed: true, scopes: [REFUND_SCOPE] }, secret: SECRET, recordKey: key, now: NOW });
    await link(shopId, "SELLERPAYER1");
    expect((await readOwnerLink(db, shopId))?.isSeller).toBe(true);
    await link(shopId, "OWNERPAYER12");
    expect((await readOwnerLink(db, shopId))?.isSeller).toBe(false);
  });

  it("notes each sign-in, and goes on unlink and with the shop", async () => {
    await link(shopId, "OWNERPAYER12");
    await markOwnerSignedIn(db, shopId, NOW);
    expect((await readOwnerLink(db, shopId))?.signedInAt).toBe(NOW.toISOString());
    await unlinkOwner(db, shopId);
    expect(await readOwnerLink(db, shopId)).toBeNull();
    expect(await shopForOwner(db, { payerId: "OWNERPAYER12", recordKey: key })).toBeNull();
    await link(shopId, "OWNERPAYER12");
    await db.query("delete from shops where id = $1", [shopId]);
    expect(await shopForOwner(db, { payerId: "OWNERPAYER12", recordKey: key })).toBeNull();
  });
});
