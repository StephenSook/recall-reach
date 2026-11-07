import { getDb } from "@/server/db/pg";
import { withCallLog } from "@/server/paypal/callLog";
import { payPalClientFromEnv, PayPalApiError } from "@/server/paypal/client";
import { PayoutRefused, readPayoutFromPayPal, reviewPayout, sendPayout } from "@/server/paypal/payouts";
import { createContactCipher } from "@/server/privacy/contactCipher";
import { recordKeyFromEnv } from "@/server/privacy/recordKey";
import { createRateLimiter } from "@/server/web/rateLimit";
import { currentSession, fromThisSite, refused, secret, seeOther, withMessage } from "@/server/web/http";

export const dynamic = "force-dynamic";

const HOUR = 60 * 60_000;
const perShop = createRateLimiter({ limit: 20, windowMs: HOUR });
// Each send is a real sandbox payment, so it's limited per shop and for everyone together.
const sendsPerShop = createRateLimiter({ limit: 3, windowMs: HOUR });
const sendsByEveryone = createRateLimiter({ limit: 30, windowMs: HOUR });

export async function POST(request: Request): Promise<Response> {
  const session = await currentSession();
  if (!session || !fromThisSite(request)) return refused(401, "sign in as a shop first");
  if (!perShop(session.shopId)) return withMessage(request, "Too many tries from this shop. Try again in a while.");
  const form = await request.formData();
  const action = String(form.get("action") ?? "");
  const back = () => seeOther(request, "/queue#past-window");
  const cipher = createContactCipher(secret("SHOP_DATA_KEY"), session.shopId);
  const db = getDb();
  const now = new Date();
  try {
    if (action === "review") {
      // The demo's own sandbox buyer. Nobody types an address, so no real person's email reaches PayPal or this table.
      const receiver = process.env.DEMO_PAYOUT_RECEIVER?.trim();
      if (!receiver) return withMessage(request, "This demo has no sandbox buyer set up for this payment.");
      await reviewPayout(db, { shopId: session.shopId, sessionId: session.sessionId, email: receiver, amount: String(form.get("amount") ?? ""), cipher, now });
      return back();
    }
    const payoutId = String(form.get("payoutId") ?? "");
    if (action === "send") {
      const recordKey = recordKeyFromEnv();
      if (!recordKey) return refused(503, "the server is missing its record key");
      if (!sendsPerShop(session.shopId) || !sendsByEveryone("all")) return withMessage(request, "Too many payments from here. Try again in a while.");
      await withCallLog(db, session.shopId, () => sendPayout(db, payPalClientFromEnv(), { shopId: session.shopId, sessionId: session.sessionId, payoutId, approvalId: String(form.get("approvalId") ?? ""), recordKey, cipher, now }));
      return back();
    }
    if (action === "read") {
      await withCallLog(db, session.shopId, () => readPayoutFromPayPal(db, payPalClientFromEnv(), { shopId: session.shopId, payoutId, now }));
      return back();
    }
    return refused(400, "not an action");
  } catch (err) {
    if (err instanceof PayoutRefused) return withMessage(request, err.message);
    if (err instanceof PayPalApiError) return withMessage(request, "PayPal could not be read just now. Please try again.");
    throw err;
  }
}
