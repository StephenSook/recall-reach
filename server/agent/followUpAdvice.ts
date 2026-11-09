// How soon a recall's hazard warrants a follow-up. Telling drowning from a burn, and saying why in a sentence, is what a rule
// can't do. Claude reads CPSC's public text and nothing else: it never sees a shop, a sale or a date, so code sets each sale's
// date. Its one tool records the advice. It can't send, notify or refund anything.
import Anthropic from "@anthropic-ai/sdk";
import type { BetaContentBlock, BetaMessageParam, BetaToolResultBlockParam, BetaToolUnion } from "@anthropic-ai/sdk/resources/beta/messages/messages";
import { z } from "zod";
import type { Queryable } from "../db/types";
import { ourText, toolResult, type OurText } from "./boundary";
import { askClaude, nothingSpent, OverBudget, withFallback, type Spent } from "./claude";
import { normalized, quoted } from "./quote";
import { readRecall } from "./sources";

/** Goes up when the prompt or the checks change, so advice written under older rules is written again. */
export const FOLLOW_UP_VERSION = "3";

const MAX_STEPS = 3;
const MAX_QUOTE_LENGTH = 160;

const SYSTEM = `You help a resale shop decide how soon to follow up with a family who bought a recalled product and hasn't answered. You read only CPSC's public text about the recall. You know nothing about the shop, the sale or the family.

Give:
- within_days: a whole number of days from today, from 1 to 30. Use fewer days for a hazard that can kill or seriously injure a child quickly and without warning, such as drowning, suffocation, strangulation or entrapment. Use more for a hazard that gives warning or causes minor injury.
- severity: grave_and_fast for a hazard that can kill or seriously injure a child quickly with little warning; serious for one that can cause serious injury; lesser for one that usually gives warning or causes minor injury.
- hazard_quote: the few words in CPSC's hazards field that show this, copied exactly. Keep it to a phrase.

Record your answer with record_follow_up.`;

/** What the owner reads. Fixed sentences, so nothing Claude writes can tell an owner a product is fine. */
const SEVERITY_SENTENCE = {
  grave_and_fast: "This hazard can seriously injure or kill a child quickly, with little warning.",
  serious: "This hazard can cause serious injury.",
  lesser: "This hazard usually gives some warning or causes minor injury.",
} as const;

export const FOLLOW_UP_TOOLS = [
  {
    name: "record_follow_up",
    description: "Records how soon this recall's hazard warrants a follow-up. An answer that fails a check comes back as an error, and you can correct it.",
    strict: true,
    input_schema: {
      type: "object",
      additionalProperties: false,
      properties: {
        within_days: { type: "integer" },
        severity: { type: "string", enum: ["grave_and_fast", "serious", "lesser"] },
        hazard_quote: { type: "string" },
      },
      required: ["within_days", "severity", "hazard_quote"],
    },
  },
] satisfies BetaToolUnion[];

const answerInput = z.object({
  within_days: z.number().int().min(1).max(30),
  severity: z.enum(["grave_and_fast", "serious", "lesser"]),
  hazard_quote: z.string().max(1000),
});
type Answer = z.infer<typeof answerInput>;

function answerProblem(answer: Answer, hazards: string[]): OurText | null {
  if (answer.hazard_quote.trim().length > MAX_QUOTE_LENGTH) return ourText("Quote fewer words: only the ones that show the hazard.");
  if (!quoted(hazards, answer.hazard_quote)) return ourText("hazard_quote is not in CPSC's hazards field. Copy the exact words from it.");
  return null;
}

export interface FollowUpAdvice {
  withinDays: number;
  reason: string;
  hazardQuote: string;
  /** Which CPSC text this was read from. A saved reminder is tied to it. */
  snapshot: string;
}

export type AdviceResult = { status: "ADVISED"; advice: FollowUpAdvice } | { status: "NO_ADVICE" | "OVER_BUDGET" | "UNAVAILABLE" | "NO_SUCH_RECALL" };

/** The newest record of a recall number. CPSC can publish one number more than once. */
const currentRecall = async (db: Queryable, recallNumber: string) =>
  (await db.query<{ recall_id: number; raw_sha256: string }>("select recall_id, raw_sha256 from recalls where recall_number = $1 order by recall_date desc, recall_id desc limit 1", [recallNumber])).rows[0];

/** The advice for the recall's current CPSC text, when there is some. */
export async function storedAdvice(db: Queryable, recallNumber: string): Promise<FollowUpAdvice | null> {
  const recall = await currentRecall(db, recallNumber);
  if (!recall) return null;
  const { rows } = await db.query<{ within_days: number; reason: string; hazard_quote: string }>("select within_days, reason, hazard_quote from follow_up_advice where recall_sha256 = $1 and agent_version = $2", [recall.raw_sha256, FOLLOW_UP_VERSION]);
  const row = rows[0];
  return row ? { withinDays: row.within_days, reason: row.reason, hazardQuote: row.hazard_quote, snapshot: recall.raw_sha256 } : null;
}

async function runLoop(db: Queryable, client: Anthropic, model: string, text: unknown, number: string, hazards: string[], now: Date, spent: Spent, capMicros?: number): Promise<{ answer: Answer | null; model: string }> {
  const messages: BetaMessageParam[] = [{ role: "user", content: `CPSC recall ${number}, in CPSC's words:\n${toolResult(text as never)}` }];
  let served = model;
  let nudged = false;
  for (let step = 0; step < MAX_STEPS; step++) {
    const response = await askClaude(db, client, { model, system: SYSTEM, tools: FOLLOW_UP_TOOLS, messages, now, capMicros }, spent);
    served = response.model || model;
    if (response.stop_reason === "refusal" || response.stop_reason === "max_tokens") return { answer: null, model: served };
    messages.push({ role: "assistant", content: response.content });
    if (response.stop_reason === "pause_turn") continue;

    const calls = response.content.filter((b): b is Extract<BetaContentBlock, { type: "tool_use" }> => b.type === "tool_use");
    if (calls.length === 0) {
      if (nudged) return { answer: null, model: served };
      nudged = true;
      messages.push({ role: "user", content: "Record your answer with record_follow_up." });
      continue;
    }
    const results: BetaToolResultBlockParam[] = [];
    for (const call of calls) {
      const parsed = answerInput.safeParse(call.input);
      const problem = call.name !== "record_follow_up" ? ourText("There is no such tool.") : !parsed.success ? ourText("within_days must be a whole number from 1 to 30, and severity one of the three given.") : answerProblem(parsed.data, hazards);
      if (!problem && parsed.success) return { answer: parsed.data, model: served };
      results.push({ type: "tool_result", tool_use_id: call.id, content: toolResult(problem), is_error: true });
    }
    messages.push({ role: "user", content: results });
  }
  return { answer: null, model: served };
}

/** Reuses earlier advice for the same CPSC text. Whatever goes wrong, the page says so and no date is proposed. */
export async function adviseFollowUp(db: Queryable, client: Anthropic, input: { recallNumber: string; now: Date; capMicros?: number }): Promise<AdviceResult> {
  const current = await currentRecall(db, input.recallNumber);
  if (!current) return { status: "NO_SUCH_RECALL" };
  const known = await storedAdvice(db, input.recallNumber);
  if (known) return { status: "ADVISED", advice: known };
  const recall = await readRecall(db, current.recall_id);
  if (!recall) return { status: "NO_SUCH_RECALL" };

  const spent = nothingSpent();
  let run;
  try {
    run = await withFallback((model) => runLoop(db, client, model, recall.text, recall.number, recall.hazards, input.now, spent, input.capMicros));
  } catch (err) {
    if (err instanceof OverBudget) return { status: "OVER_BUDGET" };
    if (err instanceof Anthropic.APIError) return { status: "UNAVAILABLE" };
    throw err;
  }
  const a = run.answer;
  if (!a) return { status: "NO_ADVICE" };
  const advice = { withinDays: a.within_days, reason: SEVERITY_SENTENCE[a.severity], hazardQuote: normalized(a.hazard_quote), snapshot: current.raw_sha256 };
  await db.query(
    `insert into follow_up_advice (recall_sha256, agent_version, recall_id, within_days, reason, hazard_quote, model, input_tokens, output_tokens, cost_micros)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
     on conflict (recall_sha256, agent_version) do nothing`,
    [current.raw_sha256, FOLLOW_UP_VERSION, current.recall_id, advice.withinDays, advice.reason, advice.hazardQuote, run.model, spent.input, spent.output, spent.cost],
  );
  // Two requests at once can both ask. Only one is stored, so both answer with that one.
  return { status: "ADVISED", advice: (await storedAdvice(db, input.recallNumber)) ?? advice };
}
