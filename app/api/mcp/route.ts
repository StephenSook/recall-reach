import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { z } from "zod";
import { getDb } from "@/server/db/pg";
import { readCappedBody } from "@/server/http/body";
import { checkText, MAX_MODEL, MAX_TITLE, readTextCheck } from "@/server/match/textCheck";
import { businessDay } from "@/server/time/businessDay";
import { countPublicCall } from "@/server/web/publicCalls";
import { publicCheckAllowed } from "@/server/web/publicCheck";

export const dynamic = "force-dynamic";

const MAX_BODY = 64 * 1024;
const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "POST, OPTIONS",
  "access-control-allow-headers": "content-type, accept, mcp-protocol-version, mcp-session-id",
};

const refusal = (text: string) => ({ isError: true, content: [{ type: "text" as const, text }] });

/** One tool. It reads public recalls with the same rules as /api/check, and can't change anything or reach a shop. */
function recallServer(headers: Headers): McpServer {
  const server = new McpServer({ name: "recall-reach", version: "1.0.0" });
  server.registerTool(
    "check_recall",
    {
      title: "Check a product against CPSC recalls",
      description:
        "Before listing or buying a secondhand product, check its title or model number against real U.S. CPSC recalls. A result names a recall to read, not a finding about the item: MATCH means the text shows what the recall names, and SCOPE_GAP means it comes close to what the recall names, but the text can't show this item is covered. An empty result means nothing came near, not that the item is safe.",
      inputSchema: {
        title: z.string().max(MAX_TITLE).optional().describe("The product's title, as a listing or a label would say it."),
        model: z.string().max(MAX_MODEL).optional().describe("The model number, if there is one."),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ title, model }) => {
      if (!publicCheckAllowed(headers)) return refusal("too many checks: try again in an hour");
      const input = readTextCheck(title, model);
      if ("error" in input) return refusal(input.error);
      try {
        const db = getDb();
        const day = businessDay();
        const answer = await checkText(db, input, day);
        await countPublicCall(db, "mcp", day);
        return { content: [{ type: "text" as const, text: JSON.stringify(answer) }] };
      } catch (err) {
        // The name only: a database error can quote the text it was given.
        console.error("mcp recall check failed:", err instanceof Error ? err.name : "unknown error");
        return refusal("the check could not run just now");
      }
    },
  );
  return server;
}

const withCors = (res: Response) => {
  for (const [name, value] of Object.entries(CORS)) res.headers.set(name, value);
  return res;
};

// Stateless Streamable HTTP: each request stands alone, so there is no session to hold and nothing kept between calls.
export async function POST(request: Request): Promise<Response> {
  const read = await readCappedBody(request, MAX_BODY);
  if (!read.ok) return withCors(Response.json({ error: "request too large" }, { status: 413 }));
  const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  const server = recallServer(request.headers);
  await server.connect(transport);
  const answer = await transport.handleRequest(new Request(request.url, { method: "POST", headers: request.headers, body: read.body as BodyInit }));
  return withCors(new Response(answer.body, answer));
}

export function OPTIONS(): Response {
  return new Response(null, { status: 204, headers: CORS });
}

/** No server-sent stream: every answer comes back on its own POST. */
export function GET(): Response {
  return withCors(Response.json({ error: "this MCP server answers POST only" }, { status: 405, headers: { allow: "POST, OPTIONS" } }));
}
