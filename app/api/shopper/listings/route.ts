import { getDb } from "@/server/db/pg";
import { checkListing, readListingCheck } from "@/server/match/textCheck";
import { createSlip } from "@/server/paypal/shopperOrder";
import { channel3Listings } from "@/server/sweep/channel3";
import { businessDay } from "@/server/time/businessDay";
import { baseUrl, fromThisSite, refused } from "@/server/web/http";
import { clientIp, createRateLimiter } from "@/server/web/rateLimit";

export const dynamic = "force-dynamic";
const perVisitor = createRateLimiter({ limit: 5, windowMs: 60 * 60_000 });
const headers = { "cache-control": "no-store" };

function sameOrigin(request: Request): boolean {
  if (request.headers.has("origin")) return fromThisSite(request);
  // Browsers omit Origin on same-origin GETs. Require both browser fetch metadata and the page's origin.
  try {
    return request.headers.get("sec-fetch-site") === "same-origin" && new URL(request.headers.get("referer") ?? "").origin === baseUrl(request);
  } catch {
    return false;
  }
}

export async function GET(request: Request): Promise<Response> {
  if (!sameOrigin(request)) return refused(403, "wrong origin");
  const visitor = clientIp(request.headers);
  if (!visitor || !perVisitor(visitor)) return refused(429, "too many searches: try again in an hour");
  const params = new URL(request.url).searchParams;
  const query = (params.get("query") ?? "").trim();
  const maxPrice = Number(params.get("maxPrice") ?? "2000");
  if (query.length < 2 || query.length > 200 || !Number.isFinite(maxPrice) || maxPrice < 1 || maxPrice > 2000) return refused(400, "give a query and a maximum price from 1 to 2000 USD");
  try {
    const db = getDb();
    const listings = await channel3Listings(undefined, { includeRetailer: true }).search(query);
    const offerable: { id: string; title: string; price: number; retailer: string | null; slipId: string }[] = [];
    const blocked: { id: string; title: string; recallNumber: string | null; recallTitle: string | null; why: string }[] = [];
    for (const listing of listings.filter((l) => l.priceCents <= Math.round(maxPrice * 100))) {
      request.signal.throwIfAborted();
      const answer = await checkListing(db, listing, businessDay());
      const result = readListingCheck(answer, listing);
      if (result === "NO_MATCH_FOUND") {
        const slip = await createSlip(db, listing, new Date());
        offerable.push({ id: listing.id, title: listing.title, price: listing.priceCents / 100, retailer: listing.retailer ?? null, slipId: slip.id });
      } else {
        const recalls = result === "NAMES_A_RECALL" ? answer.results.filter((r) => r.tiedToRecall) : answer.results;
        const why = result === "NAMES_A_RECALL" ? "Its words name a recall; read the CPSC notice." : "The recall check could not rule this listing out; a person must review it.";
        for (const recall of recalls.length ? recalls : [null]) blocked.push({ id: listing.id, title: listing.title, recallNumber: recall?.recallNumber ?? null, recallTitle: recall?.title ?? null, why });
      }
    }
    return Response.json({ offerable, refused: blocked }, { headers });
  } catch {
    return refused(503, "the listing search or recall check could not finish");
  }
}
