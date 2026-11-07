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
  ask: { model: string; system: string; tools: BetaToolUnion[]; messages: BetaMessageParam[]; now: Date },
  spent: Spent,
): Promise<BetaMessage> {
  if ((await spentToday(db, ask.now)) >= DAILY_CAP_MICROS) throw new OverBudget();
  const response = await client.beta.messages.create({
    model: ask.model,
    max_tokens: 8000,
    system: ask.system,
    tools: ask.tools,
    tool_choice: { type: "auto" },
    output_config: { effort: "medium" },
    cache_control: { type: "ephemeral" },
    messages: ask.messages,
    ...(ask.model === MODEL ? { betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" as const } : {}),
  });
  const cost = costOf(response);
  spent.input += response.usage.input_tokens;
  spent.output += response.usage.output_tokens;
  spent.cost += cost;
  await db.query(
    `insert into agent_spend (day, cost_micros) values ($1::date, $2)
     on conflict (day) do update set cost_micros = agent_spend.cost_micros + excluded.cost_micros`,
    [businessDay(ask.now), cost],
  );
  return response;
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
