// Many recalls name no model or code a parent could check, so a rule can only ask "does yours look like it?".
// Claude reads CPSC's text and writes one specific question, resting on CPSC's exact words. If it can't, it says
// so and the app falls back to the plain question. Nothing about a shop, a sale or a payment is sent.
import Anthropic from "@anthropic-ai/sdk";
import type { BetaContentBlock, BetaMessageParam, BetaToolResultBlockParam, BetaToolUnion } from "@anthropic-ai/sdk/resources/beta/messages/messages";
import { z } from "zod";
import type { Queryable } from "../db/types";
import { fullScopeInRecord, modelTokens } from "../match/verdict";
import { ourText, toolResult, type OurText } from "./boundary";
import { askClaude, nothingSpent, OverBudget, withFallback, type Spent } from "./claude";
import { QUESTION_VERSION } from "./questionStore";
import { normalized, quoted } from "./quote";
import { readRecall, type Snapshot } from "./sources";

const MAX_STEPS = 3;
const MAX_QUESTION_LENGTH = 120;

const SYSTEM = `You write one question for a parent who may own a product in a CPSC recall. They answer it by looking at the product in front of them, and the answer helps tell whether theirs is the recalled one.

The question must:
- Ask about something visible on the product itself: a feature, a part, a shape, or a printed label. Not where or when it was bought, and not the hazard.
- Be answerable Yes or No, where Yes means the product matches what CPSC describes.
- Be one short sentence in plain words, naming the kind of product, as in "Does your high chair ...?". Do not ask about the brand: the shop already matched that.
- Not mention the recall, CPSC or safety. Use straight quotes and no dashes.
- Rest on CPSC's exact words. Copy the words it depends on into evidence, exactly as written.

Do not put a serial number, lot code, date code or model in the question. If that is the only thing that sets this product apart, abstain.

Set every_recalled_unit to true only if CPSC's text says every recalled unit has this trait. One color from a list of colors is not that.

If nothing in the text sets this product apart from similar ones, do not invent something. Set question and evidence to null and give the reason in abstain_reason. No question is better than a wrong one.

Record your answer with record_question.`;

export const QUESTION_TOOLS = [
  {
    name: "record_question",
    description: "Records the question for this recall, or that there is none to ask. A question that fails a check comes back as an error, and you can correct it.",
    strict: true,
    input_schema: {
      type: "object",
      additionalProperties: false,
      properties: {
        question: { anyOf: [{ type: "string" }, { type: "null" }] },
        evidence: { anyOf: [{ type: "string" }, { type: "null" }] },
        every_recalled_unit: { type: "boolean" },
        abstain_reason: { anyOf: [{ type: "string" }, { type: "null" }] },
      },
      required: ["question", "evidence", "every_recalled_unit", "abstain_reason"],
    },
  },
] satisfies BetaToolUnion[];

const answerInput = z.object({
  question: z.string().max(1000).nullable(),
  evidence: z.string().max(1000).nullable(),
  every_recalled_unit: z.boolean(),
  abstain_reason: z.string().max(500).nullable(),
});
type Answer = z.infer<typeof answerInput>;

const YES_OR_NO_OPENING = /^(Does|Do|Is|Are|Was|Were|Has|Have|Did|Can|Could|Will)\b/;
const OFF_LIMITS = /\b(recalls?|recalled|cpsc|safe|safety|unsafe|hazards?|dangerous|receipts?|bought|purchased?|website)\b/i;
const NOT_PLAIN = /[\u2013\u2014\u2018\u2019\u201C\u201D]/;
/** A yes has to mean it matches, and a negative turns that around. */
const NEGATIVE = /\b(not|never|without|lacks?|missing|no|none|isn't|doesn't|don't|aren't)\b/i;

/**
 * A serial prefix, lot code or model in a question: anything with a digit, except a plain feature like 12-cup or 2-in-1.
 * None is allowed. A list is easy to leave part of, and the owner of one left out would be told theirs is fine. Recalls
 * that list models get a rule's question instead, which checks the whole list.
 */
const FEATURE = /^\d{1,2}-[a-z]{2,}(-\d{1,2})?$/;
const hasIdentifier = (text: string) => (text.match(/[A-Za-z0-9-]*\d[A-Za-z0-9-]*/g) ?? []).some((token) => !FEATURE.test(token));

const COMMON = new Set(["does", "your", "have", "with", "that", "this", "from", "were", "been", "they", "their", "into", "will", "when", "each", "other", "there", "located"]);
const longWords = (text: string) => (text.toLowerCase().match(/[a-z]{4,}/g) ?? []).filter((w) => !COMMON.has(w));
const shareAWord = (a: string, b: string) => longWords(a).some((x) => longWords(b).some((y) => x.startsWith(y) || y.startsWith(x)));

/** Null means it passed. */
function answerProblem(answer: Answer, recall: Snapshot): OurText | null {
  const { question, evidence } = answer;
  if (question === null) return answer.abstain_reason?.trim() ? null : ourText("Give the reason in abstain_reason, or write a question.");
  if (!evidence) return ourText("Copy the CPSC words the question rests on into evidence.");
  if (!quoted(recall.quotable, evidence)) return ourText("The evidence is not in CPSC's text. Copy the exact words.");
  if (hasIdentifier(question)) return ourText("Do not put a serial number, lot code or model in the question. Ask about something else a parent can see, or give the reason in abstain_reason.");
  if (!shareAWord(question, evidence)) return ourText("The evidence has to be what the question asks about.");
  const q = question.trim();
  if (q.length > MAX_QUESTION_LENGTH) return ourText("Make the question shorter: one short sentence.");
  if (!q.endsWith("?") || q.indexOf("?") !== q.length - 1 || !YES_OR_NO_OPENING.test(q)) return ourText("Write one question a parent can answer Yes or No.");
  if (OFF_LIMITS.test(q)) return ourText("Ask about the product itself. Do not mention the recall, CPSC, safety or how it was bought.");
  if (NEGATIVE.test(q)) return ourText("Ask it so that Yes means the product matches what CPSC describes, with no negative.");
  if (NOT_PLAIN.test(q)) return ourText("Use straight quotes and no dashes.");
  return null;
}

type Outcome = "QUESTION" | "ABSTAINED" | "NO_QUESTION" | "REFUSED";

async function runLoop(
  db: Queryable,
  client: Anthropic,
  model: string,
  recall: Snapshot & { number: string },
  now: Date,
  spent: Spent,
): Promise<{ outcome: Outcome; answer: Answer | null; model: string }> {
  const messages: BetaMessageParam[] = [{ role: "user", content: `CPSC recall ${recall.number}, in CPSC's words:\n${toolResult(recall.text)}` }];
  let served = model;
  let nudged = false;
  for (let step = 0; step < MAX_STEPS; step++) {
    const response = await askClaude(db, client, { model, system: SYSTEM, tools: QUESTION_TOOLS, messages, now }, spent);
    served = response.model || model;
    if (response.stop_reason === "refusal") return { outcome: "REFUSED", answer: null, model: served };
    if (response.stop_reason === "max_tokens") return { outcome: "NO_QUESTION", answer: null, model: served };
    messages.push({ role: "assistant", content: response.content });
    if (response.stop_reason === "pause_turn") continue;

    const calls = response.content.filter((b): b is Extract<BetaContentBlock, { type: "tool_use" }> => b.type === "tool_use");
    if (calls.length === 0) {
      if (nudged) return { outcome: "NO_QUESTION", answer: null, model: served };
      nudged = true;
      messages.push({ role: "user", content: "Record your answer with record_question." });
      continue;
    }
    const results: BetaToolResultBlockParam[] = [];
    for (const call of calls) {
      const parsed = answerInput.safeParse(call.input);
      const problem = call.name !== "record_question" ? ourText("There is no such tool.") : !parsed.success ? ourText("The answer is not in the form this tool takes.") : answerProblem(parsed.data, recall);
      if (!problem && parsed.success) return { outcome: parsed.data.question === null ? "ABSTAINED" : "QUESTION", answer: parsed.data, model: served };
      results.push({ type: "tool_result", tool_use_id: call.id, content: toolResult(problem), is_error: true });
    }
    messages.push({ role: "user", content: results });
  }
  return { outcome: "NO_QUESTION", answer: null, model: served };
}

export type QuestionStatus = "WROTE" | "ABSTAINED" | "NO_QUESTION" | "REFUSED" | "REUSED" | "RULES_CAN_ASK" | "SCOPE_ELSEWHERE" | "UNAVAILABLE" | "OVER_BUDGET" | "NO_SUCH_RECALL";

/** Whatever goes wrong with Claude, the app still has the plain question to ask. */
export async function writeRecallQuestion(db: Queryable, client: Anthropic, input: { recallId: number; now: Date }): Promise<QuestionStatus> {
  const recall = await readRecall(db, input.recallId);
  if (!recall) return "NO_SUCH_RECALL";
  if (modelTokens(`${recall.title} ${recall.description}`).length > 0) return "RULES_CAN_ASK";
  if (!fullScopeInRecord({ description: recall.description })) return "SCOPE_ELSEWHERE";
  const seen = await db.query("select 1 from recall_questions where recall_sha256 = $1 and agent_version = $2", [recall.sha256, QUESTION_VERSION]);
  if (seen.rows.length > 0) return "REUSED";

  const spent = nothingSpent();
  let run;
  try {
    run = await withFallback((model) => runLoop(db, client, model, recall, input.now, spent));
  } catch (err) {
    if (err instanceof OverBudget) return "OVER_BUDGET";
    if (err instanceof Anthropic.APIError) return "UNAVAILABLE";
    throw err;
  }
  const a = run.answer;
  const asked = run.outcome === "QUESTION" && a;
  await db.query(
    `insert into recall_questions (recall_sha256, agent_version, recall_id, outcome, question, evidence, every_recalled_unit, abstain_reason, model, input_tokens, output_tokens, cost_micros)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
     on conflict (recall_sha256, agent_version) do nothing`,
    [
      recall.sha256,
      QUESTION_VERSION,
      input.recallId,
      run.outcome,
      asked ? a.question?.trim() : null,
      asked ? normalized(a.evidence ?? "") : null,
      asked ? a.every_recalled_unit : false,
      run.outcome === "ABSTAINED" ? a?.abstain_reason : null,
      run.model,
      spent.input,
      spent.output,
      spent.cost,
    ],
  );
  return run.outcome === "QUESTION" ? "WROTE" : run.outcome;
}
