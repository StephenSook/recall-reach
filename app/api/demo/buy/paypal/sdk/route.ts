import { getDb } from "@/server/db/pg";
import { readCappedBody } from "@/server/http/body";
import { LiveSaleRefused, startPayPalBuy } from "@/server/demo/liveCatch";
import { withCallLog } from "@/server/paypal/callLog";
import { payPalClientFromEnv } from "@/server/paypal/client";
import { baseUrl, currentSession, fromThisSite, refused, secret } from "@/server/web/http";
import { createRateLimiter } from "@/server/web/rateLimit";

export const dynamic = "force-dynamic";

const MAX_FORM_BYTES = 2048;
const FORM_TIMEOUT_MS = 10_000;
const perShop = createRateLimiter({ limit: 10, windowMs: 60 * 60_000 });
const everyone = createRateLimiter({ limit: 60, windowMs: 60 * 60_000 });

export async function POST(request: Request): Promise<Response> {
  const session = await currentSession();
  if (!session || !fromThisSite(request)) return refused(401, "sign in as a shop first");
  if (!perShop(session.shopId) || !everyone("all")) return refused(429, "Too many sales from this shop. Try again in a while.");
  const read = await readCappedBody(request, MAX_FORM_BYTES, { timeoutMs: FORM_TIMEOUT_MS });
  if (!read.ok) return refused(413, "That request is too large or took too long to read.");
  try {
    const form = await new Response(read.body as BodyInit, { headers: { "content-type": request.headers.get("content-type") ?? "" } }).formData();
    const { orderId, returnUrl } = await withCallLog(getDb(), session.shopId, () => startPayPalBuy(getDb(), payPalClientFromEnv(), {
      shopId: session.shopId,
      sessionId: session.sessionId,
      shopItemId: String(form.get("shopItemId") ?? ""),
      siteUrl: baseUrl(request),
      sessionSecret: secret("SESSION_SECRET"),
    }));
    const state = new URL(returnUrl).searchParams.get("state");
    return Response.json({ orderId, state }, { headers: { "cache-control": "no-store" } });
  } catch (err) {
    if (err instanceof LiveSaleRefused) return refused(409, err.message);
    return refused(502, "PayPal could not start the sale. Try again.");
  }
}
