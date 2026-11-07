import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { z } from "zod";
import { getDb } from "@/server/db/pg";
import { readCappedBody } from "@/server/http/body";
import { checkText, isRecallNumber, MAX_MODEL, MAX_TITLE, readPublicRecall, readTextCheck } from "@/server/match/textCheck";
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
/** The same answer twice: as text for a client that only reads text, and in the shape the tool publishes. */
const answered = <T extends object>(answer: T) => ({ content: [{ type: "text" as const, text: JSON.stringify(answer) }], structuredContent: answer as T & Record<string, unknown> });

const INSTRUCTIONS =
  "These tools read public U.S. CPSC recalls. Never tell a user an item is safe or isn't recalled because a search found nothing: an empty result means nothing came near. A result names a recall to read, not a finding about the item. Only CPSC's notice and the item itself can settle it. Car seats are recalled through NHTSA, so check nhtsa.gov/recalls for those.";

const CHECK_OUTPUT = {
  results: z.array(
    z.object({
      recallNumber: z.string(),
      title: z.string(),
      recallDate: z.string(),
      url: z.string().nullable(),
      verdict: z.enum(["MATCH", "SCOPE_GAP"]).describe("MATCH: the text shows what the recall names. SCOPE_GAP: it comes close, but the text can't show this item is covered."),
      strength: z.string(),
      tiedToRecall: z.boolean().describe("The text has this recall's model, a code close to it, or its maker and product line. Otherwise it only shares a kind of product."),
      reason: z.string(),
      missing: z.array(z.string()),
    }),
  ).describe("Recalls to read. Empty means nothing came near, not that the item is safe."),
  more: z.number().describe("Found, past what's listed."),
  cleared: z.number().describe("Came near and were ruled out."),
  notJudged: z.number().describe("Came near but weren't judged. Above zero, an empty list doesn't mean nothing was found."),
  sameMaker: z.array(z.object({ recallNumber: z.string(), title: z.string() })).describe("Ruled out, but from the same maker. A maker given alone ends up here, so don't read an empty results list as nothing near."),
  checked: z.object({ recalls: z.number(), from: z.string().nullable(), to: z.string().nullable(), yearsMissing: z.array(z.number()) }),
  note: z.string(),
};

const READ_OUTPUT = {
  found: z.boolean(),
  note: z.string().optional(),
  recallNumber: z.string().optional(),
  title: z.string().optional(),
  recallDate: z.string().optional(),
  url: z.string().optional(),
  description: z.string().optional(),
  products: z.array(z.object({ name: z.string(), model: z.string(), type: z.string().nullable(), units: z.string().nullable() })).optional(),
  hazards: z.array(z.string()).optional(),
  remedies: z.array(z.string()).optional(),
  image: z.object({ url: z.string(), caption: z.string() }).nullable().optional().describe("CPSC's own photo and its caption, if it has one."),
};

/** Two tools. They read public recalls, one with the same rules as /api/check, and can't change anything or reach a shop. */
function recallServer(headers: Headers): McpServer {
  const server = new McpServer({ name: "recall-reach", version: "1.0.0" }, { instructions: INSTRUCTIONS });
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
      outputSchema: CHECK_OUTPUT,
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
        return answered(answer);
      } catch (err) {
        // The name only: a database error can quote the text it was given.
        console.error("mcp recall check failed:", err instanceof Error ? err.name : "unknown error");
        return refusal("the check could not run just now");
      }
    },
  );
  server.registerTool(
    "get_recall",
    {
      title: "Read one CPSC recall",
      description: "CPSC's public record for one recall number: its title, date, products, hazards, remedies, photo and its page. check_recall names a recall, and this reads it.",
      inputSchema: { recallNumber: z.string().max(40).describe("The recall number, as check_recall gives it, such as 27072.") },
      outputSchema: READ_OUTPUT,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ recallNumber }) => {
      if (!publicCheckAllowed(headers)) return refusal("too many checks: try again in an hour");
      if (!isRecallNumber(recallNumber)) return refusal("that isn't a recall number");
      try {
        const db = getDb();
        const answer = await readPublicRecall(db, recallNumber);
        await countPublicCall(db, "mcp", businessDay());
        return answered(answer);
      } catch (err) {
        console.error("mcp recall read failed:", err instanceof Error ? err.name : "unknown error");
        return refusal("the recall could not be read just now");
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
