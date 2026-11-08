import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { testDb } from "../../test/pglite";
import { migrate } from "../db/migrate";
import { KEPT_SHOP_DAYS, purgeOldOwnShops } from "../import/ownFile";
import { createShop } from "../import/store";
import { linkOwner, markOwnerSignedIn, unlinkOwner } from "../owner/ownerLink";
import { createRecordKey } from "../privacy/recordKey";
import { lifetimeOf, shopLifetime } from "./lifetime";

const key = createRecordKey("test-record-key-secret-0123456789abcdef");
const DAY = 86_400_000;
const JOINED = new Date("2026-03-01T12:00:00Z");

describe("how long a shop's data is kept", () => {
  let db: Awaited<ReturnType<typeof testDb>>;
  let shopId: string;
  beforeEach(async () => {
    db = await testDb();
    await migrate(db);
    shopId = await createShop(db, { name: "A SHOP", kind: "REAL" });
    await db.query("update shops set created_at = $2 where id = $1", [shopId, JOINED.toISOString()]);
  });
  afterEach(async () => {
    await db.close();
  });

  it("is 7 days for a real shop no one has linked, and a year past the last PayPal sign-in for one that is", () => {
    expect(lifetimeOf({ kind: "REAL", createdAt: JOINED, ownerLastAt: null })).toEqual({ deletesAfter: new Date(JOINED.getTime() + 7 * DAY), keptByOwner: false, unkeptDeletesAfter: new Date(JOINED.getTime() + 7 * DAY) });
    const signedIn = new Date(JOINED.getTime() + 30 * DAY);
    expect(lifetimeOf({ kind: "REAL", createdAt: JOINED, ownerLastAt: signedIn }).deletesAfter).toEqual(new Date(signedIn.getTime() + KEPT_SHOP_DAYS * DAY));
    expect(lifetimeOf({ kind: "REAL", createdAt: JOINED, ownerLastAt: signedIn }).keptByOwner).toBe(true);
    expect(lifetimeOf({ kind: "DEMO", createdAt: JOINED, ownerLastAt: null }).keptByOwner).toBe(false);
  });

  it("keeps the shown moment and the purge together for a kept shop, a second either side, across daylight saving", async () => {
    await db.query("set timezone = 'America/New_York'");
    try {
      await linkOwner(db, { shopId, payerId: "OWNERPAYER12", recordKey: key, now: new Date(JOINED.getTime() + DAY) });
      const at = (await shopLifetime(db, shopId))!.deletesAfter;
      expect(await purgeOldOwnShops(db, new Date(at.getTime() - 1_000))).toBe(0);
      expect(await purgeOldOwnShops(db, new Date(at.getTime() + 1_000))).toBe(1);
    } finally {
      await db.query("set timezone = 'UTC'");
    }
  });

  it("moves the date a year past each sign-in, and back to 7 days after joining once unlinked", async () => {
    const linkedAt = new Date(JOINED.getTime() + DAY);
    await linkOwner(db, { shopId, payerId: "OWNERPAYER12", recordKey: key, now: linkedAt });
    const later = new Date(JOINED.getTime() + 200 * DAY);
    await markOwnerSignedIn(db, shopId, later);
    expect((await shopLifetime(db, shopId))!.deletesAfter).toEqual(new Date(later.getTime() + KEPT_SHOP_DAYS * DAY));
    expect(await purgeOldOwnShops(db, new Date(later.getTime() + 300 * DAY))).toBe(0);
    await unlinkOwner(db, shopId);
    expect(await shopLifetime(db, shopId)).toMatchObject({ deletesAfter: new Date(JOINED.getTime() + 7 * DAY), keptByOwner: false });
    expect(await purgeOldOwnShops(db, new Date(later.getTime() + DAY))).toBe(1);
  });

  it("keeps a kept shop's order file with it", async () => {
    await db.query("insert into order_lines (shop_id, order_number, line_no, title, quantity, unit_price_cents, currency, ordered_on, source) values ($1, 'A1', 1, 'x', 1, 100, 'USD', '2026-02-20', 'test')", [shopId]);
    await linkOwner(db, { shopId, payerId: "OWNERPAYER12", recordKey: key, now: new Date(JOINED.getTime() + DAY) });
    await purgeOldOwnShops(db, new Date(JOINED.getTime() + 90 * DAY));
    expect((await db.query("select 1 from order_lines where shop_id = $1", [shopId])).rows).toHaveLength(1);
  });
});
