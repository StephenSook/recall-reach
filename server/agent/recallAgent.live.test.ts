// Live test against the real Claude API, on public CPSC text and made-up shop titles. Costs about a cent. Run with:
//   ANTHROPIC_API_KEY=... pnpm exec vitest run --config vitest.live.config.ts server/agent
import { readFileSync } from "node:fs";
import Anthropic from "@anthropic-ai/sdk";
import { beforeEach, describe, expect, it } from "vitest";
import { testDb } from "../../test/pglite";
import { pullRecalls } from "../cpsc/pull";
import { migrate } from "../db/migrate";
import { createShop, storeOrderLines } from "../import/store";
import { runShopCheck } from "../match/run";
import { createContactCipher } from "../privacy/contactCipher";
import { agentClientFromEnv, runAgentOnRecord, spentToday } from "./recallAgent";

const fixtureText = readFileSync(new URL("../../test/fixtures/cpsc/recalls_2026-10-01_to_2026-11-05.json", import.meta.url), "utf8");
const NOW = new Date();
const key = process.env.ANTHROPIC_API_KEY?.trim();

describe.skipIf(!key)("the recall agent (live)", () => {
  let db: Awaited<ReturnType<typeof testDb>>;
  beforeEach(async () => {
    db = await testDb();
    await migrate(db);
    const fetchImpl = async () => new Response(fixtureText, { status: 200, headers: { "content-type": "application/json" } });
    await pullRecalls(db, { field: "RecallDate", start: "2026-10-01", end: "2026-11-05" }, { fetchImpl: fetchImpl as typeof fetch });
  });

  async function pair(title: string, recallNumber: string) {
    const shopId = await createShop(db, { name: "DEMO SHOP", kind: "DEMO" });
    const line = { orderNumber: "#L1", lineNo: 1, title, sku: null, quantity: 1, unitPriceCents: 100, discountCents: 0, currency: "USD", orderedOn: "2026-10-30", paymentReference: null, buyerEmail: null };
    await storeOrderLines(db, shopId, [line], createContactCipher("k".repeat(32), shopId), "test");
    await runShopCheck(db, shopId, { today: "2026-11-06", paypalSearched: true });
    await db.query(`delete from recall_matches m using recalls r where r.recall_id = m.recall_id and m.shop_id = $1 and r.recall_number <> $2`, [shopId, recallNumber]);
    const { rows } = await db.query<{ id: string; order_line_id: string }>("select id, order_line_id from recall_matches where shop_id = $1", [shopId]);
    return { shopId, matchId: rows[0].id, recordId: rows[0].order_line_id };
  }
  const stored = async (matchId: string) =>
    (await db.query<{ outcome: string; finding: string | null; evidence: { source: string; quote: string }[]; missing_field: string | null; reason: string | null; trace: { tool: string; ok: boolean }[]; model: string; cost_micros: string }>(
      "select a.* from recall_matches m join agent_runs a on a.id = m.agent_run_id where m.id = $1",
      [matchId],
    )).rows[0];
  const report = (label: string, run: Awaited<ReturnType<typeof stored>>) =>
    process.stdout.write(`\n[${label}] ${run.model} ${run.outcome} ${run.finding} missing=${run.missing_field} cost=${run.cost_micros}\n  trace: ${run.trace.map((t) => `${t.tool}${t.ok ? "" : "(refused)"}`).join(" > ")}\n  reason: ${run.reason}\n  evidence: ${JSON.stringify(run.evidence)}\n`);

  it("says it can't tell when the title leaves the question open, and names what is missing", async () => {
    const { shopId, matchId, recordId } = await pair("Costway high chair", "27040");
    const summary = await runAgentOnRecord(db, agentClientFromEnv()!, { shopId, recordId, now: NOW });
    expect(summary).toMatchObject({ checked: 1, unavailable: 0, failedStatuses: [] });
    const run = await stored(matchId);
    report("gap", run);
    expect(run.outcome).toBe("FINDING");
    expect(run.model).toBe("claude-sonnet-5-5");
    expect(run.finding).not.toBeNull();
    expect(run.trace.map((t) => t.tool)).toContain("read_recall");
    expect(await spentToday(db, NOW)).toBeGreaterThan(0);
  });

  it("finds the same product when the title carries the model CPSC lists", async () => {
    const { shopId, matchId, recordId } = await pair("Baby Brezza SuperFast Sterilizer Dryer BRZ0083", "27072");
    await runAgentOnRecord(db, agentClientFromEnv()!, { shopId, recordId, now: NOW });
    const run = await stored(matchId);
    report("confirmed", run);
    expect(run.finding).toBe("SAME_PRODUCT");
    expect(run.evidence.map((e) => e.source).sort()).toEqual(["item", "recall"]);
  });

  it("works on the fallback model when the main one is down", async () => {
    const { shopId, matchId, recordId } = await pair("Costway high chair", "27040");
    await db.query("delete from agent_runs");
    const sonnetDown: typeof fetch = async (url, init) => {
      if (JSON.parse(String(init?.body)).model === "claude-sonnet-5-5") return Response.json({ type: "error", error: { type: "api_error", message: "down" } }, { status: 500 });
      return fetch(url, init);
    };
    const client = new Anthropic({ apiKey: key, maxRetries: 0, timeout: 60_000, fetch: sonnetDown });
    const summary = await runAgentOnRecord(db, client, { shopId, recordId, now: NOW });
    expect(summary).toMatchObject({ checked: 1, unavailable: 0 });
    const run = await stored(matchId);
    report("fallback", run);
    expect(run.model).toBe("claude-haiku-5-5");
    expect(run.outcome).toBe("FINDING");
  });
});
