import { judgeRefusal } from "@/server/paypal/judgeRefusal";
import { fromThisSite, refused } from "@/server/web/http";
import { clientIp, createRateLimiter } from "@/server/web/rateLimit";

export const dynamic = "force-dynamic";

const HOUR = 60 * 60_000;
const perVisitor = createRateLimiter({ limit: 5, windowMs: HOUR });
const everyone = createRateLimiter({ limit: 60, windowMs: HOUR });

export async function POST(request: Request): Promise<Response> {
  if (!fromThisSite(request)) return refused(403, "Open this test from the judge page on this site.");
  const visitor = clientIp(request.headers);
  if (!visitor || !perVisitor(visitor) || !everyone("all")) return refused(429, "Too many tries. Try again in an hour.");
  return Response.json(await judgeRefusal(), { headers: { "cache-control": "no-store" } });
}
