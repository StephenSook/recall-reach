import { getDb } from "@/server/db/pg";
import { checkText, MAX_TITLE } from "@/server/match/textCheck";
import { payPalClientFromEnv } from "@/server/paypal/client";
import { SlipRefused, startShopperOrder } from "@/server/paypal/shopperOrder";
import { channel3Listings } from "@/server/sweep/channel3";
import { businessDay } from "@/server/time/businessDay";
import { baseUrl, fromThisSite, refused, seeOther } from "@/server/web/http";
import { clientIp, createRateLimiter } from "@/server/web/rateLimit";

export const dynamic = "force-dynamic";

// Every result counts here, or a recall naming this listing could sit past the first few.
const ALL_NEAR = 200;

const perVisitor = createRateLimiter({ limit: 10, windowMs: 60 * 60_000 });

/** Reads the listing and the recall check again, starts a sandbox order, and sends the person to approve it on PayPal's page. */
export async function POST(request: Request): Promise<Response> {
  if (!fromThisSite(request)) return refused(403, "wrong origin");
  const visitor = clientIp(request.headers);
  if (!visitor || !perVisitor(visitor)) return seeOther(request, "/shopper?error=BUSY");
  const form = await request.formData();
  const db = getDb();
  const now = new Date();
  try {
    const { approveUrl } = await startShopperOrder(db, payPalClientFromEnv(), { slipId: String(form.get("slip") ?? ""), siteUrl: baseUrl(request), now }, {
      read: channel3Listings().read,
      check: (title) => checkText(db, { title: title.slice(0, MAX_TITLE), model: "" }, businessDay(now), { maxResults: ALL_NEAR }),
    });
    return new Response(null, { status: 303, headers: { Location: approveUrl } });
  } catch (err) {
    if (err instanceof SlipRefused) return seeOther(request, `/shopper?error=${err.code}`);
    console.error("shopper order failed:", err instanceof Error ? err.name : "unknown error");
    return seeOther(request, "/shopper?error=FAILED");
  }
}
