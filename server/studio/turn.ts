// One turn of AG Studio's agent, through Claude. The page sends the turn AG Studio built (its conversation, tools and
// answer format), this checks its shape and turns it into a Claude request, and Claude's answer goes back as AG Studio's
// own output items and events. The tools run in the browser, on the page's own data. Nothing here reads the database.
import { z } from "zod";

const text = (max: number) => z.string().max(max);
/** The same words the check's own tools may never carry. AG Studio's tools only arrange the dashboard, so none needs one. */
const MONEY = /amount|currency|capture|refund|payee/i;
const TOOL_NAME = /^[a-zA-Z0-9_-]{1,64}$/;

const inputMessage = z.object({
  kind: z.literal("input").optional(),
  type: z.literal("message"),
  role: z.enum(["user", "system"]),
  content: z.array(z.object({ type: z.string(), text: text(20_000).optional() })).max(20),
});
const outputMessage = z.object({
  kind: z.literal("output").optional(),
  type: z.literal("message"),
  role: z.literal("assistant"),
  content: z.array(z.object({ type: z.string(), text: text(20_000).optional(), refusal: text(4_000).optional() })).max(20),
});
const toolCall = z.object({
  type: z.literal("function_call"),
  callId: text(200),
  name: z.string().regex(TOOL_NAME),
  arguments: text(60_000),
  result: text(60_000).optional(),
});
const toolResult = z.object({ type: z.literal("function_call_output"), callId: text(200), output: text(60_000) });
const reasoning = z.object({ type: z.literal("reasoning") });

const turnSchema = z.object({
  input: z.array(z.union([inputMessage, outputMessage, toolCall, toolResult, reasoning])).min(1).max(200),
  instructions: text(20_000).optional(),
  // AG Studio's own create_expression tool describes itself in about 4,500 characters.
  tools: z.array(z.object({ name: z.string().regex(TOOL_NAME), description: text(16_000), parameters: z.record(z.string(), z.unknown()) })).max(64).optional(),
  toolChoice: z.union([z.enum(["auto", "none", "required"]), z.object({ name: z.string().regex(TOOL_NAME) })]).optional(),
  responseFormat: z.union([
    z.object({ type: z.literal("text") }),
    z.object({ type: z.literal("json"), name: z.string().regex(TOOL_NAME), description: text(4_000).optional(), schema: z.record(z.string(), z.unknown()) }),
  ]),
});

export type Turn = z.infer<typeof turnSchema>;

export function readTurn(body: unknown): Turn | { error: string } {
  const parsed = turnSchema.safeParse(body);
  return parsed.success ? parsed.data : { error: "that isn't a turn this page sends" };
}

// Ours first, so the page's own instructions can't loosen it.
const SYSTEM = [
  "You arrange an AG Studio dashboard of U.S. CPSC recalls and what a demo shop's check found for each, for a small resale shop.",
  "Change what the dashboard shows only through the tools you're given: filters, widgets, charts and pages.",
  "Every number and row you mention comes from a tool's answer, and you never invent a value, a row or a count.",
  "A result names a recall to read. Never say a product is safe or not recalled.",
  "Keep your answer short and in plain words, but give in full any recall number, link or caution a tool or another agent handed you.",
].join(" ");

type Block =
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string; input: unknown }
  | { type: "tool_result"; tool_use_id: string; content: string };
export interface ClaudeAsk {
  system: string;
  messages: { role: "user" | "assistant"; content: Block[] }[];
  tools: { name: string; description: string; input_schema: Record<string, unknown> }[];
  /** Never a forced choice: the main model refuses one. */
  toolChoice: { type: "auto" } | { type: "none" };
}

const asObject = (json: string): unknown => {
  try {
    const value = JSON.parse(json);
    return value && typeof value === "object" && !Array.isArray(value) ? value : {};
  } catch {
    return {};
  }
};

export function toClaude(turn: Turn): ClaudeAsk {
  const system = [SYSTEM, turn.instructions ?? ""];
  const messages: ClaudeAsk["messages"] = [];
  const open = new Set<string>();
  const push = (role: "user" | "assistant", block: Block) => {
    const last = messages.at(-1);
    if (last?.role === role) last.content.push(block);
    else messages.push({ role, content: [block] });
  };
  // A tool call Claude made has to be answered in the very next message, or the request is refused.
  const closeOpenCalls = () => {
    for (const id of open) push("user", { type: "tool_result", tool_use_id: id, content: "No result was recorded for this call." });
    open.clear();
  };
  for (const item of turn.input) {
    if (item.type === "reasoning") continue;
    if (item.type === "function_call") {
      push("assistant", { type: "tool_use", id: item.callId, name: item.name, input: asObject(item.arguments) });
      if (item.result !== undefined) push("user", { type: "tool_result", tool_use_id: item.callId, content: item.result });
      else open.add(item.callId);
      continue;
    }
    if (item.type === "function_call_output") {
      if (open.delete(item.callId)) push("user", { type: "tool_result", tool_use_id: item.callId, content: item.output });
      continue;
    }
    // The page is the visitor's to change, so a system-role message from it is read as theirs, never as this app's rules.
    const role = item.role === "assistant" ? "assistant" : "user";
    if (role === "user") closeOpenCalls();
    const words = item.content.map((c) => c.text ?? ("refusal" in c ? c.refusal : "") ?? "").join("\n").trim();
    if (words) push(role, { type: "text", text: words });
  }
  closeOpenCalls();
  if (messages[0]?.role !== "user") messages.unshift({ role: "user", content: [{ type: "text", text: "Go on." }] });
  // Claude refuses a conversation that ends on its own reply. AG Studio sends one when it asks a delegated agent
  // that answered in words to call complete_task.
  if (messages.at(-1)?.role === "assistant") messages.push({ role: "user", content: [{ type: "text", text: "Go on." }] });

  // The main model refuses a forced tool_choice ("type tool and any are not supported for this model", seen Nov 7, 2026),
  // so what AG Studio forces is asked for in words, and a named tool is the only one offered.
  const ask = (words: string) => messages[messages.length - 1].content.push({ type: "text", text: words });
  const done = (tools: ClaudeAsk["tools"], toolChoice: ClaudeAsk["toolChoice"]): ClaudeAsk => ({ system: system.filter(Boolean).join("\n\n"), messages, tools, toolChoice });
  if (turn.responseFormat.type === "json") {
    const { name, description, schema } = turn.responseFormat;
    ask(`Give your answer by calling ${name}.`);
    return done([{ name, description: description ?? "Give the answer.", input_schema: schema }], { type: "auto" });
  }
  const tools = (turn.tools ?? []).filter((t) => !MONEY.test(JSON.stringify(t))).map((t) => ({ name: t.name, description: t.description, input_schema: t.parameters }));
  const choice = turn.toolChoice ?? "auto";
  if (tools.length === 0 || choice === "none") return done(tools, { type: "none" });
  if (choice === "auto") return done(tools, { type: "auto" });
  if (choice === "required") {
    ask("Answer by calling one of your tools.");
    return done(tools, { type: "auto" });
  }
  const named = tools.filter((t) => t.name === choice.name);
  if (named.length === 0) return done([], { type: "none" });
  ask(`Call ${choice.name} now.`);
  return done(named, { type: "auto" });
}

export interface ClaudeAnswer {
  id: string;
  model: string;
  stop_reason: string | null;
  content: ({ type: "text"; text: string } | { type: "tool_use"; id: string; name: string; input: unknown } | { type: string })[];
  usage: { input_tokens: number; output_tokens: number };
}

type Event = { type: string; [key: string]: unknown };

/** AG Studio's own shapes, from ag-studio 3.0.0's AgLlmResponse and AgAiEvent. */
export function fromClaude(turn: Turn, answer: ClaudeAnswer) {
  const json = turn.responseFormat.type === "json" ? turn.responseFormat.name : null;
  const output: Record<string, unknown>[] = [];
  const events: Event[] = [];
  answer.content.forEach((block, i) => {
    const asText = (words: string) => {
      const id = `${answer.id}-text-${i}`;
      output.push({ id, kind: "output", type: "message", role: "assistant", status: "completed", content: [{ type: "text", text: words, annotations: [] }] });
      events.push({ type: "TEXT_MESSAGE_START", messageId: id, role: "assistant" }, { type: "TEXT_MESSAGE_CONTENT", messageId: id, delta: words }, { type: "TEXT_MESSAGE_END", messageId: id });
    };
    if (block.type === "text" && "text" in block) {
      if (!json && block.text) asText(block.text);
      return;
    }
    if (block.type === "tool_use" && "name" in block) {
      const args = JSON.stringify(block.input ?? {});
      if (json) {
        if (block.name === json) asText(args);
        return;
      }
      const id = `${answer.id}-call-${i}`;
      output.push({ id, kind: "output", type: "function_call", callId: block.id, name: block.name, arguments: args, status: "completed" });
      events.push({ type: "TOOL_CALL_START", toolCallId: block.id, toolCallName: block.name, parentMessageId: id }, { type: "TOOL_CALL_ARGS", toolCallId: block.id, delta: args }, { type: "TOOL_CALL_END", toolCallId: block.id });
    }
  });
  const cut = answer.stop_reason === "max_tokens";
  return {
    events,
    response: {
      id: answer.id,
      createdAt: Date.now(),
      output,
      status: cut ? "incomplete" : "completed",
      ...(cut ? { incompleteDetails: { reason: "max_output_tokens" } } : {}),
      usage: { inputTokens: answer.usage.input_tokens, outputTokens: answer.usage.output_tokens },
      model: answer.model,
    },
  };
}
