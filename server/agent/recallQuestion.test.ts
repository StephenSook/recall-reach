import { readFileSync } from "node:fs";
import Anthropic from "@anthropic-ai/sdk";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { testDb } from "../../test/pglite";
import { pullRecalls } from "../cpsc/pull";
import { migrate } from "../db/migrate";
import { createShop, storeOrderLines } from "../import/store";
import { runShopCheck } from "../match/run";
import { createContactCipher } from "../privacy/contactCipher";
import { DAILY_CAP_MICROS } from "./claude";
import { writtenQuestion } from "./questionStore";
import { QUESTION_TOOLS, writeRecallQuestion } from "./recallQuestion";

const fixtureText = readFileSync(new URL("../../test/fixtures/cpsc/recalls_2026-10-01_to_2026-11-05.json", import.meta.url), "utf8");
const NOW = new Date("2026-11-06T15:00:00Z");

const QUESTION = "Does your high chair convert into a table and chair set?";
const SPAN = "convert into a table and chair set";

type Block = Record<string, unknown>;
type Step = Block[] | { stop: string; content?: Block[] } | number;

const answer = (over: Record<string, unknown> = {}): Block => ({
  type: "tool_use",
  id: `call-${Math.random().toString(36).slice(2, 8)}`,
  name: "record_question",
  input: { question: QUESTION, evidence: SPAN, every_recalled_unit: true, abstain_reason: null, ...over },
});

function fakeClaude(script: Step[]) {
  const requests: { body: Record<string, unknown>; raw: string }[] = [];
  const fetchImpl = async (_url: unknown, init?: RequestInit) => {
    const raw = String(init?.body ?? "");
    requests.push({ body: JSON.parse(raw), raw });
    const step = script.shift();
    if (step === undefined) throw new Error("the script ran out");
    if (typeof step === "number") return Response.json({ type: "error", error: { type: "api_error", message: "down" } }, { status: step });
    const { stop, content } = Array.isArray(step) ? { stop: step.some((b) => b.type === "tool_use") ? "tool_use" : "end_turn", content: step } : step;
    return Response.json({
      id: `msg-${requests.length}`,
      type: "message",
      role: "assistant",
      model: JSON.parse(raw).model,
      content: content ?? [],
      stop_reason: stop,
      stop_sequence: null,
      usage: { input_tokens: 500, output_tokens: 50, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
    });
  };
  return { client: new Anthropic({ apiKey: "test-key", fetch: fetchImpl as typeof fetch, maxRetries: 0 }), requests };
}

const lastReply = (request: { body: Record<string, unknown> }) => (request.body.messages as { content: unknown }[]).at(-1)?.content as Block[];

describe("the question Claude writes for a family", () => {
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

  const idOf = async (number: string) => (await db.query<{ recall_id: number }>("select recall_id from recalls where recall_number = $1", [number])).rows[0].recall_id;
  const write = async (number: string, client: Anthropic) => writeRecallQuestion(db, client, { recallId: await idOf(number), now: NOW });
  const stored = async (number: string) =>
    (await db.query<Record<string, unknown>>("select q.* from recall_questions q join recalls r using (recall_id) where r.recall_number = $1", [number])).rows[0];

  it("writes one question for a recall with nothing a rule can ask about, resting on CPSC's words", async () => {
    const { client } = fakeClaude([[answer()]]);
    expect(await write("27040", client)).toBe("WROTE");
    expect(await stored("27040")).toMatchObject({ outcome: "QUESTION", question: QUESTION, evidence: SPAN, every_recalled_unit: true, model: "claude-sonnet-5-5" });
  });

  it("makes it readable to the rest of the app", async () => {
    await write("27040", fakeClaude([[answer()]]).client);
    const { rows } = await db.query<{ raw_sha256: string }>("select raw_sha256 from recalls where recall_number = '27040'");
    // Claude's claim about every recalled unit means nothing until a person confirms it.
    expect(await writtenQuestion(db, rows[0].raw_sha256)).toEqual({ question: QUESTION, evidence: SPAN, everyRecalledUnit: false, accepted: false });
  });

  it("offers one tool, and it can only record a question", async () => {
    const { client, requests } = fakeClaude([[answer()]]);
    await write("27040", client);
    expect((requests[0].body.tools as { name: string; strict: boolean }[]).map((t) => [t.name, t.strict])).toEqual([["record_question", true]]);
    expect(QUESTION_TOOLS).toHaveLength(1);
  });

  it("sends CPSC's text and nothing about any shop, sale or payment", async () => {
    const shopId = await createShop(db, { name: "SENTINEL SHOP NAME", kind: "DEMO" });
    const line = {
      orderNumber: "#SENTINEL-ORDER-NUMBER",
      lineNo: 1,
      title: "Costway high chair SENTINEL-TITLE",
      sku: "SENTINEL-SKU",
      quantity: 1,
      unitPriceCents: 4242424,
      discountCents: 0,
      currency: "USD",
      orderedOn: "2026-10-30",
      paymentReference: "SENTINEL-PAYMENT-REFERENCE",
      buyerEmail: "sentinel-buyer@example.test",
    };
    await storeOrderLines(db, shopId, [line], createContactCipher("k".repeat(32), shopId), "test");
    await db.query(
      `insert into paypal_payments (shop_id, order_id, order_number, capture_id, capture_status, captured_at, amount_cents, currency, items)
       values ($1, 'SENTINEL-ORDER-ID', 'SENTINEL-INVOICE', 'SENTINEL-CAPTURE-ID', 'COMPLETED', '2019-03-14T12:00:00Z', 8675309, 'USD', $2::jsonb)`,
      [shopId, JSON.stringify([{ name: "SENTINEL PAYPAL ITEM NAME", sku: "SENTINEL-PAYPAL-SKU" }])],
    );
    await runShopCheck(db, shopId, { today: "2026-11-06", paypalSearched: true });
    const { client, requests } = fakeClaude([[answer({ evidence: "not in the record" })], [answer()]]);
    await write("27040", client);
    const everything = requests.map((r) => r.raw).join("\n");
    expect(everything).toContain("convert into a table and chair set"); // CPSC's text did reach it
    expect(everything).not.toContain("SENTINEL");
    for (const value of ["8675309", "4242424", "2019-03-14", "2026-10-30", "sentinel-buyer"]) expect(everything, value).not.toContain(value);
    expect(everything).not.toContain("Costway high chair SENTINEL");
  });

  describe("a question can't outlive its source", () => {
    const corrected = async (bad: Record<string, unknown>) => {
      const { client, requests } = fakeClaude([[answer(bad)], [answer()]]);
      await write("27040", client);
      expect(lastReply(requests[1])[0]).toMatchObject({ type: "tool_result", is_error: true });
      expect((await stored("27040")).question).toBe(QUESTION);
    };

    it("refuses a span that is not in CPSC's text", () => corrected({ evidence: "converts into a desk and stool" }));
    it("refuses a span written in other case", () => corrected({ evidence: "CONVERT INTO A TABLE AND CHAIR SET" }));
    it("refuses a question with no span", () => corrected({ evidence: null }));
    it("refuses a span the question has nothing to do with", () => corrected({ question: "Does your chair have four legs?", evidence: "several color combinations" }));
    it("does not count a common word as the question being about the span", () => corrected({ question: "Does your chair have four legs with wheels?", evidence: "There is no tracking information located on the products" }));

    it("accepts CPSC's typography written plainly", async () => {
      const { client } = fakeClaude([[answer({ question: "Does your ladder have Rapid Locks?", evidence: "the ladder's height" })]]);
      expect(await write("27067", client)).toBe("WROTE");
    });
  });

  describe("a parent has to be able to answer it", () => {
    const refused = async (question: string) => {
      const { client, requests } = fakeClaude([[answer({ question })], [answer()]]);
      await write("27040", client);
      expect(lastReply(requests[1])[0]).toMatchObject({ is_error: true });
    };

    it.each([
      ["not a yes or no question", "What color is your high chair and does it convert into a table?"],
      ["no question at all", "Check whether it will convert into a table and chair set."],
      ["two questions", "Does your high chair convert? Does it have a table?"],
      ["about the recall", "Is your recalled high chair able to convert into a table?"],
      ["about CPSC", "Does CPSC say your chair can convert into a table?"],
      ["about safety", "Is it safe to convert into a table and chair set?"],
      ["about the paperwork", "Does your receipt say it will convert into a table?"],
      ["negative, where a yes would mean it is not the product", "Does your high chair not convert into a table?"],
      ["negative in another word", "Is your high chair without a table and chair set?"],
      ["too long", `Does your high chair ${"really ".repeat(25)}convert into a table and chair set?`],
      ["an em dash", "Does your high chair \u2014 the wooden one \u2014 convert into a table?"],
      ["curly quotes", "Does your high chair\u2019s tray convert into a table?"],
    ])("refuses %s", (_name, question) => refused(question));
  });

  describe("a question with an identifier in it", () => {
    const LIST = "begins with any one of the following six digits: 083723, 078352, 084105, 078591, 078592, 084106, or 086409";
    const LABEL = "The 17-digit serial number for the battery pack is printed on a label";
    const abstain = answer({ question: null, evidence: null, every_recalled_unit: false, abstain_reason: "Only a code sets this apart." });

    // The first is a real answer from the live test: an owner of one of the other five would have answered No.
    it.each([
      ["part of a list", "Does your battery pack have a serial number starting with 083723 or 078352?", LIST],
      ["all of a list", "Does your pack's serial start with 083723, 078352, 084105, 078591, 078592, 084106 or 086409?", LIST],
      ["one code, quoted alone", "Does your battery pack have a serial number starting with 083723?", "083723"],
      ["a code CPSC never wrote", "Does your battery pack say Z99999 on its label?", LABEL],
      ["a model with letters", "Does your battery pack say S1 on its label?", LABEL],
    ])("refuses %s", async (_name, question, evidence) => {
      const { client, requests } = fakeClaude([[answer({ question, evidence })], [abstain]]);
      expect(await write("27065", client)).toBe("ABSTAINED");
      expect(lastReply(requests[1])[0]).toMatchObject({ is_error: true });
    });

    it("takes a question that asks what a parent can see, with no code", async () => {
      const { client } = fakeClaude([[answer({ question: "Does your battery pack have a label with a serial number on the bottom?", evidence: LABEL })]]);
      expect(await write("27065", client)).toBe("WROTE");
    });

    const QUOTE = "12-cup Bistro, Brazil, Caffettiera, Chambord, Crema, Java, Jesper, and Kenya model French Press coffee makers with replaceable glass";

    it("takes a plain feature with a number in it, when CPSC's words say it", async () => {
      const { client } = fakeClaude([[answer({ question: "Does your French press have a 12-cup glass carafe?", evidence: QUOTE })]]);
      expect(await write("27055", client)).toBe("WROTE");
    });

    it.each(["Does your French press have a 2-in-1 glass carafe?", "Does your French press have a 20-cup glass carafe?"])("refuses a feature number the quote doesn't say: %s", async (question) => {
      const { client, requests } = fakeClaude([[answer({ question, evidence: QUOTE })], [abstain]]);
      expect(await write("27055", client)).toBe("ABSTAINED");
      expect(lastReply(requests[1])[0]).toMatchObject({ is_error: true });
    });
  });

  describe("when it has nothing specific to ask", () => {
    it("says so, and that answer is kept", async () => {
      const { client } = fakeClaude([[answer({ question: null, evidence: null, every_recalled_unit: false, abstain_reason: "Nothing in the text sets this apart." })]]);
      expect(await write("27040", client)).toBe("ABSTAINED");
      expect(await stored("27040")).toMatchObject({ outcome: "ABSTAINED", question: null, abstain_reason: "Nothing in the text sets this apart." });
      const again = fakeClaude([]);
      expect(await write("27040", again.client)).toBe("REUSED");
      expect(again.requests).toEqual([]);
    });

    it("needs a reason to abstain", async () => {
      const { client, requests } = fakeClaude([[answer({ question: null, evidence: null, abstain_reason: null })], [answer()]]);
      await write("27040", client);
      expect(lastReply(requests[1])[0]).toMatchObject({ is_error: true });
    });

    it("gives no question for the rest of the app to use", async () => {
      await write("27040", fakeClaude([[answer({ question: null, evidence: null, every_recalled_unit: false, abstain_reason: "None." })]]).client);
      const { rows } = await db.query<{ raw_sha256: string }>("select raw_sha256 from recalls where recall_number = '27040'");
      expect(await writtenQuestion(db, rows[0].raw_sha256)).toBeNull();
    });

    it("stops after three tries that never pass, with no question", async () => {
      const bad = () => [answer({ evidence: "not in the record" })] as Step;
      const { client, requests } = fakeClaude([bad(), bad(), bad(), bad()]);
      expect(await write("27040", client)).toBe("NO_QUESTION");
      expect(requests).toHaveLength(3);
      expect(await stored("27040")).toMatchObject({ outcome: "NO_QUESTION", question: null });
    });

    it("keeps a refusal as that", async () => {
      expect(await write("27040", fakeClaude([{ stop: "refusal" }]).client)).toBe("REFUSED");
      expect(await stored("27040")).toMatchObject({ outcome: "REFUSED", question: null });
    });

    it("asks once more if the model answers without the tool", async () => {
      const { client, requests } = fakeClaude([[{ type: "text", text: "I would ask about the tray." }], [answer()]]);
      expect(await write("27040", client)).toBe("WROTE");
      expect(requests).toHaveLength(2);
    });
  });

  describe("where a rule or CPSC already settles what to ask", () => {
    it("makes no call when the record lists a model number: a rule asks that exactly", async () => {
      const { client, requests } = fakeClaude([]);
      expect(await write("27072", client)).toBe("RULES_CAN_ASK");
      expect(requests).toEqual([]);
    });

    it("makes no call when CPSC's list is on a table on its site: every answer would be can't tell", async () => {
      const { client, requests } = fakeClaude([]);
      expect(await write("27051", client)).toBe("SCOPE_ELSEWHERE");
      expect(requests).toEqual([]);
    });
  });

  describe("reuse", () => {
    it("makes no call for a recall whose text has not changed", async () => {
      await write("27040", fakeClaude([[answer()]]).client);
      const again = fakeClaude([]);
      expect(await write("27040", again.client)).toBe("REUSED");
      expect(again.requests).toEqual([]);
    });

    it("writes again when CPSC changed the recall, and the old question stops being used", async () => {
      await write("27040", fakeClaude([[answer()]]).client);
      await db.query("update recalls set raw_sha256 = 'changed' where recall_number = '27040'");
      expect(await writtenQuestion(db, "changed")).toBeNull();
      const again = fakeClaude([[answer()]]);
      expect(await write("27040", again.client)).toBe("WROTE");
      expect(again.requests).toHaveLength(1);
    });
  });

  describe("a person's review", () => {
    const sha = async () => (await db.query<{ raw_sha256: string }>("select raw_sha256 from recalls where recall_number = '27040'")).rows[0].raw_sha256;

    it("is what lets a no count against the recall", async () => {
      await write("27040", fakeClaude([[answer()]]).client);
      await db.query("update recall_questions set review = 'ACCEPTED', scope_confirmed = true");
      expect(await writtenQuestion(db, await sha())).toMatchObject({ accepted: true, everyRecalledUnit: true });
    });

    it("takes a rejected question out of use", async () => {
      await write("27040", fakeClaude([[answer()]]).client);
      await db.query("update recall_questions set review = 'REJECTED'");
      expect(await writtenQuestion(db, await sha())).toBeNull();
    });
  });

  describe("when Claude can't answer", () => {
    it("moves to the fallback model", async () => {
      const { client, requests } = fakeClaude([500, [answer()]]);
      expect(await write("27040", client)).toBe("WROTE");
      expect(requests.map((r) => r.body.model)).toEqual(["claude-sonnet-5-5", "claude-haiku-5-5"]);
    });

    it("stores nothing when both are down, so it can try later", async () => {
      expect(await write("27040", fakeClaude([500, 500]).client)).toBe("UNAVAILABLE");
      expect(await stored("27040")).toBeUndefined();
    });

    it("makes no call past the day's cap", async () => {
      await db.query("insert into agent_spend (day, cost_micros) values ('2026-11-06', $1)", [DAILY_CAP_MICROS]);
      const { client, requests } = fakeClaude([[answer()]]);
      expect(await write("27040", client)).toBe("OVER_BUDGET");
      expect(requests).toEqual([]);
      expect(await stored("27040")).toBeUndefined();
    });
  });
});
