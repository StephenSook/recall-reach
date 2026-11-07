import Anthropic from "@anthropic-ai/sdk";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { testDb } from "../../test/pglite";
import { migrate } from "../db/migrate";
import { DAILY_CAP_MICROS, FALLBACK_MODEL, lastClaudeAnswer, pingClaude, spentToday } from "./claude";

const NOW = new Date("2026-11-06T15:00:00Z");
const HOUR = 3_600_000;

function fakeClaude(answer: { status?: number; text?: string } = {}) {
  const requests: Record<string, unknown>[] = [];
  const fetchImpl = async (_url: unknown, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body));
    requests.push(body);
    if (answer.status) return Response.json({ type: "error", error: { type: "api_error", message: "no" } }, { status: answer.status });
    return Response.json({
      id: "m",
      type: "message",
      role: "assistant",
      model: body.model,
      content: answer.text === "" ? [] : [{ type: "text", text: answer.text ?? "ok" }],
      stop_reason: "end_turn",
      stop_sequence: null,
      usage: { input_tokens: 10, output_tokens: 2, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
    });
  };
  return { client: new Anthropic({ apiKey: "k", fetch: fetchImpl as typeof fetch, maxRetries: 0 }), requests };
}

describe("the daily call to Claude", () => {
  let db: Awaited<ReturnType<typeof testDb>>;
  beforeEach(async () => {
    db = await testDb();
    await migrate(db);
  });
  afterEach(async () => {
    await db.close();
  });

  it("uses the cheapest model, says almost nothing and sends no data", async () => {
    const { client, requests } = fakeClaude();
    expect(await pingClaude(db, client, NOW)).toBe("OK");
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({ model: FALLBACK_MODEL, max_tokens: 5 });
    expect(JSON.stringify(requests[0].messages)).toHaveLength(JSON.stringify([{ role: "user", content: "Say ok." }]).length);
  });

  it("is counted under the day's cap, and costs under a cent", async () => {
    await pingClaude(db, fakeClaude().client, NOW);
    const spent = await spentToday(db, NOW);
    expect(spent).toBeGreaterThan(0);
    expect(spent).toBeLessThan(10_000);
  });

  it("gives the time of the answer", async () => {
    expect(await lastClaudeAnswer(db)).toBeNull();
    await pingClaude(db, fakeClaude().client, NOW);
    expect(await lastClaudeAnswer(db)).toBe(NOW.toISOString());
  });

  it("happens once a day, however often it's asked", async () => {
    const { client, requests } = fakeClaude();
    await pingClaude(db, client, NOW);
    expect(await pingClaude(db, client, new Date(NOW.getTime() + HOUR))).toBe("NOT_DUE");
    expect(requests).toHaveLength(1);
    expect(await pingClaude(db, client, new Date(NOW.getTime() + 21 * HOUR))).toBe("OK");
    expect(requests).toHaveLength(2);
  });

  it("makes no call once the day's cap is reached, and the time doesn't move", async () => {
    await db.query("insert into agent_spend (day, cost_micros) values ('2026-11-06', $1)", [DAILY_CAP_MICROS]);
    const { client, requests } = fakeClaude();
    expect(await pingClaude(db, client, NOW)).toBe("OVER_BUDGET");
    expect(requests).toEqual([]);
    expect(await lastClaudeAnswer(db)).toBeNull();
  });

  it("doesn't count an error as an answer", async () => {
    await expect(pingClaude(db, fakeClaude({ status: 400 }).client, NOW)).rejects.toThrow();
    expect(await lastClaudeAnswer(db)).toBeNull();
  });

  it("doesn't count an empty reply as an answer, though it was paid for", async () => {
    expect(await pingClaude(db, fakeClaude({ text: "" }).client, NOW)).toBe("NO_ANSWER");
    expect(await lastClaudeAnswer(db)).toBeNull();
    expect(await spentToday(db, NOW)).toBeGreaterThan(0);
  });

  it("counts a real check too, so the time is whichever is newer", async () => {
    await pingClaude(db, fakeClaude().client, NOW);
    const later = "2026-11-06T18:00:00.000Z";
    await db.query(
      `insert into agent_runs (recall_sha256, item_sha256, agent_version, outcome, finding, evidence, trace, model, input_tokens, output_tokens, cost_micros, created_at)
       values ('r', 'i', '1', 'FINDING', 'CANT_TELL', '[]'::jsonb, '[]'::jsonb, 'm', 1, 1, 1, $1)`,
      [later],
    );
    expect(await lastClaudeAnswer(db)).toBe(later);
  });

  it("doesn't count a run that found nothing", async () => {
    await db.query(
      `insert into agent_runs (recall_sha256, item_sha256, agent_version, outcome, finding, evidence, trace, model, input_tokens, output_tokens, cost_micros)
       values ('r', 'i', '1', 'REFUSED', null, '[]'::jsonb, '[]'::jsonb, 'm', 1, 1, 1)`,
    );
    expect(await lastClaudeAnswer(db)).toBeNull();
  });
});
