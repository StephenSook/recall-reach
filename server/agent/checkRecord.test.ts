import { readFileSync } from "node:fs";
import Anthropic from "@anthropic-ai/sdk";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { testDb } from "../../test/pglite";
import { pullRecalls } from "../cpsc/pull";
import { migrate } from "../db/migrate";
import { createShop, storeOrderLines } from "../import/store";
import { runShopCheck } from "../match/run";
import { createContactCipher } from "../privacy/contactCipher";
import { checkRecordWithClaude } from "./checkRecord";
import { DAILY_CAP_MICROS } from "./claude";

const fixtureText = readFileSync(new URL("../../test/fixtures/cpsc/recalls_2026-10-01_to_2026-11-05.json", import.meta.url), "utf8");
const NOW = new Date("2026-11-06T15:00:00Z");
const TITLE = "Costway high chair";

const usage = { input_tokens: 500, output_tokens: 50, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
const toolUse = (name: string, input: Record<string, unknown>) => ({ type: "tool_use", id: `c-${Math.random().toString(36).slice(2, 8)}`, name, input });

/** Answers each kind of request by which tool it offers, the way the two jobs really differ. */
function fakeClaude(status?: number) {
  const requests: Record<string, unknown>[] = [];
  const fetchImpl = async (_url: unknown, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body));
    requests.push(body);
    if (status) return Response.json({ type: "error", error: { type: "api_error", message: "no" } }, { status });
    const writesQuestion = body.tools.some((t: { name: string }) => t.name === "record_question");
    const content = writesQuestion
      ? [toolUse("record_question", { question: "Does your high chair convert into a table and chair set?", evidence: "convert into a table and chair set", every_recalled_unit: true, abstain_reason: null })]
      : [toolUse("record_finding", { item_id: "item-1", finding: "CANT_TELL", evidence: [{ source: "recall", quote: "Costway Convertible High Chairs" }], missing_field: "Whether it converts", reason: "The title does not say." })];
    return Response.json({ id: "m", type: "message", role: "assistant", model: body.model, content, stop_reason: "tool_use", stop_sequence: null, usage });
  };
  return { client: new Anthropic({ apiKey: "k", fetch: fetchImpl as typeof fetch, maxRetries: 0 }), requests };
}

describe("checking a sale with Claude", () => {
  let db: Awaited<ReturnType<typeof testDb>>;
  let shopId: string;
  let recordId: string;
  beforeEach(async () => {
    db = await testDb();
    await migrate(db);
    const fetchImpl = async () => new Response(fixtureText, { status: 200, headers: { "content-type": "application/json" } });
    await pullRecalls(db, { field: "RecallDate", start: "2026-10-01", end: "2026-11-05" }, { fetchImpl: fetchImpl as typeof fetch });
    shopId = await createShop(db, { name: "DEMO SHOP", kind: "DEMO" });
    const line = { orderNumber: "#1", lineNo: 1, title: TITLE, sku: "ONLY-THE-SHOP-KNOWS", quantity: 1, unitPriceCents: 100, discountCents: 0, currency: "USD", orderedOn: "2026-09-30", paymentReference: null, buyerEmail: null };
    await storeOrderLines(db, shopId, [line], createContactCipher("k".repeat(32), shopId), "test");
    await runShopCheck(db, shopId, { today: "2026-11-06" });
    await db.query(`delete from recall_matches m using recalls r where r.recall_id = m.recall_id and m.shop_id = $1 and r.recall_number <> '27040'`, [shopId]);
    recordId = (await db.query<{ order_line_id: string }>("select order_line_id from recall_matches where shop_id = $1", [shopId])).rows[0].order_line_id;
  });
  afterEach(async () => {
    await db.close();
  });
  const check = (client: Anthropic, shop = shopId) => checkRecordWithClaude(db, client, { shopId: shop, recordId, now: NOW });

  it("writes the recall's question and checks the sale, and neither call sees the other's job", async () => {
    const { client, requests } = fakeClaude();
    expect(await check(client)).toMatchObject({ unavailable: false, overBudget: false });
    expect((await db.query("select 1 from recall_questions where outcome = 'QUESTION'")).rows).toHaveLength(1);
    expect((await db.query("select 1 from agent_runs where outcome = 'FINDING'")).rows).toHaveLength(1);
    const asked = (name: string) => requests.filter((r) => (r.tools as { name: string }[]).some((t) => t.name === name));
    expect(asked("record_question")).toHaveLength(1);
    expect(asked("record_finding")).toHaveLength(1);
    expect(JSON.stringify(asked("record_question"))).toContain("convert into a table and chair set");
    expect(JSON.stringify(asked("record_question"))).not.toContain("ONLY-THE-SHOP-KNOWS"); // it reads only CPSC's text
  });

  it("costs nothing the second time", async () => {
    await check(fakeClaude().client);
    const again = fakeClaude();
    expect(await check(again.client)).toMatchObject({ unavailable: false, overBudget: false });
    expect(again.requests).toEqual([]);
  });

  it.each([401, 500])("reports Claude unavailable on a %s, and leaves the queue as it was", async (status) => {
    const before = (await db.query("select verdict, strength, agent_run_id from recall_matches")).rows;
    const result = await check(fakeClaude(status).client);
    expect(result.unavailable).toBe(true);
    expect(result.failedStatuses).toContain(status);
    expect((await db.query("select verdict, strength, agent_run_id from recall_matches")).rows).toEqual(before);
  });

  it("reports the day's limit, with no call made", async () => {
    await db.query("insert into agent_spend (day, cost_micros) values ('2026-11-06', $1)", [DAILY_CAP_MICROS]);
    const { client, requests } = fakeClaude();
    expect(await check(client)).toMatchObject({ overBudget: true });
    expect(requests).toEqual([]);
  });

  it("does nothing for another shop's sale", async () => {
    const other = await createShop(db, { name: "OTHER", kind: "DEMO" });
    const { client, requests } = fakeClaude();
    expect(await check(client, other)).toMatchObject({ unavailable: false, overBudget: false });
    expect(requests).toEqual([]);
  });
});
