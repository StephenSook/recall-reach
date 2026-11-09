// The dashboard assistant's one read-only tool, and the agent that holds it. It asks this site's public recall check, so the
// rules matcher decides, not the model. Only what the owner typed and CPSC's public records pass through it: nothing PayPal
// returns. The sentences it hands back are the ones /check shows, so "nothing found" can't read as "safe" here either.
import type { AgAiAgentDefinition, AgAiTool, AgAiToolContext, AgAiToolLabel, AgAiToolLabelParams, AgAiToolResult, AgAnyAiAgentDefinition } from "ag-studio";
import { z } from "zod";
import { type ItemAnswer, readItemAnswer, type RecallToRead } from "@/app/check/itemAnswer";
import type { TextCheckAnswer } from "@/server/match/textCheck";

export const RECALL_TOOL = {
  name: "check_product_against_recalls",
  description: "Checks a product title or model number against CPSC's public recall records, using this site's rules, and returns what they found. It reads only and changes nothing.",
  titleHelp: "The product's title or description, in the owner's words.",
  modelHelp: "The product's model number, if the owner gave one.",
} as const;

export interface RecallCheckArgs {
  title?: string;
  model?: string;
}

/** The check itself returns at most this many, so the owner sees what /check would list. */
const RECALLS_SHOWN = 10;
const FAILED = "The check could not run. Please try again.";

const count = z.number().int().nonnegative();
const checkAnswer = z.object({
  results: z.array(z.object({ recallNumber: z.string(), title: z.string(), verdict: z.enum(["MATCH", "SCOPE_GAP"]), strength: z.string(), tiedToRecall: z.boolean(), sharesWords: z.boolean(), missing: z.array(z.string()) }).passthrough()),
  more: count,
  notJudged: count,
  mentioned: z.object({ recalls: z.array(z.object({ recallNumber: z.string(), title: z.string() })), total: count }).refine((m) => m.total >= m.recalls.length && (m.total === 0 || m.recalls.length > 0)),
  checked: z.object({ recalls: count, from: z.string().nullable(), yearsMissing: z.array(z.number().int()) }).passthrough(),
  note: z.string(),
}).passthrough().refine((a) => a.more === 0 || a.results.length > 0);

/** A broken answer must fail. Read as an answer, its empty lists would say nothing was found. */
const readAnswer = (body: unknown) => {
  const parsed = checkAnswer.safeParse(body);
  return parsed.success ? (parsed.data as unknown as TextCheckAnswer) : null;
};

const forReading = (r: RecallToRead) => ({ recallNumber: r.recallNumber, title: r.title, page: `/recall/${encodeURIComponent(r.recallNumber)}`, missing: r.missing, modelNamed: r.modelNamed ?? undefined });

function forTheModel(item: ItemAnswer, note: string) {
  const recalls = [...item.matches, ...item.toRead, ...item.folded];
  return { kind: item.kind, says: item.says, sameKind: item.sameKind, gap: item.gap, further: item.further, recalls: recalls.slice(0, RECALLS_SHOWN).map(forReading), notShown: Math.max(0, recalls.length - RECALLS_SHOWN), note };
}

export type RecallToolData = ReturnType<typeof forTheModel>;

export async function runRecallCheck(args: RecallCheckArgs, ctx: AgAiToolContext, send: typeof fetch): Promise<AgAiToolResult> {
  const query = new URLSearchParams({ title: args.title ?? "", model: args.model ?? "" });
  try {
    const res = await send(`/api/check?${query}`, { signal: ctx.signal });
    const body: unknown = await res.json().catch(() => null);
    if (!res.ok) return ctx.error((body as { error?: string } | null)?.error ?? FAILED);
    const answer = readAnswer(body);
    if (!answer) return ctx.error(FAILED);
    const item = readItemAnswer(answer);
    return ctx.success(item.says, forTheModel(item, answer.note));
  } catch (err) {
    if (ctx.signal.aborted) return ctx.error("Stopped.");
    return ctx.error(err instanceof Error && err.name === "TypeError" ? "This page couldn't reach the server. Please try again." : FAILED);
  }
}

const INSTRUCTIONS = [
  `You check products against CPSC's public recall records for a resale shop owner. Call ${RECALL_TOOL.name} once, with the words the owner gave: the product in title, and any model number in model.`,
  "Answer from its result and nothing else. Repeat its says sentence, then give each entry in recalls with its number and title and a link to its page, written like [Read recall 27018](/recall/27018). If it has sameKind, gap or further, say those too, and if notShown is above zero, say how many more weren't listed. If the call fails, say the check didn't run and why.",
  "Never say a product is safe, recalled or not recalled. The check compares words with CPSC's records, and only CPSC's notice and the item itself can settle it. You can't change the dashboard.",
  "When you're done, call complete_task with summary set to your whole answer, word for word: it's the only thing passed on.",
].join("\n\n");

export const RECALL_AGENT_ID = "recall-checker";

/** Holds only the check, so it can read and can't change the dashboard. Other agents hand a product to it by its description. */
export function recallCheckerAgent(tool: AgAiTool): AgAiAgentDefinition {
  return {
    id: RECALL_AGENT_ID,
    name: "Recall checker",
    description: "Checks one product title or model number against CPSC's public recalls and reports what the rules found. Give it the owner's exact words. It can't change the dashboard.",
    instructions: () => INSTRUCTIONS,
    tools: () => [tool],
    maxTurns: 6,
  };
}

/** AG's own specialists. Its lead only knows these, so the checker has to be added to who it can hand work to. */
const AG_SPECIALISTS = ["data", "page", "planning", "widget"] as const;
const LEAD_ROUTING = `When the owner gives a product title or model number to check, or asks whether a product has been recalled, hand it to ${RECALL_AGENT_ID} with their exact words, and don't answer from the dashboard's data: those rows are one shop's past results, not a check of this product. Then give the checker's summary word for word, adding nothing. If it comes back with no answer, or finished without a summary, say the check didn't run and ask the owner to try again.`;

/** AG's lead agent, able to hand a product to the recall checker. Replaces its delegate tool: Claude refuses two tools with one name. */
export function leadWithRecallChecker(lead: AgAnyAiAgentDefinition, delegateTo: (targetIds: readonly string[]) => AgAiTool): AgAnyAiAgentDefinition {
  const delegate = delegateTo([...AG_SPECIALISTS, RECALL_AGENT_ID]);
  return {
    ...lead,
    instructions: (ctx, params) => `${lead.instructions?.(ctx, params) ?? ""}\n\n${LEAD_ROUTING}`,
    tools: (ctx, params) => [...(lead.tools?.(ctx, params) ?? []).filter((t) => t.name !== delegate.name), delegate],
  };
}

const LABEL_WORDS = 56;
const PILLS: Record<ItemAnswer["kind"], string> = { MATCH: "Matches a recall", CANT_TELL: "Can't tell yet", NOT_NAMED: "None names it", NOTHING: "None found", UNFINISHED: "Can't say yet" };

/** The row in the chat for each check: what was checked, and what the rules said once they had. */
export function recallToolLabel({ args, status, result }: Pick<AgAiToolLabelParams<RecallCheckArgs, RecallToolData>, "args" | "status" | "result">): AgAiToolLabel {
  const words = [args.title, args.model].filter(Boolean).join(", ");
  const shown = words.length > LABEL_WORDS ? `${words.slice(0, LABEL_WORDS)}...` : words;
  const text = shown ? `CPSC recall check: ${shown}` : "CPSC recall check";
  if (status !== "done" || !result) return { text };
  if (!result.success) return { text, pill: "Didn't run" };
  const pill = result.data ? PILLS[result.data.kind] : undefined;
  return pill ? { text, pill } : { text };
}

const RECALL_NUMBER = /^[0-9A-Za-z-]{1,20}$/;

/** The recall a right-click landed on, from the filter AG Studio describes it with. Only a row that is exactly one recall has one. */
export function recallNumberIn(filter: unknown): string | null {
  const f = filter as { operator?: string; conditions?: unknown[]; field?: { id?: string }; value?: unknown } | null | undefined;
  if (f?.operator === "AND" && Array.isArray(f.conditions)) {
    for (const part of f.conditions) {
      const found = recallNumberIn(part);
      if (found) return found;
    }
    return null;
  }
  if (f?.operator !== "equals" || f.field?.id !== "recalls.recallNumber" || typeof f.value !== "string") return null;
  return RECALL_NUMBER.test(f.value) ? f.value : null;
}
