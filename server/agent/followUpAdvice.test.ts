import { readFileSync } from "node:fs";
import Anthropic from "@anthropic-ai/sdk";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { testDb } from "../../test/pglite";
import { pullRecalls } from "../cpsc/pull";
import { migrate } from "../db/migrate";
import { createShop, storeOrderLines } from "../import/store";
import { createContactCipher } from "../privacy/contactCipher";
import { adviseFollowUp, FOLLOW_UP_TOOLS, storedAdvice } from "./followUpAdvice";
import { DAILY_CAP_MICROS } from "./claude";

const fixtureText = readFileSync(new URL("../../test/fixtures/cpsc/recalls_2026-10-01_to_2026-11-05.json", import.meta.url), "utf8");
const NOW = new Date("2026-11-09T15:00:00Z");
const RECALL = "27040";
const REASON = "Entrapment can seriously injure a child quickly, so reach this family within three days.";

type Block = Record<string, unknown>;
type Step = Block[] | { stop: string; content?: Block[] } | number;

function fakeClaude(script: Step[]) {
  const requests: { body: Record<string, unknown>; raw: string }[] = [];
  const fetchImpl = async (_url: unknown, init?: RequestInit) => {
    const raw = String(init?.body ?? "");
    requests.push({ body: JSON.parse(raw), raw });
    const step = script.shift();
    if (step === undefined) throw new Error("the script ran out");
    if (typeof step === "number") return Response.json({ type: "error", error: { type: "api_error", message: "down" } }, { status: step });
    const { stop, content } = Array.isArray(step) ? { stop: step.some((b) => b.type === "tool_use") ? "tool_use" : "end_turn", content: step } : step;
    return Response.json({ id: `msg-${requests.length}`, type: "message", role: "assistant", model: JSON.parse(raw).model, content: content ?? [], stop_reason: stop, stop_sequence: null, usage: { input_tokens: 500, output_tokens: 50, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } });
  };
  return { client: new Anthropic({ apiKey: "test-key", fetch: fetchImpl as typeof fetch, maxRetries: 0 }), requests };
}

describe("how soon Claude says a hazard warrants a follow-up", () => {
  let db: Awaited<ReturnType<typeof testDb>>;
  let hazard: string;
  let description: string;
  const call = (input: Record<string, unknown>): Block => ({ type: "tool_use", id: `call-${Math.random().toString(36).slice(2, 8)}`, name: "record_follow_up", input });
  const good = (over: Record<string, unknown> = {}) => call({ within_days: 3, reason: REASON, hazard_quote: hazard, ...over });
  const lastReply = (request: { body: Record<string, unknown> }) => (request.body.messages as { content: unknown }[]).at(-1)?.content as Block[];
  const advise = (client: Anthropic, recallNumber = RECALL) => adviseFollowUp(db, client, { recallNumber, now: NOW });

  beforeEach(async () => {
    db = await testDb();
    await migrate(db);
    const fetchImpl = async () => new Response(fixtureText, { status: 200, headers: { "content-type": "application/json" } });
    await pullRecalls(db, { field: "RecallDate", start: "2026-10-01", end: "2026-11-05" }, { fetchImpl: fetchImpl as typeof fetch });
    const { rows } = await db.query<{ hazards: string[]; description: string }>("select hazards, description from recalls where recall_number = $1", [RECALL]);
    hazard = rows[0].hazards[0].split(/\s+/).slice(0, 6).join(" ");
    description = rows[0].description.split(/\s+/).slice(0, 6).join(" ");
  });
  afterEach(async () => {
    await db.close();
  });

  it("returns the days, the sentence and CPSC's words", async () => {
    const { client } = fakeClaude([[good()]]);
    expect(await advise(client)).toMatchObject({ status: "ADVISED", advice: { withinDays: 3, reason: REASON, hazardQuote: hazard } });
  });

  it("offers one tool, which can only record the advice", async () => {
    const { client, requests } = fakeClaude([[good()]]);
    await advise(client);
    expect((requests[0].body.tools as { name: string; strict: boolean }[]).map((t) => [t.name, t.strict])).toEqual([["record_follow_up", true]]);
    expect(FOLLOW_UP_TOOLS).toHaveLength(1);
  });

  it("sends CPSC's public text and nothing about any shop or sale", async () => {
    const shopId = await createShop(db, { name: "PLANTED SHOP NAME", kind: "DEMO" });
    const line = { orderNumber: "PLANTED-ORDER-77", lineNo: 1, title: "PLANTED ITEM TITLE", sku: null, quantity: 1, unitPriceCents: 8675309, discountCents: 0, currency: "USD", orderedOn: "2026-03-14", paymentReference: "PLANTED-REFERENCE", buyerEmail: "planted@example.test" };
    await storeOrderLines(db, shopId, [line], createContactCipher("k".repeat(32), shopId), "test");
    await db.query(
      `insert into paypal_payments (shop_id, order_id, order_number, capture_id, capture_status, captured_at, amount_cents, currency, items)
       values ($1, 'PLANTED-PAYPAL-ORDER', 'PLANTED-INVOICE', 'PLANTED-CAPTURE', 'COMPLETED', '2019-03-14T12:00:00Z', 8675309, 'USD', $2::jsonb)`,
      [shopId, JSON.stringify([{ name: "PLANTED PAYPAL ITEM", sku: "PLANTED-SKU" }])],
    );
    // Not vacuous: what this must not send is really in the database it reads.
    expect((await db.query("select 1 from order_lines where title = 'PLANTED ITEM TITLE'")).rows).toHaveLength(1);
    const { client, requests } = fakeClaude([[good()]]);
    await advise(client);
    expect(requests).toHaveLength(1);
    expect(requests[0].raw).toContain(hazard);
    for (const planted of ["PLANTED", "2026-03-14", "2019-03-14", "planted@example.test", "8675309"]) expect(requests[0].raw).not.toContain(planted);
    expect(requests[0].raw).not.toMatch(/\b(order_line|orderedOn|ordered_on|sold|buyer|paypal|capture|window)\b/i);
  });

  it("corrects a quote that isn't in CPSC's hazard text", async () => {
    const { client, requests } = fakeClaude([[good({ hazard_quote: "words CPSC never wrote" })], [good()]]);
    expect((await advise(client)).status).toBe("ADVISED");
    expect(lastReply(requests[1])[0]).toMatchObject({ type: "tool_result", is_error: true });
  });

  it("sends back a quote too long to read on a row", async () => {
    await db.query("update recalls set hazards = $1::jsonb where recall_number = $2", [JSON.stringify(["word ".repeat(60).trim()]), RECALL]);
    const { client, requests } = fakeClaude([[good({ hazard_quote: "word ".repeat(60).trim() })], [good({ hazard_quote: "word word word" })]]);
    expect((await advise(client)).status).toBe("ADVISED");
    expect(JSON.stringify(lastReply(requests[1]))).toMatch(/fewer words/i);
  });

  it("wants the words from the hazard, not from elsewhere in the recall", async () => {
    const { client, requests } = fakeClaude([[good({ hazard_quote: description })], [good()]]);
    expect((await advise(client)).status).toBe("ADVISED");
    expect(JSON.stringify(lastReply(requests[1]))).toMatch(/hazard/i);
  });

  it.each([
    ["no days", 0],
    ["more than 30 days", 31],
    ["part of a day", 1.5],
  ])("refuses %s", async (_name, within_days) => {
    const { client } = fakeClaude([[good({ within_days })], [good({ within_days })], [good({ within_days })]]);
    expect((await advise(client)).status).toBe("NO_ADVICE");
    expect(await storedAdvice(db, RECALL)).toBeNull();
  });

  it.each([
    ["a long reason", "x ".repeat(120)],
    ["two sentences", "Entrapment is serious. Reach them soon."],
    ["calling something safe", "This product is safe to keep for now."],
    ["saying it isn't recalled", "This product is not recalled, so act soon."],
    ["saying there's no danger", "There is no danger to the child, so follow up in thirty days."],
    ["saying nothing is urgent", "No urgent action is needed for this hazard."],
    ["calling it harmless", "This hazard is harmless, so follow up later."],
    ["a dash", "Entrapment — reach this family soon."],
    ["curly quotes", "CPSC says “entrapment” is serious."],
    ["nothing", " "],
  ])("sends back %s for another try", async (_name, reason) => {
    const { client, requests } = fakeClaude([[good({ reason })], [good()]]);
    expect((await advise(client)).status).toBe("ADVISED");
    expect(lastReply(requests[1])[0]).toMatchObject({ type: "tool_result", is_error: true });
  });

  it("carries which CPSC text it read, so a saved reminder can be tied to it", async () => {
    const { rows } = await db.query<{ raw_sha256: string }>("select raw_sha256 from recalls where recall_number = $1", [RECALL]);
    expect(await advise(fakeClaude([[good()]]).client)).toMatchObject({ advice: { snapshot: rows[0].raw_sha256 } });
  });

  it("gives up after a few bad tries and stores nothing", async () => {
    const bad = () => [good({ hazard_quote: "not there" })];
    const { client, requests } = fakeClaude([bad(), bad(), bad(), bad()]);
    expect((await advise(client)).status).toBe("NO_ADVICE");
    expect(requests.length).toBeLessThanOrEqual(3);
    expect(await storedAdvice(db, RECALL)).toBeNull();
  });

  it("asks once per CPSC text, and reuses the answer", async () => {
    const first = fakeClaude([[good()]]);
    await advise(first.client);
    const second = fakeClaude([]);
    expect(await advise(second.client)).toMatchObject({ status: "ADVISED", advice: { withinDays: 3, reason: REASON, hazardQuote: hazard } });
    expect(second.requests).toHaveLength(0);
  });

  it("asks again when CPSC changes the recall", async () => {
    await advise(fakeClaude([[good()]]).client);
    await db.query("update recalls set raw_sha256 = 'a-new-snapshot' where recall_number = $1", [RECALL]);
    expect(await storedAdvice(db, RECALL)).toBeNull();
    const again = fakeClaude([[good({ within_days: 5 })]]);
    expect(await advise(again.client)).toMatchObject({ advice: { withinDays: 5 } });
  });

  it("says when there's no such recall", async () => {
    expect((await advise(fakeClaude([]).client, "99999")).status).toBe("NO_SUCH_RECALL");
  });

  it("says when today's limit is used up, and doesn't ask", async () => {
    await db.query("insert into agent_spend (day, cost_micros) values ('2026-11-09'::date, $1)", [DAILY_CAP_MICROS]);
    const { client, requests } = fakeClaude([]);
    expect((await advise(client)).status).toBe("OVER_BUDGET");
    expect(requests).toHaveLength(0);
  });

  it("says when Claude can't be reached", async () => {
    expect((await advise(fakeClaude([500, 500]).client)).status).toBe("UNAVAILABLE");
  });

  it("treats a refusal as no advice", async () => {
    expect((await advise(fakeClaude([{ stop: "refusal" }]).client)).status).toBe("NO_ADVICE");
  });

  it("nudges once when Claude answers in words, then gives up", async () => {
    const words = [{ type: "text", text: "Soon." }];
    const { client, requests } = fakeClaude([words, words]);
    expect((await advise(client)).status).toBe("NO_ADVICE");
    expect(requests).toHaveLength(2);
  });
});
