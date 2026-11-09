import { getDb } from "@/server/db/pg";
import { checkListing, namingResults } from "@/server/match/textCheck";
import { payPalClientFromEnv } from "@/server/paypal/client";
import { SlipRefused, startShopperOrder } from "@/server/paypal/shopperOrder";
import { recordKeyFromEnv } from "@/server/privacy/recordKey";
import { channel3Listings } from "@/server/sweep/channel3";
import { businessDay } from "@/server/time/businessDay";
import { baseUrl, fromThisSite, refused, seeOther } from "@/server/web/http";
import { clientIp, createRateLimiter } from "@/server/web/rateLimit";
import type { TextCheckAnswer } from "@/server/match/textCheck";

export const dynamic = "force-dynamic";

const perVisitor = createRateLimiter({ limit: 10, windowMs: 60 * 60_000 });

/** Reads the listing and the recall check again, starts a sandbox order, and sends the person to approve it on PayPal's page. */
export async function POST(request: Request): Promise<Response> {
  if (!fromThisSite(request)) return refused(403, "wrong origin");
  // Only the page's executor reads this response; it never forwards it to the visiting assistant.
  const forTools = request.headers.get("accept") === "application/json";
  const visitor = clientIp(request.headers);
  if (!visitor || !perVisitor(visitor)) return forTools ? refused(429, "too many tries: try again in an hour") : seeOther(request, "/shopper?error=BUSY");
  const recordKey = recordKeyFromEnv();
  if (!recordKey) return refused(503, "the server is missing its record key");
  const form = await request.formData();
  const db = getDb();
  const now = new Date();
  let answer: TextCheckAnswer | undefined;
  try {
    const { approveUrl } = await startShopperOrder(db, payPalClientFromEnv(), { slipId: String(form.get("slip") ?? ""), siteUrl: baseUrl(request), recordKey, now }, {
      read: channel3Listings().read,
      check: async (listing) => {
        answer = await checkListing(db, listing, businessDay(now));
        return answer;
      },
    });
    if (forTools) return Response.json({ approveUrl }, { headers: { "cache-control": "no-store" } });
    return new Response(null, { status: 303, headers: { Location: approveUrl } });
  } catch (err) {
    if (forTools) {
      // No exception text, provider fields, order identifiers or amounts leave through the tool's refusal path.
      // Only a recall the listing's words are tied to is named: "couldn't rule it out" is not "refused under this recall".
      const recalls = err instanceof SlipRefused && err.code === "NOW_FLAGGED" && answer ? namingResults(answer).map((r) => ({ recallNumber: r.recallNumber, title: r.title })) : [];
      return Response.json({ refused: true, error: "Checkout could not start. Search again or read the CPSC recall.", recalls }, { status: err instanceof SlipRefused ? 409 : 503, headers: { "cache-control": "no-store" } });
    }
    if (err instanceof SlipRefused) return seeOther(request, `/shopper?error=${err.code}`);
    console.error("shopper order failed:", err instanceof Error ? err.name : "unknown error");
    return seeOther(request, "/shopper?error=FAILED");
  }
}
