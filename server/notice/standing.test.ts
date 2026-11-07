import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { testDb } from "../../test/pglite";
import { pullRecalls } from "../cpsc/pull";
import { migrate } from "../db/migrate";
import type { ImportedOrderLine } from "../import/shopExport";
import { createShop, storeOrderLines } from "../import/store";
import { runShopCheck } from "../match/run";
import { createContactCipher } from "../privacy/contactCipher";
import { loadQueue } from "../queue/queue";
import { prepareStandingNotices, standingRecalls, StandingRefused, turnOffStanding, turnOnStanding } from "./standing";
import { composeForSeller, markSent, NoticeRefused, prepareNotice, prepareSecondNotice } from "./store";

const fixtureText = readFileSync(new URL("../../test/fixtures/cpsc/recalls_2026-10-01_to_2026-11-05.json", import.meta.url), "utf8");
const TODAY = "2026-11-06";
const SECRET = "k".repeat(32);

const line = (over: Partial<ImportedOrderLine>): ImportedOrderLine => ({
  orderNumber: "#N1",
  lineNo: 1,
  title: "Baby Brezza SuperFast Sterilizer Dryer BRZ0083",
  sku: null,
  quantity: 1,
  unitPriceCents: 9000,
  discountCents: 0,
  currency: "USD",
  orderedOn: "2026-09-15",
  paymentReference: null,
  buyerEmail: null,
  ...over,
});

describe("what a shop can turn on for one recall, and the second notice", () => {
  let db: Awaited<ReturnType<typeof testDb>>;
  let shopId: string;
  const cipher = () => createContactCipher(SECRET, shopId);
  beforeEach(async () => {
    db = await testDb();
    await migrate(db);
    const fetchImpl = async () => new Response(fixtureText, { status: 200, headers: { "content-type": "application/json" } });
    await pullRecalls(db, { field: "RecallDate", start: "2026-10-01", end: "2026-11-05" }, { fetchImpl: fetchImpl as typeof fetch });
    shopId = await createShop(db, { name: "A SHOP", kind: "REAL" });
  });
  afterEach(async () => {
    await db.close();
  });

  const addSales = async (...lines: ImportedOrderLine[]) => {
    await storeOrderLines(db, shopId, lines, cipher(), "test");
    await runShopCheck(db, shopId, { today: TODAY, paypalSearched: true });
    await prepareStandingNotices(db, shopId);
  };
  const noticesFor = async (recallNumber: string) =>
    (await db.query<{ kind: string; sent_at: unknown }>("select n.kind, n.sent_at from notices n join recall_matches m on m.id = n.match_id join recalls r using (recall_id) where n.shop_id = $1 and r.recall_number = $2", [shopId, recallNumber])).rows;
  const code = (p: Promise<unknown>) => p.then(() => "no refusal", (err: unknown) => (err instanceof StandingRefused || err instanceof NoticeRefused ? err.code : `other: ${String(err)}`));

  describe("preparing every notice for one recall", () => {
    it("needs the recall number typed exactly", async () => {
      await addSales(line({}));
      expect(await code(turnOnStanding(db, { shopId, recallNumber: "27072", typed: "27071" }))).toBe("TYPED_WRONG");
      expect(await code(turnOnStanding(db, { shopId, recallNumber: "27072", typed: "" }))).toBe("TYPED_WRONG");
      expect(await standingRecalls(db, shopId)).toEqual([]);
      expect(await noticesFor("27072")).toEqual([]);
    });

    it("prepares the notices for sales read as a match, and sends none of them", async () => {
      await addSales(line({}), line({ orderNumber: "#N2" }));
      await turnOnStanding(db, { shopId, recallNumber: "27072", typed: " 27072 " });
      expect(await standingRecalls(db, shopId)).toEqual(["27072"]);
      const notices = await noticesFor("27072");
      expect(notices).toHaveLength(2);
      for (const n of notices) expect(n).toMatchObject({ kind: "SAFETY_NOTICE", sent_at: null });
    });

    it("prepares one for a new sale that matches, and leaves it unsent", async () => {
      await addSales(line({}));
      await turnOnStanding(db, { shopId, recallNumber: "27072", typed: "27072" });
      await addSales(line({ orderNumber: "#N3" }));
      expect(await noticesFor("27072")).toHaveLength(2);
    });

    it("leaves a sale it can't tell about to ask the owner, even on the same recall", async () => {
      await addSales(line({}), line({ orderNumber: "#N4", title: "Baby Brezza SuperFast Sterilizer Dryer" }));
      await turnOnStanding(db, { shopId, recallNumber: "27072", typed: "27072" });
      const notices = await noticesFor("27072");
      expect(notices).toHaveLength(1);
      expect(notices[0].kind).toBe("SAFETY_NOTICE");
    });

    it("refuses a recall with no sale read as a match, since it would do nothing", async () => {
      await addSales(line({ title: "Baby Brezza SuperFast Sterilizer Dryer" }));
      expect(await code(turnOnStanding(db, { shopId, recallNumber: "27072", typed: "27072" }))).toBe("NOTHING_TO_PREPARE");
    });

    it("stops when turned off: what's prepared stays, and new sales wait for the owner", async () => {
      await addSales(line({}));
      await turnOnStanding(db, { shopId, recallNumber: "27072", typed: "27072" });
      await turnOffStanding(db, { shopId, recallNumber: "27072" });
      expect(await standingRecalls(db, shopId)).toEqual([]);
      await addSales(line({ orderNumber: "#N5" }));
      expect(await noticesFor("27072")).toHaveLength(1);
    });

    it("is this shop's own: another shop's setting prepares nothing here", async () => {
      await addSales(line({}));
      await turnOnStanding(db, { shopId, recallNumber: "27072", typed: "27072" });
      const other = await createShop(db, { name: "OTHER", kind: "REAL" });
      await storeOrderLines(db, other, [line({})], createContactCipher(SECRET, other), "test");
      await runShopCheck(db, other, { today: TODAY, paypalSearched: true });
      await prepareStandingNotices(db, other);
      const { rows } = await db.query("select 1 from notices where shop_id = $1", [other]);
      expect(rows).toEqual([]);
    });

    it("touches no refund", async () => {
      await addSales(line({}));
      await turnOnStanding(db, { shopId, recallNumber: "27072", typed: "27072" });
      expect((await db.query("select 1 from approvals")).rows).toEqual([]);
      expect((await db.query("select 1 from refunds")).rows).toEqual([]);
    });
  });

  describe("a second notice", () => {
    const sentNotice = async (shop = shopId) => {
      const { rows } = await db.query<{ id: string }>("select m.id from recall_matches m join recalls r using (recall_id) where m.shop_id = $1 and r.recall_number = '27072'", [shop]);
      const { noticeId } = await prepareNotice(db, { shopId: shop, matchId: rows[0].id });
      await markSent(db, { shopId: shop, noticeId });
      return noticeId;
    };
    const age = (noticeId: string, days: number) => db.query("update notices set sent_at = now() - make_interval(days => $2) where id = $1", [noticeId, days]);
    const compose = (noticeId: string) => composeForSeller(db, { shopId, noticeId, baseUrl: "https://example.test", tokenSecret: SECRET, cipher: cipher() });
    const noticeRow = async () => (await loadQueue(db, shopId, "s")).rows.find((r) => r.recallNumber === "27072")?.notice;

    it("isn't offered or allowed before 3 days", async () => {
      await addSales(line({}));
      const id = await sentNotice();
      await age(id, 2);
      expect((await noticeRow())?.secondDue).toBe(false);
      expect(await code(prepareSecondNotice(db, { shopId, noticeId: id }))).toBe("NOT_DUE");
    });

    it("is offered after 3 days with no answer, with how long it's been", async () => {
      await addSales(line({}));
      const id = await sentNotice();
      await age(id, 4);
      expect(await noticeRow()).toMatchObject({ secondDue: true, daysSinceSent: 4, secondPrepared: false });
    });

    it("once prepared, carries the same words under a subject that says so, and sends nothing itself", async () => {
      await addSales(line({}));
      const id = await sentNotice();
      const first = await compose(id);
      await age(id, 3);
      await prepareSecondNotice(db, { shopId, noticeId: id });
      const second = await compose(id);
      expect(second.subject).toBe(`Second notice: ${first.subject}`);
      expect(second.body).toBe(first.body);
      expect(await noticeRow()).toMatchObject({ secondDue: false, secondPrepared: true, state: "MARKED_SENT" });
    });

    it("isn't offered once the family has answered", async () => {
      await addSales(line({}));
      const id = await sentNotice();
      await age(id, 5);
      await db.query("update notices set responded_at = now() where id = $1", [id]);
      expect((await noticeRow())?.secondDue).toBe(false);
      expect(await code(prepareSecondNotice(db, { shopId, noticeId: id }))).toBe("NOT_DUE");
    });

    it("isn't offered on a demo shop, whatever the clock says", async () => {
      await db.query("update shops set kind = 'DEMO' where id = $1", [shopId]);
      await addSales(line({}));
      const id = await sentNotice();
      await age(id, 5);
      expect((await noticeRow())?.secondDue).toBe(false);
      expect(await code(prepareSecondNotice(db, { shopId, noticeId: id }))).toBe("NOT_DUE");
    });

    it("another shop can't prepare it", async () => {
      await addSales(line({}));
      const id = await sentNotice();
      await age(id, 5);
      const other = await createShop(db, { name: "OTHER", kind: "REAL" });
      expect(await code(prepareSecondNotice(db, { shopId: other, noticeId: id }))).toBe("NOT_DUE");
    });
  });
});
