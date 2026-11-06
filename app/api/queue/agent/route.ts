import { checkRecordWithClaude } from "@/server/agent/checkRecord";
import { agentClientFromEnv } from "@/server/agent/claude";
import { getDb } from "@/server/db/pg";
import { createRateLimiter } from "@/server/web/rateLimit";
import { currentSession, fromThisSite, refused, seeOther, withMessage } from "@/server/web/http";

export const dynamic = "force-dynamic";

const UNAVAILABLE = "Claude check unavailable. Everything else still works.";
const perShop = createRateLimiter({ limit: 30, windowMs: 60 * 60 * 1000 });

// "Check with Claude": reads and records only. It cannot change a verdict, send anything or move money.
export async function POST(request: Request): Promise<Response> {
  const session = await currentSession();
  if (!session || !fromThisSite(request)) return refused(401, "sign in as a shop first");
  const client = agentClientFromEnv();
  if (!client) return withMessage(request, UNAVAILABLE);
  if (!perShop(session.shopId)) return withMessage(request, "Too many checks. Try again in a while.");
  const form = await request.formData();
  const result = await checkRecordWithClaude(getDb(), client, { shopId: session.shopId, recordId: String(form.get("recordId") ?? ""), now: new Date() });
  if (result.overBudget) return withMessage(request, "Claude check has reached today's limit. Everything else still works.");
  if (result.unavailable) {
    console.error(`Claude check unavailable: ${result.failedStatuses.join(", ") || "no status"}`);
    return withMessage(request, UNAVAILABLE);
  }
  return seeOther(request, "/queue");
}
