import { readFileSync } from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { testDb } from "@/test/pglite";
import { pullRecalls } from "@/server/cpsc/pull";
import { migrate } from "@/server/db/migrate";
import type { Queryable } from "@/server/db/types";

let db: Queryable;
vi.mock("@/server/db/pg", () => ({ getDb: () => db }));

import { GET, OPTIONS, POST } from "./route";

const fixtureText = readFileSync(new URL("../../../test/fixtures/cpsc/recalls_2026-10-01_to_2026-11-05.json", import.meta.url), "utf8");

// A real MCP client, speaking the real protocol, with the route in place of a network.
async function connect(ip = `192.0.2.${Math.floor(Math.random() * 250)}`) {
  const client = new Client({ name: "test", version: "1.0.0" });
  const transport = new StreamableHTTPClientTransport(new URL("http://localhost/api/mcp"), {
    fetch: (async (url: string | URL, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      headers.set("true-client-ip", ip);
      if ((init?.method ?? "GET") === "GET") return GET();
      return POST(new Request(url, { ...init, headers }));
    }) as typeof fetch,
  });
  await client.connect(transport);
  return client;
}

const answerOf = (result: unknown) => JSON.parse((result as { content: { text: string }[] }).content[0].text);

describe("the MCP tool", () => {
  let real: Awaited<ReturnType<typeof testDb>>;
  beforeEach(async () => {
    real = await testDb();
    await migrate(real);
    db = real;
    const fetchImpl = async () => new Response(fixtureText, { status: 200, headers: { "content-type": "application/json" } });
    await pullRecalls(real, { field: "RecallDate", start: "2026-10-01", end: "2026-11-05" }, { fetchImpl: fetchImpl as typeof fetch });
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await real.close();
  });

  it("offers one tool, which says it only reads", async () => {
    const { tools } = await (await connect()).listTools();
    expect(tools.map((t) => t.name)).toEqual(["check_recall"]);
    expect(tools[0].annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false });
    expect(tools[0].description).toContain("not a finding");
    expect(tools[0].description).toContain("not that the item is safe");
  });

  it("gives the same answer as /api/check, with the shop's rules", async () => {
    const result = await (await connect()).callTool({ name: "check_recall", arguments: { title: "Baby Brezza sterilizer", model: "BRZ0083" } });
    expect(result.isError).toBeFalsy();
    expect(answerOf(result).results[0]).toMatchObject({ recallNumber: "27072", verdict: "MATCH" });
  });

  it("says plainly when nothing comes near", async () => {
    const answer = answerOf(await (await connect()).callTool({ name: "check_recall", arguments: { title: "zzqx vvbn plmk" } }));
    expect(answer.results).toEqual([]);
    expect(answer.checked.recalls).toBe(55);
  });

  it("says what it needs when given nothing to check", async () => {
    const result = await (await connect()).callTool({ name: "check_recall", arguments: {} });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toContain("title");
  });

  it("counts a check, and stores none of its text", async () => {
    await (await connect()).callTool({ name: "check_recall", arguments: { title: "SECRET-TITLE chair" } });
    const { rows } = await real.query<{ surface: string; calls: number }>("select surface, calls from public_calls");
    expect(rows).toEqual([{ surface: "mcp", calls: 1 }]);
    const dump = JSON.stringify((await real.query("select row_to_json(p) from public_calls p")).rows);
    expect(dump).not.toContain("SECRET-TITLE");
  });

  it("shares the public limit with /api/check", async () => {
    const client = await connect("203.0.113.77");
    let last: unknown;
    for (let i = 0; i < 61; i++) last = await client.callTool({ name: "check_recall", arguments: { title: "chair" } });
    expect((last as { isError?: boolean }).isError).toBe(true);
    expect(JSON.stringify((last as { content: unknown }).content)).toContain("too many");
  });

  it("doesn't repeat what it was asked when the database fails", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    const client = await connect();
    db = {
      query: async () => {
        throw new Error("failed on a query holding SECRET-TITLE");
      },
      exec: async () => {},
    };
    const result = await client.callTool({ name: "check_recall", arguments: { title: "SECRET-TITLE" } });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result)).not.toContain("SECRET-TITLE");
    expect(JSON.stringify(logged.mock.calls)).not.toContain("SECRET-TITLE");
  });

  it("answers one plain JSON-RPC call with no session, the curl the page prints", async () => {
    const res = await POST(
      new Request("http://localhost/api/mcp", {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json, text/event-stream", "true-client-ip": "192.0.2.251" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "check_recall", arguments: { title: "Baby Brezza sterilizer", model: "BRZ0083" } } }),
      }),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
    const body = await res.json();
    expect(JSON.parse(body.result.content[0].text).results[0].recallNumber).toBe("27072");
  });

  it("refuses an oversized request before reading it", async () => {
    const res = await POST(new Request("http://localhost/api/mcp", { method: "POST", body: "x".repeat(70_000) }));
    expect(res.status).toBe(413);
  });

  it("can be reached from a page on another site", async () => {
    const res = OPTIONS();
    expect(res.status).toBe(204);
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
    expect(res.headers.get("access-control-allow-methods")).toContain("POST");
  });

  it("answers GET with why not, rather than holding a stream open", async () => {
    const res = GET();
    expect(res.status).toBe(405);
    expect(res.headers.get("allow")).toContain("POST");
  });
});
