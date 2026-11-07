import { describe, expect, it } from "vitest";
import { fromClaude, readTurn, toClaude } from "./turn";

const user = (text: string) => ({ id: "u1", kind: "input", type: "message", role: "user", status: "completed", content: [{ type: "text", text }] });
const call = (callId: string, name: string, args: object) => ({ id: `fc-${callId}`, kind: "output", type: "function_call", callId, name, arguments: JSON.stringify(args), status: "completed" });
const output = (callId: string, text: string) => ({ kind: "input", type: "function_call_output", callId, output: text, status: "completed" });
const tool = { name: "add_widget", description: "Adds a widget.", parameters: { type: "object", properties: { kind: { type: "string" } } } };

describe("one AG Studio turn, to Claude and back", () => {
  describe("reading what the page sends", () => {
    it("takes a turn AG Studio would send", () => {
      const turn = readTurn({ input: [user("Show only matched recalls")], instructions: "Be brief.", tools: [tool], toolChoice: "auto", responseFormat: { type: "text" } });
      expect("error" in turn).toBe(false);
    });

    it.each([
      ["no input", { input: [], responseFormat: { type: "text" } }],
      ["an unknown item", { input: [{ type: "image_generation" }], responseFormat: { type: "text" } }],
      ["a tool with a name Claude can't take", { input: [user("x")], tools: [{ ...tool, name: "add widget!" }], responseFormat: { type: "text" } }],
      ["too many tools", { input: [user("x")], tools: Array.from({ length: 80 }, (_, i) => ({ ...tool, name: `t${i}` })), responseFormat: { type: "text" } }],
    ])("refuses %s", (_name, body) => {
      expect("error" in readTurn(body)).toBe(true);
    });
  });

  describe("to Claude", () => {
    it("pairs each tool call with its result in the next message, as Claude needs", () => {
      const turn = readTurn({
        input: [user("Chart recalls by year"), call("c1", "add_widget", { kind: "chart" }), output("c1", "Added."), user("Thanks")],
        tools: [tool],
        responseFormat: { type: "text" },
      });
      if ("error" in turn) throw new Error(turn.error);
      const ask = toClaude(turn);
      expect(ask.messages).toEqual([
        { role: "user", content: [{ type: "text", text: "Chart recalls by year" }] },
        { role: "assistant", content: [{ type: "tool_use", id: "c1", name: "add_widget", input: { kind: "chart" } }] },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "c1", content: "Added." }, { type: "text", text: "Thanks" }] },
      ]);
      expect(ask.tools).toEqual([{ name: "add_widget", description: "Adds a widget.", input_schema: tool.parameters }]);
    });

    it("gives a tool call that has no result one, so the conversation stays valid", () => {
      const turn = readTurn({ input: [user("x"), call("c9", "add_widget", {})], tools: [tool], responseFormat: { type: "text" } });
      if ("error" in turn) throw new Error(turn.error);
      const last = toClaude(turn).messages.at(-1);
      expect(last).toMatchObject({ role: "user", content: [{ type: "tool_result", tool_use_id: "c9" }] });
    });

    it("ends on a user message when AG Studio's turn ends on the agent's own reply, as Claude needs", () => {
      // A delegated agent answers in words, then AG Studio asks it to call complete_task.
      const reply = { kind: "output", type: "message", role: "assistant", status: "completed", content: [{ type: "text", text: "Filter added." }] };
      const turn = readTurn({ input: [user("Filter it"), reply], tools: [{ ...tool, name: "complete_task" }], toolChoice: { name: "complete_task" }, responseFormat: { type: "text" } });
      if ("error" in turn) throw new Error(turn.error);
      const ask = toClaude(turn);
      expect(ask.messages.at(-2)).toEqual({ role: "assistant", content: [{ type: "text", text: "Filter added." }] });
      expect(ask.messages.at(-1)?.role).toBe("user");
      expect(ask.toolChoice).toEqual({ type: "tool", name: "complete_task" });
    });

    it("takes AG Studio's own tools, whose descriptions run past 4,000 characters", () => {
      const turn = readTurn({ input: [user("x")], tools: [{ ...tool, name: "create_expression", description: "d".repeat(4_485) }], responseFormat: { type: "text" } });
      expect("error" in turn).toBe(false);
    });

    it("asks for a JSON answer through one tool it must call", () => {
      const turn = readTurn({ input: [user("Plan it")], responseFormat: { type: "json", name: "plan", schema: { type: "object", properties: { steps: { type: "array" } } } } });
      if ("error" in turn) throw new Error(turn.error);
      const ask = toClaude(turn);
      expect(ask.tools.map((t) => t.name)).toEqual(["plan"]);
      expect(ask.toolChoice).toEqual({ type: "tool", name: "plan" });
    });

    it("keeps the page's instructions after this app's own", () => {
      const turn = readTurn({ input: [user("x")], instructions: "Use the widgets.", responseFormat: { type: "text" } });
      if ("error" in turn) throw new Error(turn.error);
      const { system } = toClaude(turn);
      expect(system.indexOf("never invent")).toBeGreaterThan(-1);
      expect(system.indexOf("Use the widgets.")).toBeGreaterThan(system.indexOf("never invent"));
    });
  });

  describe("back to the page", () => {
    it("turns Claude's text and tool calls into AG Studio's output and events", () => {
      const turn = readTurn({ input: [user("x")], tools: [tool], responseFormat: { type: "text" } });
      if ("error" in turn) throw new Error(turn.error);
      const back = fromClaude(turn, {
        id: "msg_1",
        model: "claude-sonnet-5-5",
        stop_reason: "tool_use",
        content: [
          { type: "text", text: "Adding a chart." },
          { type: "tool_use", id: "toolu_1", name: "add_widget", input: { kind: "chart" } },
        ],
        usage: { input_tokens: 10, output_tokens: 5 },
      });
      expect(back.response.status).toBe("completed");
      expect(back.response.output).toEqual([
        { id: "msg_1-text-0", kind: "output", type: "message", role: "assistant", status: "completed", content: [{ type: "text", text: "Adding a chart.", annotations: [] }] },
        { id: "msg_1-call-1", kind: "output", type: "function_call", callId: "toolu_1", name: "add_widget", arguments: '{"kind":"chart"}', status: "completed" },
      ]);
      expect(back.events.map((e) => e.type)).toEqual(["TEXT_MESSAGE_START", "TEXT_MESSAGE_CONTENT", "TEXT_MESSAGE_END", "TOOL_CALL_START", "TOOL_CALL_ARGS", "TOOL_CALL_END"]);
    });

    it("gives a JSON answer back as text, from the tool it was made to call", () => {
      const turn = readTurn({ input: [user("Plan it")], responseFormat: { type: "json", name: "plan", schema: { type: "object" } } });
      if ("error" in turn) throw new Error(turn.error);
      const back = fromClaude(turn, { id: "m", model: "x", stop_reason: "tool_use", content: [{ type: "tool_use", id: "t", name: "plan", input: { steps: [1] } }], usage: { input_tokens: 1, output_tokens: 1 } });
      expect(back.response.output).toEqual([{ id: "m-text-0", kind: "output", type: "message", role: "assistant", status: "completed", content: [{ type: "text", text: '{"steps":[1]}', annotations: [] }] }]);
    });

    it("says a cut-off answer is incomplete", () => {
      const turn = readTurn({ input: [user("x")], responseFormat: { type: "text" } });
      if ("error" in turn) throw new Error(turn.error);
      const back = fromClaude(turn, { id: "m", model: "x", stop_reason: "max_tokens", content: [{ type: "text", text: "Part" }], usage: { input_tokens: 1, output_tokens: 1 } });
      expect(back.response).toMatchObject({ status: "incomplete", incompleteDetails: { reason: "max_output_tokens" } });
    });
  });
});
