import Anthropic from "@anthropic-ai/sdk";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { testDb } from "../../test/pglite";
import { migrate } from "../db/migrate";
import { DAILY_CAP_MICROS, FALLBACK_MODEL, lastClaudeAnswer, lastMainModelAnswer, MODEL, pingClaude, spentToday } from "./claude";

const NOW = new Date("2026-11-06T15:00:00Z");
const HOUR = 3_600_000;

function fakeClaude(answer: { status?: number; text?: string; mainStatus?: number; mainText?: string } = {}) {
  const requests: Record<string, unknown>[] = [];
  const fetchImpl = async (_url: unknown, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body));
    requests.push(body);
    const status = body.model === MODEL && answer.mainStatus ? answer.mainStatus : answer.status;
    if (status) return Response.json({ type: "error", error: { type: "api_error", message: "no" } }, { status });
    const text = body.model === MODEL && answer.mainText !== undefined ? answer.mainText : answer.text;
    return Response.json({
      id: "m",
      type: "message",
      role: "assistant",
      model: body.model,
      content: text === "" ? [] : [{ type: "text", text: text ?? "ok" }],
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

  it("asks the cheapest model and then the main one, says almost nothing and sends no data", async () => {
    const { client, requests } = fakeClaude();
    expect(await pingClaude(db, client, NOW)).toBe("OK");
    expect(requests.map((r) => r.model)).toEqual([FALLBACK_MODEL, MODEL]);
    for (const r of requests) {
      expect(r).toMatchObject({ max_tokens: 5 });
      expect(r.fallbacks).toBeUndefined();
      expect(JSON.stringify(r.messages)).toHaveLength(JSON.stringify([{ role: "user", content: "Say ok." }]).length);
    }
    expect(await lastMainModelAnswer(db)).toBe(NOW.toISOString());
  });

  it("shows the main model failing while the cheapest one answers, and doesn't throw", async () => {
    const { client } = fakeClaude({ mainStatus: 529 });
    expect(await pingClaude(db, client, NOW)).toBe("MAIN_MODEL_DOWN");
    expect(await lastClaudeAnswer(db)).toBe(NOW.toISOString());
    expect(await lastMainModelAnswer(db)).toBeNull();
  });

  it("an empty reply from the main model isn't an answer", async () => {
    expect(await pingClaude(db, fakeClaude({ mainText: "" }).client, NOW)).toBe("MAIN_MODEL_DOWN");
    expect(await lastMainModelAnswer(db)).toBeNull();
  });

  it("a check on the main model counts for it, and one that fell back doesn't", async () => {
    const run = (model: string, at: string) =>
      db.query(
        `insert into agent_runs (recall_sha256, item_sha256, agent_version, outcome, finding, evidence, trace, model, input_tokens, output_tokens, cost_micros, created_at)
         values ('r', $3, '1', 'FINDING', 'CANT_TELL', '[]'::jsonb, '[]'::jsonb, $1, 1, 1, 1, $2)`,
        [model, at, `${model}-${at}`],
      );
    await run(FALLBACK_MODEL, "2026-11-06T18:00:00.000Z");
    expect(await lastMainModelAnswer(db)).toBeNull();
    await run(MODEL, "2026-11-06T17:00:00.000Z");
    expect(await lastMainModelAnswer(db)).toBe("2026-11-06T17:00:00.000Z");
  });

  it("asks again soon if the main model has never answered, and waits a day once it has", async () => {
    const down = fakeClaude({ mainStatus: 529 });
    await pingClaude(db, down.client, NOW);
    const up = fakeClaude();
    expect(await pingClaude(db, up.client, new Date(NOW.getTime() + HOUR))).toBe("OK");
    expect(await pingClaude(db, up.client, new Date(NOW.getTime() + 2 * HOUR))).toBe("NOT_DUE");
  });

  it("is counted under the day's cap, and both calls together cost under a cent", async () => {
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
    expect(requests).toHaveLength(2);
    expect(await pingClaude(db, client, new Date(NOW.getTime() + 21 * HOUR))).toBe("OK");
    expect(requests).toHaveLength(4);
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
