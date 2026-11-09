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
export const FOLLOW_UP_VERSION = "1";

const MAX_STEPS = 3;
const MAX_REASON_LENGTH = 160;
const MAX_QUOTE_LENGTH = 160;

const SYSTEM = `You help a resale shop decide how soon to follow up with a family who bought a recalled product and hasn't answered. You read only CPSC's public text about the recall. You know nothing about the shop, the sale or the family.

Give:
- within_days: a whole number of days from today, from 1 to 30. Use fewer days for a hazard that can kill or seriously injure a child quickly and without warning, such as drowning, suffocation, strangulation or entrapment. Use more for a hazard that gives warning or causes minor injury.
- reason: one short plain sentence saying why that many days, naming the hazard in CPSC's terms. Don't say the product is safe or unsafe. Use straight quotes and no dashes.
- hazard_quote: the few words in CPSC's hazards field that the reason rests on, copied exactly. Keep it to a phrase.

Record your answer with record_follow_up.`;

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
        reason: { type: "string" },
        hazard_quote: { type: "string" },
      },
      required: ["within_days", "reason", "hazard_quote"],
    },
  },
] satisfies BetaToolUnion[];

const answerInput = z.object({
  within_days: z.number().int().min(1).max(30),
  reason: z.string().max(1000),
  hazard_quote: z.string().max(1000),
});
type Answer = z.infer<typeof answerInput>;

const NOT_PLAIN = /[–—‘’“”]/;
const CALLS_IT_SAFE = /\b(safe|unsafe)\b/i;
/** A full stop with more words after it means a second sentence. */
const SECOND_SENTENCE = /[.!?]\s+\S/;

function answerProblem(answer: Answer, hazards: string[]): OurText | null {
  const reason = answer.reason.trim();
  if (!reason) return ourText("Give one short sentence in reason.");
  if (reason.length > MAX_REASON_LENGTH) return ourText("Make the reason shorter: one short sentence.");
  if (SECOND_SENTENCE.test(reason)) return ourText("The reason has to be one sentence.");
  if (CALLS_IT_SAFE.test(reason)) return ourText("Don't say the product is safe or unsafe. Say why this many days.");
  if (NOT_PLAIN.test(reason)) return ourText("Use straight quotes and no dashes.");
  if (answer.hazard_quote.trim().length > MAX_QUOTE_LENGTH) return ourText("Quote fewer words: only the ones the reason rests on.");
  if (!quoted(hazards, answer.hazard_quote)) return ourText("hazard_quote is not in CPSC's hazards field. Copy the exact words from it.");
  return null;
}

export interface FollowUpAdvice {
  withinDays: number;
  reason: string;
  hazardQuote: string;
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
  return row ? { withinDays: row.within_days, reason: row.reason, hazardQuote: row.hazard_quote } : null;
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
      const problem = call.name !== "record_follow_up" ? ourText("There is no such tool.") : !parsed.success ? ourText("within_days must be a whole number from 1 to 30.") : answerProblem(parsed.data, hazards);
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
  const advice = { withinDays: a.within_days, reason: a.reason.trim(), hazardQuote: normalized(a.hazard_quote) };
  await db.query(
    `insert into follow_up_advice (recall_sha256, agent_version, recall_id, within_days, reason, hazard_quote, model, input_tokens, output_tokens, cost_micros)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
     on conflict (recall_sha256, agent_version) do nothing`,
    [current.raw_sha256, FOLLOW_UP_VERSION, current.recall_id, advice.withinDays, advice.reason, advice.hazardQuote, run.model, spent.input, spent.output, spent.cost],
  );
  return { status: "ADVISED", advice };
}
