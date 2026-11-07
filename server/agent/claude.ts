// Every call this app makes to Claude goes through here: the models, the day's spending cap, and what a call cost.
import Anthropic from "@anthropic-ai/sdk";
import type { BetaMessage, BetaMessageParam, BetaToolUnion } from "@anthropic-ai/sdk/resources/beta/messages/messages";
import type { Queryable } from "../db/types";
import { businessDay } from "../time/businessDay";

export const MODEL = "claude-sonnet-5-5";
export const FALLBACK_MODEL = "claude-haiku-5-5";
export const DAILY_CAP_MICROS = 5_000_000;
/**
 * A shop's own file or store address stops here. Any title can be uploaded, so that path can spend without end, while the
 * demo shop's cards are fixed and each answer is stored for good. The rest of the day stays for the demo path.
 */
export const OWN_SHOP_CAP_MICROS = 4_000_000;

/** Dollars per million tokens is micro-dollars per token. */
const PRICE: Record<string, { input: number; output: number; cacheRead: number; cacheWrite: number }> = {
  [MODEL]: { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 },
  [FALLBACK_MODEL]: { input: 0.1, output: 0.5, cacheRead: 0.01, cacheWrite: 0.125 },
};

export class OverBudget extends Error {}

export interface Spent {
  input: number;
  output: number;
  cost: number;
}
export const nothingSpent = (): Spent => ({ input: 0, output: 0, cost: 0 });

export async function spentToday(db: Queryable, now: Date): Promise<number> {
  const { rows } = await db.query<{ cost: string }>("select cost_micros::text as cost from agent_spend where day = $1::date", [businessDay(now)]);
  return Number(rows[0]?.cost ?? 0);
}

function costOf(message: BetaMessage): number {
  const price = PRICE[message.model] ?? PRICE[MODEL];
  const u = message.usage;
  return Math.ceil(
    u.input_tokens * price.input +
      u.output_tokens * price.output +
      (u.cache_read_input_tokens ?? 0) * price.cacheRead +
      (u.cache_creation_input_tokens ?? 0) * price.cacheWrite,
  );
}

/** One call: refused if the day's cap is reached, and counted against it whatever the answer says. */
export async function askClaude(
  db: Queryable,
  client: Anthropic,
  ask: {
    model: string;
    system: string;
    tools: BetaToolUnion[];
    messages: BetaMessageParam[];
    now: Date;
    capMicros?: number;
    maxTokens?: number;
    /** Defaults to auto. With no tools, neither tools nor a choice is sent. */
    toolChoice?: { type: "auto" } | { type: "any" } | { type: "none" } | { type: "tool"; name: string };
  },
  spent: Spent,
): Promise<BetaMessage> {
  if ((await spentToday(db, ask.now)) >= (ask.capMicros ?? DAILY_CAP_MICROS)) throw new OverBudget();
  const response = await client.beta.messages.create({
    model: ask.model,
    max_tokens: ask.maxTokens ?? 8000,
    system: ask.system,
    ...(ask.tools.length > 0 ? { tools: ask.tools, tool_choice: ask.toolChoice ?? { type: "auto" as const } } : {}),
    output_config: { effort: "medium" },
    cache_control: { type: "ephemeral" },
    messages: ask.messages,
    ...(ask.model === MODEL ? { betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" as const } : {}),
  });
  const cost = costOf(response);
  spent.input += response.usage.input_tokens;
  spent.output += response.usage.output_tokens;
  spent.cost += cost;
  await countSpend(db, ask.now, cost);
  return response;
}

const countSpend = (db: Queryable, now: Date, cost: number) =>
  db.query(
    `insert into agent_spend (day, cost_micros) values ($1::date, $2)
     on conflict (day) do update set cost_micros = agent_spend.cost_micros + excluded.cost_micros`,
    [businessDay(now), cost],
  );

const PING_EVERY_MS = 20 * 3_600_000;

export type PingResult = "OK" | "NOT_DUE" | "OVER_BUDGET" | "NO_ANSWER" | "MAIN_MODEL_DOWN";

/** The smallest real call on one model, with no data in it. An empty reply is paid for and isn't an answer. */
async function saysOk(db: Queryable, client: Anthropic, model: string, now: Date): Promise<boolean> {
  const response = await client.beta.messages.create({ model, max_tokens: 5, messages: [{ role: "user", content: "Say ok." }] });
  await countSpend(db, now, costOf(response));
  return response.content.some((block) => block.type === "text" && block.text.trim().length > 0);
}

/**
 * So a spent balance can't stay green while nobody presses "Check with Claude". It counts under the day's cap. The cheapest
 * model says whether the account can answer at all, and an error there is thrown, so the job says so. Then the main model,
 * since a check that fell back still reads as a good answer, and this is what shows the main one has stopped.
 */
export async function pingClaude(db: Queryable, client: Anthropic, now: Date): Promise<PingResult> {
  const { rows } = await db.query<{ last_ok_at: unknown; last_main_ok_at: unknown }>("select last_ok_at, last_main_ok_at from claude_pings");
  const last = rows[0] ? new Date(rows[0].last_ok_at as string).getTime() : null;
  if (last !== null && rows[0].last_main_ok_at !== null && now.getTime() - last < PING_EVERY_MS) return "NOT_DUE";
  if ((await spentToday(db, now)) >= DAILY_CAP_MICROS) return "OVER_BUDGET";
  if (!(await saysOk(db, client, FALLBACK_MODEL, now))) return "NO_ANSWER";
  await db.query(
    `insert into claude_pings (only_row, last_ok_at) values (true, $1)
     on conflict (only_row) do update set last_ok_at = excluded.last_ok_at`,
    [now.toISOString()],
  );
  let mainOk = false;
  try {
    mainOk = await saysOk(db, client, MODEL, now);
  } catch (err) {
    console.error(`Claude's main model didn't answer: ${err instanceof Anthropic.APIError ? `HTTP ${err.status}` : err instanceof Error ? err.name : "unknown error"}`);
  }
  if (!mainOk) return "MAIN_MODEL_DOWN";
  await db.query("update claude_pings set last_main_ok_at = $1", [now.toISOString()]);
  return "OK";
}

/** The newest good answer on record, from a real check or the daily call. Calls nothing. */
export async function lastClaudeAnswer(db: Queryable): Promise<string | null> {
  const { rows } = await db.query<{ at: unknown }>(
    `select greatest((select max(created_at) from agent_runs where outcome = 'FINDING'), (select last_ok_at from claude_pings)) as at`,
  );
  const at = rows[0]?.at;
  return at ? new Date(at as string).toISOString() : null;
}

/** The same, from the main model only. Calls nothing. */
export async function lastMainModelAnswer(db: Queryable): Promise<string | null> {
  const { rows } = await db.query<{ at: unknown }>(
    `select greatest((select max(created_at) from agent_runs where outcome = 'FINDING' and model like $1), (select last_main_ok_at from claude_pings)) as at`,
    [`${MODEL}%`],
  );
  const at = rows[0]?.at;
  return at ? new Date(at as string).toISOString() : null;
}

const canTryAnotherModel = (err: unknown) =>
  err instanceof Anthropic.APIConnectionError || err instanceof Anthropic.RateLimitError || err instanceof Anthropic.InternalServerError;

/** Runs on the main model, then starts over on the fallback if the main one is down. Haiku can't read Sonnet's thinking. */
export async function withFallback<T>(run: (model: string) => Promise<T>): Promise<T> {
  try {
    return await run(MODEL);
  } catch (err) {
    if (!canTryAnotherModel(err)) throw err;
  }
  return run(FALLBACK_MODEL);
}

/** Null when no key is set: the app then works without Claude. */
export function agentClientFromEnv(env: Record<string, string | undefined> = process.env): Anthropic | null {
  const apiKey = env.ANTHROPIC_API_KEY?.trim();
  return apiKey ? new Anthropic({ apiKey, timeout: 60_000, maxRetries: 2 }) : null;
}
