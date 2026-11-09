import { describe, expect, it, vi } from "vitest";
import { readTurn, toClaude } from "@/server/studio/turn";
import { leadWithRecallChecker, RECALL_AGENT_ID, RECALL_TOOL, recallCheckerAgent, recallNumberIn, recallToolLabel, runRecallCheck } from "./recallTool";

const checked = { recalls: 934, from: "2025-01-02", to: "2026-11-06", yearsMissing: [] as number[] };
const answer = (over: object = {}) => ({ results: [], more: 0, cleared: 0, notJudged: 0, mentioned: { recalls: [], total: 0 }, checked, note: "Rules comparing your text with CPSC's public records.", ...over });
const result = (over: object = {}) => ({ recallNumber: "26100", title: "ONTHEWEI Baby Loungers Recalled", recallDate: "2026-02-05", url: null, verdict: "MATCH", strength: "MODEL", tiedToRecall: true, sharesWords: true, reason: "model MY002", missing: [], ...over });

const ctx = () => ({
  signal: new AbortController().signal,
  run: { threadId: "t", runId: "r" },
  success: <T,>(response: string, data?: T) => ({ success: true as const, response, data }),
  error: (messages: string | string[]) => ({ success: false as const, issues: [messages].flat().map((message) => ({ message })) }),
});
const reply = (body: unknown, status = 200) => async () => new Response(JSON.stringify(body), { status });
const run = (args: { title?: string; model?: string }, send: typeof fetch) => runRecallCheck(args, ctx(), send);
// Through JSON, as AG Studio sends it to the model.
const said = (r: Awaited<ReturnType<typeof run>>) => (r.success ? JSON.parse(JSON.stringify(r.data)) : r.issues.map((i) => i.message).join(" "));

describe("checking a product from the dashboard's assistant", () => {
  it("asks this site's own check, with what was typed", async () => {
    const send = vi.fn(reply(answer()));
    await run({ title: "ONTHEWEI lounger & mat", model: "MY002" }, send as unknown as typeof fetch);
    const [url] = send.mock.calls[0] as unknown as [string];
    expect(url.startsWith("/api/check?")).toBe(true);
    const params = new URL(url, "https://x.test").searchParams;
    expect(params.get("title")).toBe("ONTHEWEI lounger & mat");
    expect(params.get("model")).toBe("MY002");
  });

  it("stops the check when the run is stopped", async () => {
    const stop = new AbortController();
    const send = vi.fn(reply(answer()));
    await runRecallCheck({ title: "crib" }, { ...ctx(), signal: stop.signal }, send as unknown as typeof fetch);
    expect((send.mock.calls[0] as unknown as [string, RequestInit])[1].signal).toBe(stop.signal);
  });

  it("gives the site's own sentence and the recall to read, on a match", async () => {
    const out = said(await run({ model: "MY002" }, reply(answer({ results: [result()] })) as unknown as typeof fetch));
    expect(out.kind).toBe("MATCH");
    expect(out.says).toMatch(/doesn't say this one is recalled/);
    expect(out.recalls).toEqual([{ recallNumber: "26100", title: "ONTHEWEI Baby Loungers Recalled", page: "/recall/26100", missing: null }]);
  });

  it("never reads as nothing found when a year of recalls is missing", async () => {
    const out = said(await run({ title: "crib" }, reply(answer({ checked: { ...checked, yearsMissing: [2025] } })) as unknown as typeof fetch));
    expect(out.kind).toBe("UNFINISHED");
  });

  it("never reads as nothing found when too many came near to read", async () => {
    const out = said(await run({ title: "crib" }, reply(answer({ notJudged: 3 })) as unknown as typeof fetch));
    expect(out.kind).toBe("UNFINISHED");
  });

  it("says a miss is a miss, and not that the product is safe", async () => {
    const out = said(await run({ title: "wooden spoon" }, reply(answer()) as unknown as typeof fetch));
    expect(out.kind).toBe("NOTHING");
    expect(out.says).toMatch(/That doesn't mean it's safe/);
  });

  it("keeps the answer short when many recalls come up, and says how many it left out", async () => {
    const results = Array.from({ length: 12 }, (_, i) => result({ recallNumber: `2610${i}` }));
    const out = said(await run({ title: "lounger" }, reply(answer({ results })) as unknown as typeof fetch));
    expect(out.recalls).toHaveLength(10);
    expect(out.notShown).toBe(2);
  });

  it.each([
    ["the check refusing the text", 400, { error: "give a product title in title, a model number in model, or both" }, /give a product title/],
    ["too many checks", 429, { error: "too many checks: try again in an hour" }, /try again in an hour/],
    ["the check failing", 503, { error: "the check could not run just now" }, /could not run/],
  ])("passes on %s as a failed call, never as an answer", async (_name, status, body, words) => {
    const r = await run({ title: "x" }, reply(body, status) as unknown as typeof fetch);
    expect(r.success).toBe(false);
    expect(said(r)).toMatch(words);
  });

  it.each([
    ["an empty object", {}],
    ["no results list", answer({ results: undefined })],
    ["no count of what was read", answer({ checked: undefined })],
    ["a count that isn't a number", answer({ more: "many" })],
    ["a negative count", answer({ more: -1 })],
    ["more recalls found than listed, with none listed", answer({ more: 3 })],
    ["a count of recalls that share words, with none listed", answer({ mentioned: { recalls: [], total: 3 } })],
    ["more recalls listed than counted", answer({ mentioned: { recalls: [{ recallNumber: "1", title: "t" }], total: 0 } })],
    ["a result with no word on whether it's tied", answer({ results: [{ ...result(), tiedToRecall: undefined }] })],
    ["a result with no word on what it shares", answer({ results: [{ ...result(), verdict: "SCOPE_GAP", tiedToRecall: false, sharesWords: undefined }] })],
    ["a result with a verdict the site never gives", answer({ results: [result({ verdict: "SAFE" })] })],
    ["a result with no recall number", answer({ results: [result({ recallNumber: undefined })] })],
    ["no list of what a result is missing", answer({ results: [result({ missing: undefined })] })],
    ["a count of recalls read that isn't whole", answer({ checked: { ...checked, recalls: 1.5 } })],
    ["no list of missing years", answer({ checked: { ...checked, yearsMissing: undefined } })],
    ["no note", answer({ note: undefined })],
    ["no list of recalls that share words", answer({ mentioned: undefined })],
  ])("treats %s as a failed check, because a broken answer must not read as nothing found", async (_name, body) => {
    const r = await run({ title: "x" }, reply(body) as unknown as typeof fetch);
    expect(r.success).toBe(false);
  });

  it("shows a failed check as a check that didn't run, on the owner's row", async () => {
    const r = await run({ title: "x" }, reply(answer({ mentioned: { recalls: [], total: 3 } })) as unknown as typeof fetch);
    expect(recallToolLabel({ args: { title: "x" }, status: "done", result: r as never }).pill).toBe("Didn't run");
  });

  it("treats a page that isn't JSON as a failed check", async () => {
    const send = async () => new Response("<html>", { status: 200 });
    expect((await run({ title: "x" }, send as unknown as typeof fetch)).success).toBe(false);
  });

  it("says the page couldn't reach the server, and doesn't throw", async () => {
    const send = async () => { throw new TypeError("fetch failed"); };
    const r = await run({ title: "x" }, send as unknown as typeof fetch);
    expect(r.success).toBe(false);
    expect(said(r)).toMatch(/couldn't reach/);
  });
});

describe("the short answer the model reads first", () => {
  it("is the site's own sentence", async () => {
    const r = await run({ title: "wooden spoon" }, reply(answer()) as unknown as typeof fetch);
    expect(r.success && r.response).toMatch(/That doesn't mean it's safe/);
  });
});

describe("the row the owner sees for each check", () => {
  const done = (data: object) => ({ args: { title: "ONTHEWEI bath seat", model: "MY002" }, status: "done" as const, result: { success: true as const, response: "x", data: data as never } });

  it("names what was checked, while it runs", () => {
    expect(recallToolLabel({ args: { title: "ONTHEWEI bath seat", model: "MY002" }, status: "executing" })).toEqual({ text: "CPSC recall check: ONTHEWEI bath seat, MY002" });
  });

  it("copes with arguments that haven't arrived yet", () => {
    expect(recallToolLabel({ args: {}, status: "streaming" })).toEqual({ text: "CPSC recall check" });
  });

  it("doesn't let a long title push the result off the row", () => {
    expect(recallToolLabel({ args: { title: "x".repeat(200) }, status: "executing" }).text.length).toBeLessThanOrEqual(80);
  });

  it.each([
    ["MATCH", "Matches a recall"],
    ["CANT_TELL", "Can't tell yet"],
    ["NOT_NAMED", "None names it"],
    ["NOTHING", "None found"],
    ["UNFINISHED", "Can't say yet"],
  ])("shows %s as %s", (kind, pill) => {
    expect(recallToolLabel(done({ kind })).pill).toBe(pill);
  });

  it("says when the check didn't run, and shows no result", () => {
    const failed = { args: { title: "x" }, status: "done" as const, result: { success: false as const, issues: [{ message: "no" }] } };
    expect(recallToolLabel(failed).pill).toBe("Didn't run");
  });

  it("shows no result for a settled call with an answer it can't read", () => {
    expect(recallToolLabel(done({})).pill).toBeUndefined();
  });
});

describe("what a right-click on the dashboard knows", () => {
  // Captured from AG Studio 3.1.0, right-clicking a row of the recall list.
  const row = { operator: "AND", conditions: [
    { operator: "equals", options: { matchCase: true }, field: { id: "recalls.recallNumber" }, value: "27072" },
    { operator: "equals", options: { matchCase: true }, field: { id: "recalls.outcome" }, value: "Matched" },
  ] };

  it("finds the recall number on a grid row", () => {
    expect(recallNumberIn(row)).toBe("27072");
  });

  it("finds it when it's the only condition", () => {
    expect(recallNumberIn(row.conditions[0])).toBe("27072");
  });

  it.each([
    ["nothing right-clicked", undefined],
    ["a chart bar, which has no recall number", { operator: "equals", field: { id: "recalls.outcome" }, value: "Matched" }],
    ["a value that isn't a recall number", { operator: "equals", field: { id: "recalls.recallNumber" }, value: "../../admin" }],
    ["a range rather than one recall", { operator: "notEquals", field: { id: "recalls.recallNumber" }, value: "27072" }],
    ["either of two recalls", { operator: "OR", conditions: [{ operator: "equals", field: { id: "recalls.recallNumber" }, value: "27072" }] }],
  ])("offers no recall for %s", (_name, filter) => {
    expect(recallNumberIn(filter)).toBeNull();
  });
});

describe("what the model is told about the tool", () => {
  it("reaches Claude through the turn route, and is not dropped", () => {
    const user = { id: "u1", kind: "input", type: "message", role: "user", status: "completed", content: [{ type: "text", text: "Check this crib" }] };
    // The shape AG Studio builds from the tool's params. The turn route drops any tool that mentions money, so this has to pass.
    const parameters = { type: "object", properties: { title: { type: "string", description: RECALL_TOOL.titleHelp }, model: { type: "string", description: RECALL_TOOL.modelHelp } } };
    const turn = readTurn({ input: [user], tools: [{ name: RECALL_TOOL.name, description: RECALL_TOOL.description, parameters }], toolChoice: "auto", responseFormat: { type: "text" } });
    if ("error" in turn) throw new Error(turn.error);
    expect(toClaude(turn).tools.map((t) => t.name)).toEqual([RECALL_TOOL.name]);
  });
});

describe("the lead agent", () => {
  const dashboardTool = { name: "add_widget" } as never;
  const builtInDelegate = { name: "delegate_to" } as never;
  const lead = { id: "lead", instructions: () => "Plan and delegate.", tools: () => [dashboardTool, builtInDelegate] };
  const delegateTo = vi.fn((ids: readonly string[]) => ({ name: "delegate_to", targets: ids }) as never);
  const wired = leadWithRecallChecker(lead, delegateTo);
  const tools = wired.tools?.({} as never, undefined) ?? [];

  it("can hand work to the recall checker as well as AG's specialists", () => {
    const asked = vi.fn(() => ({ name: "delegate_to" }) as never);
    leadWithRecallChecker(lead, asked);
    expect(asked).toHaveBeenCalledWith(["data", "page", "planning", "widget", RECALL_AGENT_ID]);
  });

  it("has one delegate tool, because Claude refuses two tools with the same name", () => {
    expect(tools.filter((t) => t.name === "delegate_to")).toHaveLength(1);
    expect((tools.find((t) => t.name === "delegate_to") as unknown as { targets: string[] }).targets).toContain(RECALL_AGENT_ID);
  });

  it("keeps its dashboard tools", () => {
    expect(tools).toContain(dashboardTool);
  });

  it("repeats the checker's answer word for word", () => {
    expect(wired.instructions?.({} as never, undefined)).toMatch(/word for word/i);
  });

  it("says the check didn't run when the checker comes back with nothing", () => {
    expect(wired.instructions?.({} as never, undefined)).toMatch(/didn't run/i);
  });

  it("keeps AG's own instructions, and sends a product check to the checker instead of answering from the dashboard", () => {
    const told = wired.instructions?.({} as never, undefined) ?? "";
    expect(told.startsWith("Plan and delegate.")).toBe(true);
    expect(told).toContain(RECALL_AGENT_ID);
    expect(told).toMatch(/don't answer from the dashboard/i);
  });
});

describe("the recall checker agent", () => {
  const tool = { name: RECALL_TOOL.name } as never;
  const agent = recallCheckerAgent(tool);

  it("has exactly the one read-only tool, so it can't change the dashboard or touch money", () => {
    expect(agent.tools?.({} as never, undefined as never)).toEqual([tool]);
  });

  it("describes itself, so the lead agent can hand a product to it", () => {
    expect(agent.description).toMatch(/CPSC/);
    expect(agent.name).toBe("Recall checker");
  });

  it("is told never to call a product safe or recalled", () => {
    const told = agent.instructions?.({} as never, undefined as never) ?? "";
    expect(told).toMatch(/never say a product is safe/i);
    expect(told).toMatch(/says/);
  });

  it("hands its whole answer back, because the lead only receives what it passes to complete_task", () => {
    const told = agent.instructions?.({} as never, undefined as never) ?? "";
    expect(told).toMatch(/complete_task/);
    expect(told).toMatch(/word for word/i);
  });

  it("says when some recalls weren't listed", () => {
    expect(agent.instructions?.({} as never, undefined as never)).toMatch(/notShown/);
  });

  it("gives up after a few rounds rather than looping", () => {
    expect(agent.maxTurns).toBeLessThanOrEqual(6);
  });
});
