import type { BetaMessageParam, BetaToolUnion } from "@anthropic-ai/sdk/resources/beta/messages/messages";
import { agentClientFromEnv, askClaude, nothingSpent, OverBudget, withFallback } from "@/server/agent/claude";
import { getDb } from "@/server/db/pg";
import { readCappedBody } from "@/server/http/body";
import { type ClaudeAnswer, fromClaude, readTurn, toClaude } from "@/server/studio/turn";
import { fromThisSite, refused } from "@/server/web/http";
import { clientIp, createRateLimiter } from "@/server/web/rateLimit";

export const dynamic = "force-dynamic";

// A turn carries the conversation and what AG Studio's tools answered, so it's bigger than most requests here.
const MAX_BODY = 300 * 1024;
const HOUR = 60 * 60_000;
const perVisitor = createRateLimiter({ limit: 60, windowMs: HOUR });
const everyone = createRateLimiter({ limit: 300, windowMs: HOUR });
/** The dashboard's agent stops once the day's spending reaches this, leaving the rest of the day's limit to the queue. */
export const STUDIO_CAP_MICROS = 3_000_000;
const MAX_ANSWER_TOKENS = 2000;

const parseJson = (bytes: Uint8Array): unknown => {
  try {
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return null;
  }
};

// One turn for AG Studio's agent on /studio. The tools it names run in the browser, on the dashboard's own rows, which come
// from CPSC's records and the demo shop's item titles only. Nothing sent here is stored.
export async function POST(request: Request): Promise<Response> {
  if (!fromThisSite(request)) return refused(403, "wrong origin");
  const visitor = clientIp(request.headers);
  if (!visitor || !perVisitor(visitor) || !everyone("all")) return Response.json({ error: "Too many requests from here. Try again in an hour." }, { status: 429 });
  const read = await readCappedBody(request, MAX_BODY);
  if (!read.ok) return Response.json({ error: "request too large" }, { status: 413 });
  const turn = readTurn(parseJson(read.body));
  if ("error" in turn) return refused(400, turn.error);
  const client = agentClientFromEnv();
  if (!client) return Response.json({ error: "The dashboard's agent isn't set up here." }, { status: 503 });
  const ask = toClaude(turn);
  try {
    const db = getDb();
    const now = new Date();
    const answer = await withFallback((model) =>
      askClaude(
        db,
        client,
        { model, system: ask.system, tools: ask.tools as BetaToolUnion[], messages: ask.messages as BetaMessageParam[], now, capMicros: STUDIO_CAP_MICROS, maxTokens: MAX_ANSWER_TOKENS, toolChoice: ask.toolChoice },
        nothingSpent(),
      ),
    );
    return Response.json(fromClaude(turn, answer as unknown as ClaudeAnswer));
  } catch (err) {
    if (err instanceof OverBudget) return Response.json({ error: "The dashboard's agent has reached today's limit. Everything else still works." }, { status: 429 });
    console.error("studio turn failed:", err instanceof Error ? err.name : "unknown error");
    return Response.json({ error: "Claude didn't answer just now. Please try again." }, { status: 502 });
  }
}
