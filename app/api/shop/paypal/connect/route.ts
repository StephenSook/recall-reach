import { getDb } from "@/server/db/pg";
import { withCallLog } from "@/server/paypal/callLog";
import { platformFromEnv } from "@/server/paypal/platform";
import { recordKeyFromEnv } from "@/server/privacy/recordKey";
import { startConnect } from "@/server/shop/connectFlow";
import { baseUrl, currentSession, fromThisSite, refused, withMessage } from "@/server/web/http";

export const dynamic = "force-dynamic";

// A real shop starts connecting its own PayPal account: Partner Referrals, then PayPal's own sign-up page.
export async function POST(request: Request): Promise<Response> {
  const session = await currentSession();
  if (!session || !fromThisSite(request)) return refused(401, "sign in as a shop first");
  const db = getDb();
  const { rows } = await db.query<{ kind: string }>("select kind from shops where id = $1", [session.shopId]);
  if (rows[0]?.kind !== "REAL") return withMessage(request, "A demo shop uses the demo's own sandbox account. Connecting is for your own shop.");
  const platform = platformFromEnv();
  if (!platform) return withMessage(request, "Connecting a PayPal account isn't set up on this site yet.");
  const recordKey = recordKeyFromEnv();
  if (!recordKey) throw new Error("RECORD_HMAC_SECRET is not set");
  const started = await withCallLog(db, session.shopId, () => startConnect(db, platform, { shopId: session.shopId, recordKey, returnUrl: `${baseUrl(request)}/api/shop/paypal/back`, now: new Date() }));
  if ("refusal" in started) return withMessage(request, `PayPal didn't start connecting your account. ${started.refusal}`);
  return new Response(null, { status: 303, headers: { Location: started.actionUrl } });
}
