import { getDb } from "@/server/db/pg";
import { readCappedBody } from "@/server/http/body";
import { OWN_FILE_DAYS } from "@/server/import/ownFile";
import { readStoreAddress, StoreFeedRefused } from "@/server/import/storeFeed";
import { importStoreListings } from "@/server/import/storeListings";
import { businessDay } from "@/server/time/businessDay";
import { fromThisSite, refused, seeOther, signIn, withMessage } from "@/server/web/http";
import { ownCheckAllowed } from "@/server/web/ownCheck";
import { createRateLimiter } from "@/server/web/rateLimit";

export const dynamic = "force-dynamic";

/** However many people ask, one store isn't read more than this. */
const perStore = createRateLimiter({ limit: 6, windowMs: 60 * 60_000 });
const MAX_FORM_BYTES = 2048;

// This route fetches an address a stranger typed. server/import/storeFeed.ts is what makes that safe.
export async function POST(request: Request): Promise<Response> {
  if (!fromThisSite(request)) return refused(403, "wrong origin");
  const back = (code: string) => seeOther(request, `/check?error=${code}`);
  const read = await readCappedBody(request, MAX_FORM_BYTES);
  if (!read.ok) return back("BAD_ADDRESS");
  try {
    const form = await new Response(read.body as BodyInit, { headers: { "content-type": request.headers.get("content-type") ?? "" } }).formData();
    // A typing slip costs no network and spends none of the visitor's checks.
    const host = readStoreAddress(String(form.get("address") ?? ""));
    if (!ownCheckAllowed(request.headers) || !perStore(host)) return back("BUSY");
    const { shopId, listings, complete } = await importStoreListings(getDb(), { typed: host, today: businessDay() });
    const response = complete ? seeOther(request, "/queue") : withMessage(request, `Read the first ${listings.toLocaleString("en-US")} listings. The rest weren't checked.`);
    return signIn(request, response, shopId, OWN_FILE_DAYS * 86_400_000);
  } catch (err) {
    if (err instanceof StoreFeedRefused) return back(err.code);
    // The name only: nothing here may put a store's name in a log.
    console.error("store listings failed:", err instanceof Error ? err.name : "unknown error");
    return back("FAILED");
  }
}
