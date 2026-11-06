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

  describe("what may go out for one sale", () => {
    /** A second recall this same sale could belong to, as the matcher would have saved it. */
    const alsoCouldBe = async (matchId: string, recallNumber: string, verdict: string, strength: string) => {
      const { rows } = await db.query<{ id: string }>(
        `insert into recall_matches (shop_id, recall_id, recall_sha256, order_line_id, verdict, matched, missing, reason, strength)
         select m.shop_id, r.recall_id, r.raw_sha256, m.order_line_id, $3, '[]'::jsonb, '[]'::jsonb, 'r', $4
         from recall_matches m, recalls r where m.id = $1 and r.recall_number = $2
         returning id`,
        [matchId, recallNumber, verdict, strength],
      );
      return rows[0].id;
    };

    it("sends nothing on product words alone: the shop's text does not name the brand", async () => {
      const weak = await matchFor("27040", line({ orderNumber: "#W1", title: "wooden convertible high chair" }));
      const { rows } = await db.query<{ strength: string; verdict: string }>("select strength, verdict from recall_matches where id = $1", [weak]);
      expect(rows[0]).toEqual({ strength: "PRODUCT_WORDS", verdict: "SCOPE_GAP" });
      expect(await refusal(prepareNotice(db, { shopId, matchId: weak }))).toBe("PRODUCT_WORDS_ONLY");
    });

    it("asks a family one question about one sale, however many recalls it could belong to", async () => {
      const first = await matchFor("27040", line({ orderNumber: "#G2", title: "Costway high chair" }));
      const second = await alsoCouldBe(first, "27072", "SCOPE_GAP", "BRAND");
      await prepareNotice(db, { shopId, matchId: first });
      expect(await refusal(prepareNotice(db, { shopId, matchId: second }))).toBe("ALREADY_ASKED");
    });

    it("holds that line when two requests race", async () => {
      const first = await matchFor("27040", line({ orderNumber: "#G3", title: "Costway high chair" }));
      const second = await alsoCouldBe(first, "27072", "SCOPE_GAP", "BRAND");
      const results = await Promise.allSettled([prepareNotice(db, { shopId, matchId: first }), prepareNotice(db, { shopId, matchId: second })]);
      expect(results.map((r) => r.status).sort()).toEqual(["fulfilled", "rejected"]);
      const { rows } = await db.query("select 1 from notices");
      expect(rows).toHaveLength(1);
    });

    it("does not ask a question when a recall on this sale is already confirmed", async () => {
      const confirmed = await matchFor("27072", line({ orderNumber: "#G4" }));
      const gap = await alsoCouldBe(confirmed, "27040", "SCOPE_GAP", "BRAND");
      expect(await refusal(prepareNotice(db, { shopId, matchId: gap }))).toBe("ALREADY_ASKED");
    });

    it("still sends each confirmed recall: each is a separate hazard", async () => {
      const first = await matchFor("27072", line({ orderNumber: "#G5" }));
      const second = await alsoCouldBe(first, "27027", "MATCH", "CONFIRMED");
      expect((await prepareNotice(db, { shopId, matchId: first })).kind).toBe("SAFETY_NOTICE");
      expect((await prepareNotice(db, { shopId, matchId: second })).kind).toBe("SAFETY_NOTICE");
    });

    it("still sends a safety notice after a check request, when the recall was confirmed later", async () => {
      const gap = await matchFor("27040", line({ orderNumber: "#G6", title: "Costway high chair" }));
      await prepareNotice(db, { shopId, matchId: gap });
      const confirmed = await alsoCouldBe(gap, "27072", "MATCH", "CONFIRMED");
      expect((await prepareNotice(db, { shopId, matchId: confirmed })).kind).toBe("SAFETY_NOTICE");
    });

    it("the same approval twice is still one notice", async () => {
      const gap = await matchFor("27040", line({ orderNumber: "#G7", title: "Costway high chair" }));
      const a = await prepareNotice(db, { shopId, matchId: gap });
      expect((await prepareNotice(db, { shopId, matchId: gap })).noticeId).toBe(a.noticeId);
    });
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

  describe("what a family link allows", () => {
    const check = async (orderNumber: string) => {
      const m = await matchFor("27040", line({ orderNumber, title: "Costway high chair" }));
      return (await prepareNotice(db, { shopId, matchId: m })).noticeId;
    };
    const lapse = (noticeId: string) => db.query("update notices set family_link_expires_at = now() - interval '1 minute' where id = $1", [noticeId]);
    const resultOf = async (noticeId: string) => (await db.query<{ check_result: string | null }>("select check_result from notices where id = $1", [noticeId])).rows[0].check_result;

    it("keeps the first answer: anyone holding the link cannot change it later", async () => {
      const noticeId = await check("#F1");
      expect(await recordFamilyAnswer(db, noticeId, "yes")).toBe("MATCHES");
      expect(await recordFamilyAnswer(db, noticeId, "no")).toBe("MATCHES");
      expect(await resultOf(noticeId)).toBe("MATCHES");
    });

    it("does not record an empty answer, so a stray post cannot settle the question", async () => {
      const noticeId = await check("#F7");
      expect(await refusal(recordFamilyAnswer(db, noticeId, ""))).toBe("NO_ANSWER");
      expect(await refusal(recordFamilyAnswer(db, noticeId, "   "))).toBe("NO_ANSWER");
      expect(await resultOf(noticeId)).toBeNull();
    });

    it("does not record an answer the question never offered", async () => {
      const noticeId = await check("#F8");
      expect(await refusal(recordFamilyAnswer(db, noticeId, "maybe tomorrow"))).toBe("NO_ANSWER");
      expect(await resultOf(noticeId)).toBeNull();
    });

    it("lets a family who was not sure answer once they have looked", async () => {
      const noticeId = await check("#F9");
      expect(await recordFamilyAnswer(db, noticeId, "not_sure")).toBe("CANT_TELL");
      expect(await recordFamilyAnswer(db, noticeId, "yes")).toBe("MATCHES");
      expect(await resultOf(noticeId)).toBe("MATCHES");
    });

    it("keeps a can't-tell that came from a real answer: only an explicit not sure stays open", async () => {
      const noticeId = await check("#F11");
      // CPSC's full list is elsewhere, so a no cannot clear it and comes out as can't tell.
      await db.query("update recalls set description = description || ' Other models are listed below.' where recall_number = '27040'");
      expect(await recordFamilyAnswer(db, noticeId, "no")).toBe("CANT_TELL");
      expect(await recordFamilyAnswer(db, noticeId, "yes")).toBe("CANT_TELL");
      expect((await familyView(db, noticeId))?.answerOpen).toBe(false);
    });

    it("shows the question again after not sure, and not after a real answer", async () => {
      const unsure = await check("#F12");
      expect((await familyView(db, unsure))?.answerOpen).toBe(true);
      await recordFamilyAnswer(db, unsure, "not_sure");
      expect((await familyView(db, unsure))?.answerOpen).toBe(true);
      await recordFamilyAnswer(db, unsure, "yes");
      expect((await familyView(db, unsure))?.answerOpen).toBe(false);
    });

    it("keeps a real answer once there is one, even after a later not sure", async () => {
      const noticeId = await check("#F10");
      expect(await recordFamilyAnswer(db, noticeId, "yes")).toBe("MATCHES");
      expect(await recordFamilyAnswer(db, noticeId, "not_sure")).toBe("MATCHES");
    });

    it("takes an answer only on a check request", async () => {
      const m = await matchFor("27072", line({ orderNumber: "#F2" }));
      const { noticeId } = await prepareNotice(db, { shopId, matchId: m });
      expect(await refusal(recordFamilyAnswer(db, noticeId, "no"))).toBe("NOT_A_QUESTION");
      expect(await resultOf(noticeId)).toBeNull();
    });

    it("stops taking an answer once the link has expired", async () => {
      const noticeId = await check("#F3");
      await lapse(noticeId);
      expect(await refusal(recordFamilyAnswer(db, noticeId, "yes"))).toBe("LINK_EXPIRED");
      expect(await resultOf(noticeId)).toBeNull();
    });

    it("stops taking a report once the link has expired", async () => {
      const noticeId = await check("#F4");
      await lapse(noticeId);
      expect(await refusal(recordFamilyStopped(db, noticeId))).toBe("LINK_EXPIRED");
    });

    it("still shows what CPSC says after it has expired, because the hazard has not gone away", async () => {
      const noticeId = await check("#F5");
      await lapse(noticeId);
      const view = await familyView(db, noticeId);
      expect(view?.expired).toBe(true);
      expect(view?.recallUrl).toMatch(/^https:/);
      expect(view?.hazards.length).toBeGreaterThan(0);
    });

    it("lasts about six months from when it was prepared", async () => {
      const noticeId = await check("#F6");
      const { rows } = await db.query<{ days: string }>("select extract(day from family_link_expires_at - prepared_at)::text as days from notices where id = $1", [noticeId]);
      expect(rows[0].days).toBe("180");
      expect((await familyView(db, noticeId))?.expired).toBe(false);
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
