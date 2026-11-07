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
- Be answerable with the product alone. A secondhand buyer usually has no packaging, may not have what it was sold with, and can't see inside it. So do not ask about a package, box, container, wrapper or hang tag, about what it came with, or about internal parts. If only those set this product apart, abstain.
- Tell this product apart from similar ones. Do not ask whether a label or a part exists if every similar product would have one.
- Be answerable Yes or No, where Yes means the product matches what CPSC describes.
- Be one short sentence in plain words, naming the kind of product, as in "Does your lamp ...?". Do not ask about the brand: the shop already matched that.
- Not mention the recall, CPSC or safety. Use straight quotes and no dashes.
- Rest on CPSC's exact words. Copy the words it depends on into evidence, exactly as written. Apart from small words and the kind of product, every word in the question has to be in the evidence.

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
const numbered = (text: string): string[] => text.match(/[A-Za-z0-9-]*\d[A-Za-z0-9-]*/g) ?? [];
const hasIdentifier = (text: string) => numbered(text).some((token) => !FEATURE.test(token));

/** The words a question is built with. Everything else in it has to come from CPSC. */
const ASKING_WORDS = new Set(
  "a an and any are as at be by can come comes could did do does for from had has have in include includes into is it its like look looks of on one or show shows than that the their them there these this those to up use uses was were will with you your".split(" "),
);
const wordsOf = (text: string) => text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];

/**
 * A word and the forms it could be of: strings and string, coated and coating, batteries and battery, rattling and rattle,
 * wood and wooden, projections and project. A suffix only comes off a long enough word, so red and ring never meet.
 */
function formsOf(word: string): string[] {
  const forms = [word];
  const off = (suffix: string, longEnough: number, add = "") => {
    for (const w of [...forms]) if (w.length >= longEnough && w.endsWith(suffix)) forms.push(w.slice(0, -suffix.length) + add);
  };
  off("ies", 5, "y");
  off("sses", 6, "ss");
  if (/(ch|sh|x|z)es$/.test(word)) off("es", 5);
  if (!word.endsWith("ss")) off("s", 4);
  off("ing", 7);
  off("ed", 6);
  off("en", 6);
  off("ion", 7);
  off("e", 5);
  return forms;
}
const sameWord = (a: string, b: string) => {
  const forms = formsOf(a);
  return formsOf(b).some((form) => forms.includes(form));
};

/** The kind of product, in CPSC's own words: its product names, and its title from "Recalls" up to where the hazard starts. */
function productWords(recall: { title: string; productNames: string[] }): string[] {
  const hazardStarts = /\s+(?:Due to|Because of)\b|[;,]\s+Risk\b/;
  const kind = /\bRecall(?:s|ed)?\s+(.*)$/.exec(recall.title)?.[1] ?? recall.title;
  return wordsOf(`${kind.split(hazardStarts)[0]} ${recall.productNames.join(" ")}`);
}

/**
 * What the question says that the quote doesn't, so "rests on CPSC's words" is true of the whole question and not just
 * one word of it. A refusal costs a retry or an abstention, and either of those is safe.
 */
export function wordsOutsideEvidence(question: string, evidence: string, recall: { title: string; productNames: string[] }): string[] {
  const allowed = [...wordsOf(evidence), ...productWords(recall)];
  return wordsOf(question).filter((w) => !ASKING_WORDS.has(w) && !allowed.some((a) => sameWord(w, a)));
}

/** Something it asks has to be in the quote. Otherwise a question that only names the product could rest on any words at all. */
export function restsOnEvidence(question: string, evidence: string): boolean {
  const inQuote = wordsOf(evidence);
  return wordsOf(question).some((w) => !ASKING_WORDS.has(w) && inQuote.some((q) => sameWord(w, q)));
}

/**
 * A secondhand family usually has no package, may be missing what it was sold with, and can't see inside the product, so
 * their honest "no" says nothing. If the product really is a box or container this refuses that too, and abstaining is fine.
 */
const WHAT_THEY_MAY_NOT_HAVE = /\b(packag(e|es|ed|ing)|packets?|containers?|box|boxes|cartons?|wrappers?|wrapped|wrapping|hang ?tags?|internal|inside|interior|(come|comes|came|sold|shipped) (in|with))\b/i;
export const dependsOnWhatTheyMayNotHave = (question: string) => WHAT_THEY_MAY_NOT_HAVE.test(question);

/** Null means it passed. */
function answerProblem(answer: Answer, recall: Snapshot & { title: string; productNames: string[] }): OurText | null {
  const { question, evidence } = answer;
  if (question === null) return answer.abstain_reason?.trim() ? null : ourText("Give the reason in abstain_reason, or write a question.");
  if (!evidence) return ourText("Copy the CPSC words the question rests on into evidence.");
  if (!quoted(recall.quotable, evidence)) return ourText("The evidence is not in CPSC's text. Copy the exact words.");
  if (hasIdentifier(question)) return ourText("Do not put a serial number, lot code or model in the question. Ask about something else a parent can see, or give the reason in abstain_reason.");
  if (numbered(question).some((token) => !numbered(evidence).includes(token))) return ourText("A number in the question has to be in the evidence.");
  if (!restsOnEvidence(question, evidence)) return ourText("The evidence has to be what the question asks about, not just the kind of product.");
  if (wordsOutsideEvidence(question, evidence, recall).length > 0) return ourText("A word in the question is not in the evidence. Apart from small words and the kind of product, use only words CPSC wrote in the evidence, or give the reason in abstain_reason.");
  const q = question.trim();
  if (q.length > MAX_QUESTION_LENGTH) return ourText("Make the question shorter: one short sentence.");
  if (!q.endsWith("?") || q.indexOf("?") !== q.length - 1 || !YES_OR_NO_OPENING.test(q)) return ourText("Write one question a parent can answer Yes or No.");
  if (OFF_LIMITS.test(q)) return ourText("Ask about the product itself. Do not mention the recall, CPSC, safety or how it was bought.");
  if (dependsOnWhatTheyMayNotHave(q)) return ourText("A secondhand buyer may have only the product. Do not ask about packaging, what it came with, or anything inside it. Ask about the product itself, or give the reason in abstain_reason.");
  if (NEGATIVE.test(q)) return ourText("Ask it so that Yes means the product matches what CPSC describes, with no negative.");
  if (NOT_PLAIN.test(q)) return ourText("Use straight quotes and no dashes.");
  return null;
}

type Outcome = "QUESTION" | "ABSTAINED" | "NO_QUESTION" | "REFUSED";

async function runLoop(
  db: Queryable,
  client: Anthropic,
  model: string,
  recall: Snapshot & { number: string; title: string; productNames: string[] },
  now: Date,
  spent: Spent,
  capMicros?: number,
): Promise<{ outcome: Outcome; answer: Answer | null; model: string }> {
  const messages: BetaMessageParam[] = [{ role: "user", content: `CPSC recall ${recall.number}, in CPSC's words:\n${toolResult(recall.text)}` }];
  let served = model;
  let nudged = false;
  for (let step = 0; step < MAX_STEPS; step++) {
    const response = await askClaude(db, client, { model, system: SYSTEM, tools: QUESTION_TOOLS, messages, now, capMicros }, spent);
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
export async function writeRecallQuestion(db: Queryable, client: Anthropic, input: { recallId: number; now: Date; capMicros?: number }): Promise<QuestionStatus> {
  const recall = await readRecall(db, input.recallId);
  if (!recall) return "NO_SUCH_RECALL";
  if (modelTokens(`${recall.title} ${recall.description}`).length > 0) return "RULES_CAN_ASK";
  if (!fullScopeInRecord({ description: recall.description })) return "SCOPE_ELSEWHERE";
  const seen = await db.query("select 1 from recall_questions where recall_sha256 = $1 and agent_version = $2", [recall.sha256, QUESTION_VERSION]);
  if (seen.rows.length > 0) return "REUSED";

  const spent = nothingSpent();
  let run;
  try {
    run = await withFallback((model) => runLoop(db, client, model, recall, input.now, spent, input.capMicros));
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
