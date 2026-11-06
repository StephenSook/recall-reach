import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { testDb } from "../../test/pglite";
import { pullRecalls } from "../cpsc/pull";
import { migrate } from "../db/migrate";
import type { Queryable } from "../db/types";
import type { ImportedOrderLine } from "../import/shopExport";
import { QUESTION_VERSION } from "../agent/questionStore";
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

    it("treats a row with no recorded strength as not enough to contact a family", async () => {
      const gap = await matchFor("27040", line({ orderNumber: "#L1", title: "Costway high chair" }));
      await db.query("update recall_matches set strength = null where id = $1", [gap]);
      expect(await refusal(prepareNotice(db, { shopId, matchId: gap }))).toBe("PRODUCT_WORDS_ONLY");
    });

    it("does not trust a match with no recorded strength: the older matcher could confirm on weaker grounds", async () => {
      const confirmed = await matchFor("27072", line({ orderNumber: "#L2" }));
      await db.query("update recall_matches set strength = null where id = $1", [confirmed]);
      expect(await refusal(prepareNotice(db, { shopId, matchId: confirmed }))).toBe("PRODUCT_WORDS_ONLY");
    });

    it("trusts it again once the check has run again", async () => {
      const confirmed = await matchFor("27072", line({ orderNumber: "#L5" }));
      await db.query("update recall_matches set strength = null where id = $1", [confirmed]);
      await runShopCheck(db, shopId, { today: TODAY, paypalSearched: true });
      expect((await prepareNotice(db, { shopId, matchId: confirmed })).kind).toBe("SAFETY_NOTICE");
    });

    it("will not compose a safety notice for a match that is no longer confirmed", async () => {
      const m = await matchFor("27072", line({ orderNumber: "#L6", title: "Baby Brezza SuperFast Sterilizer Dryer BRZ0083" }));
      const { noticeId, kind } = await prepareNotice(db, { shopId, matchId: m });
      expect(kind).toBe("SAFETY_NOTICE");
      await storeOrderLines(db, shopId, [line({ orderNumber: "#L6", title: "Baby Brezza SuperFast Sterilizer Dryer" })], cipher(), "test");
      await runShopCheck(db, shopId, { today: TODAY, paypalSearched: true });
      expect(await refusal(compose(noticeId))).toBe("EVIDENCE_CHANGED");
    });

    it("prepares the right message when the seller approves again after that", async () => {
      const m = await matchFor("27072", line({ orderNumber: "#L7", title: "Baby Brezza SuperFast Sterilizer Dryer BRZ0083" }));
      const first = await prepareNotice(db, { shopId, matchId: m });
      await storeOrderLines(db, shopId, [line({ orderNumber: "#L7", title: "Baby Brezza SuperFast Sterilizer Dryer" })], cipher(), "test");
      await runShopCheck(db, shopId, { today: TODAY, paypalSearched: true });
      const again = await prepareNotice(db, { shopId, matchId: m });
      expect(again).toEqual({ noticeId: first.noticeId, kind: "CHECK_REQUEST" });
      const composed = await compose(again.noticeId);
      expect(composed.subject).toMatch(/^Quick safety check/);
    });

    it("leaves a message already sent as it was: the record shows what went out", async () => {
      const m = await matchFor("27072", line({ orderNumber: "#L8", title: "Baby Brezza SuperFast Sterilizer Dryer BRZ0083" }));
      const first = await prepareNotice(db, { shopId, matchId: m });
      await markOpened(db, { shopId, noticeId: first.noticeId });
      await markSent(db, { shopId, noticeId: first.noticeId });
      await storeOrderLines(db, shopId, [line({ orderNumber: "#L8", title: "Baby Brezza SuperFast Sterilizer Dryer" })], cipher(), "test");
      await runShopCheck(db, shopId, { today: TODAY, paypalSearched: true });
      expect(await prepareNotice(db, { shopId, matchId: m })).toEqual(first);
    });

    describe("a question, when the sale is confirmed after it was prepared", () => {
      const NOT_NAMED = "Baby Brezza SuperFast Sterilizer Dryer";
      const NAMED = "Baby Brezza SuperFast Sterilizer Dryer BRZ0083";
      const question = async (orderNumber: string) => {
        const m = await matchFor("27072", line({ orderNumber, title: NOT_NAMED }));
        const { noticeId, kind } = await prepareNotice(db, { shopId, matchId: m });
        expect(kind).toBe("CHECK_REQUEST");
        return { m, noticeId };
      };
      const confirm = async (orderNumber: string) => {
        await storeOrderLines(db, shopId, [line({ orderNumber, title: NAMED })], cipher(), "test");
        await runShopCheck(db, shopId, { today: TODAY, paypalSearched: true });
      };
      const storedKind = async (noticeId: string) => (await db.query<{ kind: string }>("select kind from notices where id = $1", [noticeId])).rows[0].kind;

      it("is not composed: it would ask a family what is already known", async () => {
        const { m, noticeId } = await question("#S1");
        await confirm("#S1");
        expect(await refusal(compose(noticeId))).toBe("EVIDENCE_CHANGED");
        expect(await prepareNotice(db, { shopId, matchId: m })).toEqual({ noticeId, kind: "SAFETY_NOTICE" });
      });

      it("can still be read back once it was sent: the record shows what went out", async () => {
        const { noticeId } = await question("#S2");
        await markSent(db, { shopId, noticeId });
        await confirm("#S2");
        expect((await compose(noticeId)).subject).toMatch(/^Quick safety check/);
      });

      it("stays what it was once the family answered, even if the seller never marked it sent", async () => {
        const { m, noticeId } = await question("#S3");
        await recordFamilyAnswer(db, noticeId, "BRZ0083");
        await confirm("#S3");
        await prepareNotice(db, { shopId, matchId: m });
        expect(await storedKind(noticeId)).toBe("CHECK_REQUEST");
        expect((await compose(noticeId)).subject).toMatch(/^Quick safety check/);
      });

      describe("once it has gone out", () => {
        const wentOut: [string, (noticeId: string) => Promise<unknown>][] = [
          ["sent", (noticeId) => markSent(db, { shopId, noticeId })],
          ["answered", (noticeId) => recordFamilyAnswer(db, noticeId, "BRZ0083")],
        ];

        it.each(wentOut)("%s: the family can still be told, in a safety notice of its own", async (what, goOut) => {
          const { m, noticeId } = await question(`#S5${what}`);
          await goOut(noticeId);
          await confirm(`#S5${what}`);
          const notice = await prepareNotice(db, { shopId, matchId: m });
          expect(notice.kind).toBe("SAFETY_NOTICE");
          expect(notice.noticeId).not.toBe(noticeId);
          expect((await compose(notice.noticeId)).subject).toMatch(/^Safety recall/);
        });

        it("keeps what the family said on the question", async () => {
          const { m, noticeId } = await question("#S6");
          await recordFamilyAnswer(db, noticeId, "BRZ0083");
          await confirm("#S6");
          await prepareNotice(db, { shopId, matchId: m });
          const { rows } = await db.query<{ check_result: string }>("select check_result from notices where id = $1", [noticeId]);
          expect(rows[0].check_result).toBe("MATCHES");
        });

        it("is one notice however many times it is approved", async () => {
          const { m, noticeId } = await question("#S7");
          await markSent(db, { shopId, noticeId });
          await confirm("#S7");
          const first = await prepareNotice(db, { shopId, matchId: m });
          expect(await prepareNotice(db, { shopId, matchId: m })).toEqual(first);
          const { rows } = await db.query("select 1 from notices where match_id = $1", [m]);
          expect(rows).toHaveLength(2);
        });

        it("holds that line when two approvals race", async () => {
          const { m, noticeId } = await question("#S8");
          await markSent(db, { shopId, noticeId });
          await confirm("#S8");
          const [a, b] = await Promise.all([prepareNotice(db, { shopId, matchId: m }), prepareNotice(db, { shopId, matchId: m })]);
          expect(a).toEqual(b);
        });

        it("does not follow a safety notice with a question if the evidence later weakens", async () => {
          const m = await matchFor("27072", line({ orderNumber: "#S9", title: NAMED }));
          const safety = await prepareNotice(db, { shopId, matchId: m });
          await markSent(db, { shopId, noticeId: safety.noticeId });
          await storeOrderLines(db, shopId, [line({ orderNumber: "#S9", title: NOT_NAMED })], cipher(), "test");
          await runShopCheck(db, shopId, { today: TODAY, paypalSearched: true });
          expect(await prepareNotice(db, { shopId, matchId: m })).toEqual(safety);
          const { rows } = await db.query("select 1 from notices where match_id = $1", [m]);
          expect(rows).toHaveLength(1);
        });
      });

      it.each(["sent", "answered"])("is not rewritten when it was %s while being approved again, and the notice follows it", async (what) => {
        const { m, noticeId } = await question(`#S4${what}`);
        await confirm(`#S4${what}`);
        const racing: Queryable = {
          exec: (sql) => db.exec(sql),
          query: (async (sql: string, params?: unknown[]) => {
            if (sql.startsWith("update notices set kind")) {
              if (what === "sent") await markSent(db, { shopId, noticeId });
              else await db.query("update notices set responded_at = now() where id = $1", [noticeId]);
            }
            return db.query(sql, params);
          }) as Queryable["query"],
        };
        const notice = await prepareNotice(racing, { shopId, matchId: m });
        expect(await storedKind(noticeId)).toBe("CHECK_REQUEST");
        expect(notice.kind).toBe("SAFETY_NOTICE");
        expect(notice.noticeId).not.toBe(noticeId);
      });
    });

    it("composes nothing if the evidence has weakened since the notice was prepared", async () => {
      const gap = await matchFor("27040", line({ orderNumber: "#L3", title: "Costway high chair" }));
      const { noticeId } = await prepareNotice(db, { shopId, matchId: gap });
      await storeOrderLines(db, shopId, [line({ orderNumber: "#L3", title: "wooden convertible high chair" })], cipher(), "test");
      await runShopCheck(db, shopId, { today: TODAY, paypalSearched: true });
      expect(await refusal(compose(noticeId))).toBe("PRODUCT_WORDS_ONLY");
    });

    it("composes nothing once the match has been cleared", async () => {
      const gap = await matchFor("27040", line({ orderNumber: "#L4", title: "Costway high chair" }));
      const { noticeId } = await prepareNotice(db, { shopId, matchId: gap });
      await db.query("update recall_matches set verdict = 'CLEARED', strength = 'BRAND' where id = $1", [gap]);
      expect(await refusal(compose(noticeId))).toBe("NOTHING_TO_SEND");
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

  describe("a question Claude wrote for the recall", () => {
    const WRITTEN = "Does your high chair turn into a table and chair set?";
    const write = (over: { question?: string; review?: string | null; every?: boolean } = {}) =>
      db.query(
        `insert into recall_questions (recall_sha256, agent_version, recall_id, outcome, question, evidence, every_recalled_unit, scope_confirmed, review, model, input_tokens, output_tokens, cost_micros)
         select raw_sha256, $1, recall_id, 'QUESTION', $2, 'convert into a table and chair set', $3, $3, $4, 'm', 0, 0, 0 from recalls where recall_number = '27040'`,
        [QUESTION_VERSION, over.question ?? WRITTEN, over.every ?? true, over.review ?? null],
      );
    const gap = (orderNumber: string) => matchFor("27040", line({ orderNumber, title: "Costway high chair" }));
    const familyQuestion = async (noticeId: string) => (await familyView(db, noticeId))?.question?.question;

    it("goes in the seller's message and on the family's page", async () => {
      await write();
      const { noticeId } = await prepareNotice(db, { shopId, matchId: await gap("#Q1") });
      expect((await compose(noticeId)).body).toContain(WRITTEN);
      expect(await familyQuestion(noticeId)).toBe(WRITTEN);
    });

    it("stays what the family was asked, once the seller approved it", async () => {
      await write();
      const { noticeId } = await prepareNotice(db, { shopId, matchId: await gap("#Q2") });
      await db.query("update recall_questions set question = 'Does your high chair have a different question?'");
      expect((await compose(noticeId)).body).toContain(WRITTEN);
      expect(await familyQuestion(noticeId)).toBe(WRITTEN);
    });

    it("is not used when a person rejected it", async () => {
      await write({ review: "REJECTED" });
      const { noticeId } = await prepareNotice(db, { shopId, matchId: await gap("#Q3") });
      expect(await familyQuestion(noticeId)).not.toBe(WRITTEN);
    });

    it("gives way once CPSC's text no longer has its words, and the answer goes by what is asked", async () => {
      await write();
      const { noticeId } = await prepareNotice(db, { shopId, matchId: await gap("#Q4") });
      await db.query("update recalls set description = 'Costway high chairs in several colors.' where recall_number = '27040'");
      expect(await familyQuestion(noticeId)).toBe("Does yours look like the product on CPSC's recall page?");
      expect(await recordFamilyAnswer(db, noticeId, "no")).toBe("CANT_TELL");
    });

    it("takes a no as can't tell until a person accepted it", async () => {
      await write();
      const { noticeId } = await prepareNotice(db, { shopId, matchId: await gap("#Q5") });
      expect(await recordFamilyAnswer(db, noticeId, "no")).toBe("CANT_TELL");
    });

    it("takes a no as doesn't match once a person accepted it and every recalled unit has the trait", async () => {
      await write({ review: "ACCEPTED" });
      const { noticeId } = await prepareNotice(db, { shopId, matchId: await gap("#Q6") });
      expect(await recordFamilyAnswer(db, noticeId, "no")).toBe("DOESNT_MATCH");
    });

    it("is dropped when the message becomes a safety notice, and picked up when it becomes a question", async () => {
      const m = await matchFor("27072", line({ orderNumber: "#Q7", title: "Baby Brezza SuperFast Sterilizer Dryer BRZ0083" }));
      const safety = await prepareNotice(db, { shopId, matchId: m });
      const stored = async () => (await db.query<{ written_question: unknown }>("select written_question from notices where id = $1", [safety.noticeId])).rows[0].written_question;
      expect(await stored()).toBeNull();
      await db.query(
        `insert into recall_questions (recall_sha256, agent_version, recall_id, outcome, question, evidence, model, input_tokens, output_tokens, cost_micros)
         select raw_sha256, $1, recall_id, 'QUESTION', 'Does your sterilizer have a dryer?', 'Sterilizer', 'm', 0, 0, 0 from recalls where recall_number = '27072'`,
        [QUESTION_VERSION],
      );
      await storeOrderLines(db, shopId, [line({ orderNumber: "#Q7", title: "Baby Brezza SuperFast Sterilizer Dryer" })], cipher(), "test");
      await runShopCheck(db, shopId, { today: TODAY, paypalSearched: true });
      const asked = await prepareNotice(db, { shopId, matchId: m });
      expect(asked.kind).toBe("CHECK_REQUEST");
      expect(await stored()).toMatchObject({ question: "Does your sterilizer have a dryer?" });
      await storeOrderLines(db, shopId, [line({ orderNumber: "#Q7", title: "Baby Brezza SuperFast Sterilizer Dryer BRZ0083" })], cipher(), "test");
      await runShopCheck(db, shopId, { today: TODAY, paypalSearched: true });
      await prepareNotice(db, { shopId, matchId: m });
      expect(await stored()).toBeNull();
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

    it.each(["yes_no", "general"] as const)("can't tell from a yes either on a %s question when CPSC's list is elsewhere", (kind) => {
      expect(checkResult({ description: "Models are listed below." }, { question: "Q", kind }, "yes")).toBe("CANT_TELL");
    });

    it("still matches a model the record itself lists, wherever the rest of the list is", () => {
      const recall = { title: "x", description: "Models BRZ0083 and others are listed below." };
      expect(checkResult(recall, { question: "Q", kind: "model" }, "BRZ0083")).toBe("MATCHES");
      expect(checkResult(recall, { question: "Q", kind: "model" }, "XYZ1")).toBe("CANT_TELL");
    });

    describe("to a question Claude wrote", () => {
      const full = { description: "A full record." };
      const q = (noRulesOut: boolean) => ({ question: "Q", kind: "written" as const, evidence: "e", noRulesOut });

      it("a yes matches", () => expect(checkResult(full, q(false), "yes")).toBe("MATCHES"));
      it("a no can't tell, until a person accepted that a no rules it out", () => {
        expect(checkResult(full, q(false), "no")).toBe("CANT_TELL");
        expect(checkResult(full, q(true), "no")).toBe("DOESNT_MATCH");
      });
      it("nothing settles it when CPSC's list is elsewhere", () => {
        const elsewhere = { description: "Models are listed below." };
        expect(checkResult(elsewhere, q(true), "yes")).toBe("CANT_TELL");
        expect(checkResult(elsewhere, q(true), "no")).toBe("CANT_TELL");
      });
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

    it("does not treat typed text as not sure: on a model question, those words are just a wrong model", async () => {
      const m = await matchFor("27072", line({ orderNumber: "#F13", title: "Baby Brezza sterilizer" }));
      const { noticeId, kind } = await prepareNotice(db, { shopId, matchId: m });
      expect(kind).toBe("CHECK_REQUEST");
      await recordFamilyAnswer(db, noticeId, "not_sure");
      expect((await familyView(db, noticeId))?.answerOpen).toBe(false);
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

    describe("the product photo", () => {
      const notice = async (orderNumber: string) => (await prepareNotice(db, { shopId, matchId: await matchFor("27040", line({ orderNumber, title: "Costway high chair" })) })).noticeId;

      it("shows CPSC's own photo and caption, so a family can compare it with theirs", async () => {
        expect((await familyView(db, await notice("#P1")))?.image).toEqual({ url: "https://www.cpsc.gov/s3fs-public/Costway1.jpg", caption: "Recalled Costway High Chair (brown and white)" });
      });

      it.each([
        ["no photo", "[]"],
        ["a photo not on cpsc.gov", JSON.stringify([{ url: "https://elsewhere.example/a.jpg", caption: "c" }])],
        ["a name that only looks like cpsc.gov", JSON.stringify([{ url: "https://www.cpsc.gov.elsewhere.example/a.jpg", caption: "c" }])],
        ["a photo not over https", JSON.stringify([{ url: "http://www.cpsc.gov/a.jpg", caption: "c" }])],
        ["something that is not a web address", JSON.stringify([{ url: "javascript:alert(1)", caption: "c" }])],
      ])("shows none for %s", async (_name, images) => {
        const noticeId = await notice(`#P2${images.length}`);
        await db.query("update recalls set images = $1::jsonb where recall_number = '27040'", [images]);
        expect((await familyView(db, noticeId))?.image).toBeNull();
      });
    });

    it("returns nothing for an unknown notice", async () => {
      expect(await familyView(db, "00000000-0000-4000-8000-000000000000")).toBeNull();
    });
  });
});
