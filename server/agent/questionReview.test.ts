import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { testDb } from "../../test/pglite";
import { pullRecalls } from "../cpsc/pull";
import { migrate } from "../db/migrate";
import { createShop, storeOrderLines } from "../import/store";
import { runShopCheck } from "../match/run";
import { familyView, prepareNotice, recordFamilyAnswer, recordFamilyStopped } from "../notice/store";
import { createContactCipher } from "../privacy/contactCipher";
import { pendingQuestions, reviewQuestion } from "./questionReview";
import { QUESTION_VERSION, writtenQuestion } from "./questionStore";

const fixtureText = readFileSync(new URL("../../test/fixtures/cpsc/recalls_2026-10-01_to_2026-11-05.json", import.meta.url), "utf8");

describe("a person reviewing Claude's questions", () => {
  let db: Awaited<ReturnType<typeof testDb>>;
  beforeEach(async () => {
    db = await testDb();
    await migrate(db);
    const fetchImpl = async () => new Response(fixtureText, { status: 200, headers: { "content-type": "application/json" } });
    await pullRecalls(db, { field: "RecallDate", start: "2026-10-01", end: "2026-11-05" }, { fetchImpl: fetchImpl as typeof fetch });
  });
  afterEach(async () => {
    await db.close();
  });

  const write = (number: string, over: { outcome?: string; question?: string | null; sha?: string } = {}) => {
    const question = over.question === undefined ? `Does recall ${number} have this?` : over.question;
    return db.query(
      `insert into recall_questions (recall_sha256, agent_version, recall_id, outcome, question, evidence, every_recalled_unit, model, input_tokens, output_tokens, cost_micros)
       select coalesce($1, raw_sha256), $2, recall_id, $3, $4, $5, true, 'm', 0, 0, 0 from recalls where recall_number = $6`,
      [over.sha ?? null, QUESTION_VERSION, over.outcome ?? "QUESTION", question, question === null ? null : "some CPSC words", number],
    );
  };
  const numbers = async (opts: { limit?: number; first?: string[] } = {}) => (await pendingQuestions(db, { limit: 20, ...opts })).map((q) => q.recallNumber);
  const sha = async (number: string) => (await db.query<{ raw_sha256: string }>("select raw_sha256 from recalls where recall_number = $1", [number])).rows[0].raw_sha256;

  describe("the list", () => {
    it("shows the question, the CPSC words it rests on, the product and CPSC's page", async () => {
      await write("27040");
      expect((await pendingQuestions(db, { limit: 20 }))[0]).toMatchObject({
        recallNumber: "27040",
        question: "Does recall 27040 have this?",
        evidence: "some CPSC words",
        product: "Costway Convertible High Chairs",
        everyRecalledUnit: true,
        url: expect.stringContaining("cpsc.gov"),
        description: expect.stringContaining("designed to convert into a table and chair set"),
      });
    });

    it("puts the recalls in the film first, then the newest", async () => {
      await write("27040");
      await write("27065");
      await write("27067");
      expect((await numbers({ first: ["27040"] }))[0]).toBe("27040");
      expect(await numbers()).not.toEqual(await numbers({ first: ["27040"] }));
    });

    it("keeps to the limit", async () => {
      for (const n of ["27040", "27065", "27067"]) await write(n);
      expect(await numbers({ limit: 2 })).toHaveLength(2);
    });

    it("leaves out anything with no question, anything already reviewed, and any older CPSC text", async () => {
      await write("27040");
      await write("27065", { outcome: "ABSTAINED", question: null });
      await write("27067", { sha: "an older record" });
      await write("27074");
      await db.query("update recall_questions set review = 'ACCEPTED' where question = 'Does recall 27074 have this?'");
      expect(await numbers()).toEqual(["27040"]);
    });
  });

  describe("a decision", () => {
    it("accepting lets the rest of the app treat a no as counting, and records when", async () => {
      await write("27040");
      expect(await reviewQuestion(db, { recallNumber: "27040", question: "Does recall 27040 have this?", decision: "ACCEPTED", scopeConfirmed: true })).toBe(true);
      expect(await writtenQuestion(db, await sha("27040"))).toMatchObject({ accepted: true, everyRecalledUnit: true });
      const { rows } = await db.query<{ reviewed_at: unknown }>("select reviewed_at from recall_questions");
      expect(rows[0].reviewed_at).not.toBeNull();
      expect(await numbers()).toEqual([]);
    });

    it("accepting the words does not accept Claude's claim about every recalled unit: a person says that separately", async () => {
      await write("27040");
      await reviewQuestion(db, { recallNumber: "27040", question: "Does recall 27040 have this?", decision: "ACCEPTED", scopeConfirmed: false });
      expect(await writtenQuestion(db, await sha("27040"))).toMatchObject({ accepted: true, everyRecalledUnit: false });
    });

    it("a person can't confirm for every unit what Claude did not claim", async () => {
      await write("27040");
      await db.query("update recall_questions set every_recalled_unit = false");
      await reviewQuestion(db, { recallNumber: "27040", question: "Does recall 27040 have this?", decision: "ACCEPTED", scopeConfirmed: true });
      expect((await writtenQuestion(db, await sha("27040")))?.everyRecalledUnit).toBe(false);
    });

    it("rejecting takes the question out of use", async () => {
      await write("27040");
      await reviewQuestion(db, { recallNumber: "27040", question: "Does recall 27040 have this?", decision: "REJECTED" });
      expect(await writtenQuestion(db, await sha("27040"))).toBeNull();
    });

    describe("rejecting a question already on a message", () => {
      const QUESTION = "Does your high chair turn into a table and chair set?";
      const prepared = async () => {
        await db.query(
          `insert into recall_questions (recall_sha256, agent_version, recall_id, outcome, question, evidence, every_recalled_unit, model, input_tokens, output_tokens, cost_micros)
           select raw_sha256, $1, recall_id, 'QUESTION', $2, 'convert into a table and chair set', true, 'm', 0, 0, 0 from recalls where recall_number = '27040'`,
          [QUESTION_VERSION, QUESTION],
        );
        const shopId = await createShop(db, { name: "DEMO SHOP", kind: "DEMO" });
        const line = { orderNumber: "#1", lineNo: 1, title: "Costway high chair", sku: null, quantity: 1, unitPriceCents: 100, discountCents: 0, currency: "USD", orderedOn: "2026-09-30", paymentReference: null, buyerEmail: null };
        await storeOrderLines(db, shopId, [line], createContactCipher("k".repeat(32), shopId), "test");
        await runShopCheck(db, shopId, { today: "2026-11-06" });
        const { rows } = await db.query<{ id: string }>("select m.id from recall_matches m join recalls r using (recall_id) where m.shop_id = $1 and r.recall_number = '27040'", [shopId]);
        return (await prepareNotice(db, { shopId, matchId: rows[0].id })).noticeId;
      };
      const reject = () => reviewQuestion(db, { recallNumber: "27040", question: QUESTION, decision: "REJECTED" });
      const asked = async (noticeId: string) => (await familyView(db, noticeId))?.question?.question;

      it("stops it being asked, on a message not sent yet", async () => {
        const noticeId = await prepared();
        expect(await asked(noticeId)).toBe(QUESTION);
        await reject();
        expect(await asked(noticeId)).not.toBe(QUESTION);
      });

      it("stops it being asked on the family's page even after the mail went out, since a person said it was wrong", async () => {
        const noticeId = await prepared();
        await db.query("update notices set sent_at = now() where id = $1", [noticeId]);
        await reject();
        expect(await asked(noticeId)).not.toBe(QUESTION);
      });

      it("stops it being asked of a family who only said not sure: they can still answer", async () => {
        const noticeId = await prepared();
        await recordFamilyAnswer(db, noticeId, "not_sure");
        await reject();
        expect(await asked(noticeId)).not.toBe(QUESTION);
      });

      it("stops it being asked of a family who only said they stopped using it", async () => {
        const noticeId = await prepared();
        await recordFamilyStopped(db, noticeId);
        await reject();
        expect(await asked(noticeId)).not.toBe(QUESTION);
      });

      it("leaves a message the family already answered as the record of what they were asked", async () => {
        const noticeId = await prepared();
        await recordFamilyAnswer(db, noticeId, "yes");
        await reject();
        expect((await db.query<{ written_question: { question: string } }>("select written_question from notices where id = $1", [noticeId])).rows[0].written_question.question).toBe(QUESTION);
      });

      it("touches no message when accepting", async () => {
        const noticeId = await prepared();
        await reviewQuestion(db, { recallNumber: "27040", question: QUESTION, decision: "ACCEPTED" });
        expect(await asked(noticeId)).toBe(QUESTION);
      });
    });

    it("applies only to the exact words the person read", async () => {
      await write("27040");
      expect(await reviewQuestion(db, { recallNumber: "27040", question: "Different words", decision: "ACCEPTED" })).toBe(false);
      expect((await writtenQuestion(db, await sha("27040")))?.accepted).toBe(false);
    });

    it("does not overwrite an earlier decision", async () => {
      await write("27040");
      await reviewQuestion(db, { recallNumber: "27040", question: "Does recall 27040 have this?", decision: "REJECTED" });
      expect(await reviewQuestion(db, { recallNumber: "27040", question: "Does recall 27040 have this?", decision: "ACCEPTED" })).toBe(false);
      expect(await writtenQuestion(db, await sha("27040"))).toBeNull();
    });
  });
});
