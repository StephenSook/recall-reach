import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { testDb } from "../../test/pglite";
import { pullRecalls } from "../cpsc/pull";
import { migrate } from "../db/migrate";
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
      expect(await reviewQuestion(db, { recallNumber: "27040", question: "Does recall 27040 have this?", decision: "ACCEPTED" })).toBe(true);
      expect((await writtenQuestion(db, await sha("27040")))?.accepted).toBe(true);
      const { rows } = await db.query<{ reviewed_at: unknown }>("select reviewed_at from recall_questions");
      expect(rows[0].reviewed_at).not.toBeNull();
      expect(await numbers()).toEqual([]);
    });

    it("rejecting takes the question out of use", async () => {
      await write("27040");
      await reviewQuestion(db, { recallNumber: "27040", question: "Does recall 27040 have this?", decision: "REJECTED" });
      expect(await writtenQuestion(db, await sha("27040"))).toBeNull();
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
