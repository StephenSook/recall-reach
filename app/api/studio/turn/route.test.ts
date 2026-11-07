import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { migrate } from "@/server/db/migrate";
import type { Queryable } from "@/server/db/types";
import { testDb } from "@/test/pglite";

let db: Queryable;
const paths = vi.hoisted(() => ({ agent: vi.fn(), create: vi.fn() }));
vi.mock("@/server/db/pg", () => ({ getDb: () => db }));
vi.mock("@/server/agent/claude", async (original) => ({ ...(await original<typeof import("@/server/agent/claude")>()), agentClientFromEnv: paths.agent }));

import { POST } from "./route";

const ORIGIN = "http://localhost";
let ip = 0;
const turn = { input: [{ id: "u", kind: "input", type: "message", role: "user", status: "completed", content: [{ type: "text", text: "Show only matched recalls" }] }], tools: [{ name: "add_page_filter", description: "Filters the page.", parameters: { type: "object", properties: {} } }], toolChoice: "auto", responseFormat: { type: "text" } };
const post = (body: unknown, origin = ORIGIN, visitor = `198.51.100.${++ip % 250}`) =>
  POST(new Request(`${ORIGIN}/api/studio/turn`, { method: "POST", headers: { "content-type": "application/json", origin, "true-client-ip": visitor }, body: typeof body === "string" ? body : JSON.stringify(body) }));
const answer = { id: "msg_1", model: "claude-sonnet-5-5", stop_reason: "tool_use", content: [{ type: "tool_use", id: "toolu_1", name: "add_page_filter", input: { field: "outcome", value: "Matched" } }], usage: { input_tokens: 100, output_tokens: 20 } };

describe("POST /api/studio/turn", () => {
  let real: Awaited<ReturnType<typeof testDb>>;
  beforeEach(async () => {
    real = await testDb();
    await migrate(real);
    db = real;
    paths.create.mockReset();
    paths.create.mockResolvedValue(answer);
    paths.agent.mockReturnValue({ beta: { messages: { create: paths.create } } });
  });
  afterEach(async () => {
    await real.close();
  });

  it("asks Claude once, with this app's instructions and AG Studio's tools, and answers in AG Studio's shapes", async () => {
    const res = await post(turn);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.response.output[0]).toMatchObject({ type: "function_call", name: "add_page_filter", callId: "toolu_1" });
    expect(body.events.map((e: { type: string }) => e.type)).toEqual(["TOOL_CALL_START", "TOOL_CALL_ARGS", "TOOL_CALL_END"]);
    expect(paths.create).toHaveBeenCalledTimes(1);
    const sent = paths.create.mock.calls[0][0];
    expect(sent.tools.map((t: { name: string }) => t.name)).toEqual(["add_page_filter"]);
    expect(sent.system).toContain("never invent");
  });

  it("counts what it spends against the day's limit, and stops at the limit", async () => {
    await post(turn);
    const { rows } = await real.query<{ cost_micros: string }>("select cost_micros::text from agent_spend");
    expect(Number(rows[0].cost_micros)).toBeGreaterThan(0);
    await real.query("update agent_spend set cost_micros = 10000000");
    const res = await post(turn);
    expect(res.status).toBe(429);
    expect((await res.json()).error).toBe("Today's AI limit for this demo is used up. The dashboard still works by hand, and /evidence/ag-grid shows a real run of this agent from Nov 7, 2026.");
  });

  it("lets only two turns wait on Claude at once, so a burst can't pass the day's limit together", async () => {
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    paths.create.mockImplementation(async () => {
      await held;
      return answer;
    });
    const waiting = [post(turn), post(turn)];
    await vi.waitFor(() => expect(paths.create).toHaveBeenCalledTimes(2));
    const busy = await post(turn);
    expect(busy.status).toBe(429);
    expect((await busy.json()).error).toContain("busy");
    expect(paths.create).toHaveBeenCalledTimes(2);
    release();
    for (const res of await Promise.all(waiting)) expect(res.status).toBe(200);
    expect((await post(turn)).status).toBe(200);
  });

  it("refuses a conversation past 160 KB, in words a visitor can act on, and asks Claude nothing", async () => {
    const long = { ...turn, input: [...turn.input, { ...turn.input[0], content: [{ type: "text", text: "x".repeat(19_000) }] }] };
    const big = { ...long, input: Array.from({ length: 9 }, () => long.input[1]) };
    expect(JSON.stringify(big).length).toBeGreaterThan(160 * 1024);
    const res = await post(big);
    expect(res.status).toBe(413);
    expect((await res.json()).error).toBe("This chat is too long. Start a new chat to keep going.");
    expect(paths.create).not.toHaveBeenCalled();
  });

  it("frees a turn's place when Claude fails", async () => {
    paths.create.mockRejectedValue(new Error("overloaded"));
    for (let i = 0; i < 4; i++) expect((await post(turn)).status).toBe(502);
    paths.create.mockResolvedValue(answer);
    expect((await post(turn)).status).toBe(200);
  });

  it.each([
    ["another site", () => post(turn, "https://example.com")],
    ["something that isn't a turn", () => post({ input: [{ type: "image_generation" }], responseFormat: { type: "text" } })],
    ["a body far bigger than a turn needs", () => post({ ...turn, instructions: "x".repeat(400_000) })],
  ])("refuses %s, and asks Claude nothing", async (_name, send) => {
    const res = await send();
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(paths.create).not.toHaveBeenCalled();
  });

  it("lets one visitor ask about four times an hour, at about 15 turns an ask, and then stops them", async () => {
    let last = await post(turn, ORIGIN, "203.0.113.9");
    for (let i = 1; i < 60; i++) last = await post(turn, ORIGIN, "203.0.113.9");
    expect(last.status).toBe(200);
    expect((await post(turn, ORIGIN, "203.0.113.9")).status).toBe(429);
  });

  it("says so when there's no Claude to ask", async () => {
    paths.agent.mockReturnValue(null);
    const res = await post(turn);
    expect(res.status).toBe(503);
  });

  it("stores nothing it was sent", async () => {
    await post({ ...turn, input: [{ ...turn.input[0], content: [{ type: "text", text: "SECRET-TURN-TEXT" }] }] });
    const tables = await real.query<{ relname: string }>("select relname from pg_class where relkind = 'r' and relnamespace = 'public'::regnamespace");
    for (const { relname } of tables.rows) {
      const { rows } = await real.query(`select * from ${relname}`);
      expect(JSON.stringify(rows)).not.toContain("SECRET-TURN-TEXT");
    }
  });
});
