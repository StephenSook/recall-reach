import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { testDb } from "../../test/pglite";
import { pullRecalls } from "../cpsc/pull";
import { migrate } from "../db/migrate";
import type { ImportedOrderLine } from "../import/shopExport";
import { createShop, storeOrderLines } from "../import/store";
import { runShopCheck } from "../match/run";
import { createContactCipher } from "../privacy/contactCipher";
import { checkResult, composeForSeller, familyView, markOpened, markSent, noticeState, NoticeRefused, prepareNotice, recordFamilyAnswer, recordFamilyStopped } from "./store";

const fixtureText = readFileSync(new URL("../../test/fixtures/cpsc/recalls_2026-10-01_to_2026-11-05.json", import.meta.url), "utf8");
const TODAY = "2026-11-06";
const SECRET = "k".repeat(32);
const BASE = "https://example.test";

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

describe("notices", () => {
  let db: Awaited<ReturnType<typeof testDb>>;
  let shopId: string;
  const cipher = () => createContactCipher(SECRET, shopId);
  beforeEach(async () => {
    db = await testDb();
    await migrate(db);
    const fetchImpl = async () => new Response(fixtureText, { status: 200, headers: { "content-type": "application/json" } });
    await pullRecalls(db, { field: "RecallDate", start: "2026-10-01", end: "2026-11-05" }, { fetchImpl: fetchImpl as typeof fetch });
    shopId = await createShop(db, { name: "DEMO SHOP", kind: "DEMO" });
  });
  afterEach(async () => {
    await db.close();
  });

  async function matchFor(recallNumber: string, l: ImportedOrderLine) {
    await storeOrderLines(db, shopId, [l], cipher(), "test");
    await runShopCheck(db, shopId, { today: TODAY, paypalSearched: true });
    const { rows } = await db.query<{ id: string }>(
      `select m.id from recall_matches m join recalls r using (recall_id) where m.shop_id = $1 and r.recall_number = $2`,
      [shopId, recallNumber],
    );
    return rows[0].id;
  }
  const refusal = (p: Promise<unknown>) =>
    p.then(
      () => "no refusal",
      (e: unknown) => (e instanceof NoticeRefused ? e.code : `other: ${String(e)}`),
    );
  const compose = (noticeId: string) => composeForSeller(db, { shopId, noticeId, baseUrl: BASE, tokenSecret: SECRET, cipher: cipher() });

  it("prepares a safety notice for a MATCH and a check request for a SCOPE_GAP", async () => {
    const m = await matchFor("27072", line({}));
    const n = await prepareNotice(db, { shopId, matchId: m });
    expect(n.kind).toBe("SAFETY_NOTICE");
    const gap = await matchFor("27040", line({ orderNumber: "#G1", title: "Costway high chair" }));
    expect((await prepareNotice(db, { shopId, matchId: gap })).kind).toBe("CHECK_REQUEST");
  });

  it("is idempotent: approving twice is one notice", async () => {
    const m = await matchFor("27072", line({}));
    const a = await prepareNotice(db, { shopId, matchId: m });
    const b = await prepareNotice(db, { shopId, matchId: m });
    expect(b.noticeId).toBe(a.noticeId);
  });

  it("refuses all outreach while the join is ambiguous: that could be the wrong family", async () => {
    const m = await matchFor("27072", line({}));
    await db.query("update recall_matches set join_state = 'AMBIGUOUS_JOIN' where id = $1", [m]);
    expect(await refusal(prepareNotice(db, { shopId, matchId: m }))).toBe("TWO_POSSIBLE_ORDERS");
  });

  it("refuses a cleared match, another shop's match, and a listing with no buyer", async () => {
    const cleared = await matchFor("27072", line({ title: "Baby Brezza Formula Pro Advanced" }));
    expect(await refusal(prepareNotice(db, { shopId, matchId: cleared }))).toBe("NOTHING_TO_SEND");
    const other = await createShop(db, { name: "OTHER", kind: "DEMO" });
    expect(await refusal(prepareNotice(db, { shopId: other, matchId: cleared }))).toBe("NO_SUCH_MATCH");
    expect(await refusal(prepareNotice(db, { shopId, matchId: "not-a-uuid" }))).toBe("NO_SUCH_MATCH");
    await db.query(`insert into shop_items (shop_id, title, description, source) values ($1, 'Baby Brezza sterilizer', 'BRZ0154', 't')`, [shopId]);
    await runShopCheck(db, shopId, { today: TODAY, paypalSearched: true });
    const { rows } = await db.query<{ id: string }>("select id from recall_matches where shop_item_id is not null");
    expect(await refusal(prepareNotice(db, { shopId, matchId: rows[0].id }))).toBe("NOTHING_TO_SEND");
  });

  it("moves through the states the seller sees", async () => {
    const m = await matchFor("27072", line({}));
    const { noticeId } = await prepareNotice(db, { shopId, matchId: m });
    const state = async () => noticeState((await db.query<Parameters<typeof noticeState>[0]>("select * from notices where id = $1", [noticeId])).rows[0]);
    expect(await state()).toBe("PREPARED");
    await markOpened(db, { shopId, noticeId });
    expect(await state()).toBe("OPENED_IN_MAIL");
    await markSent(db, { shopId, noticeId });
    expect(await state()).toBe("MARKED_SENT");
    await recordFamilyStopped(db, noticeId);
    expect(await state()).toBe("FAMILY_RESPONDED");
  });

  it("another shop cannot move a notice", async () => {
    const m = await matchFor("27072", line({}));
    const { noticeId } = await prepareNotice(db, { shopId, matchId: m });
    const other = await createShop(db, { name: "OTHER", kind: "DEMO" });
    expect(await refusal(markOpened(db, { shopId: other, noticeId }))).toBe("NO_SUCH_NOTICE");
  });

  describe("composing for the seller", () => {
    it("addresses it from the shop's own record, labelled, and decrypts only here", async () => {
      const m = await matchFor("27072", line({ buyerEmail: "test-buyer@example.test" }));
      const { noticeId } = await prepareNotice(db, { shopId, matchId: m });
      const c = await compose(noticeId);
      expect(c).toMatchObject({ to: "test-buyer@example.test", toSource: "Shop record" });
      expect(c.subject).toBe("Safety recall: SuperFast Sterilizer Dryers you bought from DEMO SHOP on 2026-09-15");
      expect(c.body).toContain(`${BASE}/r/${noticeId}.`);
    });

    it("leaves the address empty for the seller when the shop's file has none", async () => {
      const m = await matchFor("27072", line({}));
      const { noticeId } = await prepareNotice(db, { shopId, matchId: m });
      expect(await compose(noticeId)).toMatchObject({ to: null, toSource: "You add the address" });
    });

    it("never uses a PayPal payer email, because the code never reads one", async () => {
      const m = await matchFor("27072", line({}));
      await db.query(
        `insert into paypal_payments (shop_id, order_id, order_number, items) values ($1, 'O', '#N1', $2::jsonb)`,
        [shopId, JSON.stringify([{ name: "x", sku: null, payer_email: "paypal-payer@example.test" }])],
      );
      const { noticeId } = await prepareNotice(db, { shopId, matchId: m });
      expect(JSON.stringify(await compose(noticeId))).not.toContain("paypal-payer");
    });

    it("carries the recall-specific question on a check request", async () => {
      const m = await matchFor("27040", line({ orderNumber: "#G1", title: "Costway high chair" }));
      const { noticeId } = await prepareNotice(db, { shopId, matchId: m });
      expect((await compose(noticeId)).body).toContain("Can you check one thing? Does your high chair convert into a table and chair set?");
    });

    it("adds the refund line only after the ledger says PayPal confirmed it", async () => {
      const m = await matchFor("27072", line({}));
      const { noticeId } = await prepareNotice(db, { shopId, matchId: m });
      const { rows } = await db.query<{ order_line_id: string; recall_id: number; recall_sha256: string }>(
        "select order_line_id, recall_id, recall_sha256 from recall_matches where id = $1",
        [m],
      );
      const r = rows[0];
      const approval = await db.query<{ id: string }>(
        `insert into approvals (shop_id, session_id, recall_id, recall_sha256, order_line_id, amount_cents, currency, expires_at)
         values ($1, 's', $2, $3, $4, 9000, 'USD', now()) returning id`,
        [shopId, r.recall_id, r.recall_sha256, r.order_line_id],
      );
      const addRefund = (status: string) =>
        db.query(
          `insert into refunds (approval_id, shop_id, order_line_id, amount_cents, currency, status) values ($1, $2, $3, 9000, 'USD', $4)
           on conflict (approval_id) do update set status = excluded.status`,
          [approval.rows[0].id, shopId, r.order_line_id, status],
        );
      await addRefund("pending");
      expect((await compose(noticeId)).body).not.toContain("PayPal confirmed");
      await addRefund("refunded");
      expect((await compose(noticeId)).body).toContain("PayPal confirmed a refund of 90.00 USD to your original payment.");
    });

    it("refuses to compose once the join turned ambiguous", async () => {
      const m = await matchFor("27072", line({}));
      const { noticeId } = await prepareNotice(db, { shopId, matchId: m });
      await db.query("update recall_matches set join_state = 'AMBIGUOUS_JOIN' where id = $1", [m]);
      expect(await refusal(compose(noticeId))).toBe("TWO_POSSIBLE_ORDERS");
    });
  });

  describe("the family's answer", () => {
    it("a yes matches, a no does not, and not sure cannot tell", () => {
      const full = { description: "A full record." };
      const q = { question: "Q", kind: "yes_no" as const };
      expect(checkResult(full, q, "yes")).toBe("MATCHES");
      expect(checkResult(full, q, "no")).toBe("DOESNT_MATCH");
      expect(checkResult(full, q, "not_sure")).toBe("CANT_TELL");
    });

    it("never says doesn't match when CPSC's full list is elsewhere", () => {
      expect(checkResult({ description: "Models are listed below." }, { question: "Q", kind: "yes_no" }, "no")).toBe("CANT_TELL");
    });

    it("compares a typed model number loosely, but only to CPSC's list", () => {
      const recall = { title: "x", description: "Models BRZ0083 and BRZ0154." };
      const q = { question: "Q", kind: "model" as const };
      expect(checkResult(recall, q, "brz-0083")).toBe("MATCHES");
      expect(checkResult(recall, q, "XYZ1")).toBe("DOESNT_MATCH");
      expect(checkResult(recall, q, "  ")).toBe("CANT_TELL");
    });

    it("records only the result, and the seller sees the family's report", async () => {
      const m = await matchFor("27040", line({ orderNumber: "#G1", title: "Costway high chair" }));
      const { noticeId } = await prepareNotice(db, { shopId, matchId: m });
      expect(await recordFamilyAnswer(db, noticeId, "yes")).toBe("MATCHES");
      await recordFamilyStopped(db, noticeId);
      const { rows } = await db.query<Record<string, unknown>>("select * from notices where id = $1", [noticeId]);
      expect(rows[0]).toMatchObject({ check_result: "MATCHES", family_stopped: true });
    });
  });

  describe("familyView", () => {
    it("shows the recall and the shop's name, with CPSC's words, and no buyer or order data", async () => {
      const m = await matchFor("27072", line({ buyerEmail: "test-buyer@example.test", orderNumber: "#SECRET-ORDER" }));
      const { noticeId } = await prepareNotice(db, { shopId, matchId: m });
      const v = await familyView(db, noticeId);
      expect(v).toMatchObject({ kind: "SAFETY_NOTICE", shopName: "DEMO SHOP", recallNumber: "27072", stopped: false, result: null });
      expect(v?.hazards[0]).toMatch(/^The recalled sterilizer dryers can overheat/);
      expect(v?.remedies[0]).toMatch(/^Consumers should stop using/);
      const text = JSON.stringify(v);
      for (const absent of ["test-buyer", "SECRET-ORDER", "9000", "2026-09-15"]) expect(text, absent).not.toContain(absent);
    });

    it("returns nothing for an unknown notice", async () => {
      expect(await familyView(db, "00000000-0000-4000-8000-000000000000")).toBeNull();
    });
  });
});
