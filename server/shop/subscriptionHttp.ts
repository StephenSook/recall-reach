import { getBillingDb } from "../db/pg";
import { PayPalApiError, payPalClientFromEnv } from "../paypal/client";
import { withCallLog } from "../paypal/callLog";
import { recordKeyFromEnv } from "../privacy/recordKey";
import { baseUrl, currentSession, fromThisSite, refused, secret, withMessage } from "../web/http";
import { SubscriptionRefused, requireRealShop } from "./subscription";

/** Shared session/origin boundary. Error text never includes a PayPal response, id or approve URL. */
export async function subscriptionRequest(request: Request, run: (ctx: {
  db: ReturnType<typeof getBillingDb>; client: ReturnType<typeof payPalClientFromEnv>; shopId: string;
  recordKey: NonNullable<ReturnType<typeof recordKeyFromEnv>>; secret: string; site: string;
}) => Promise<Response>): Promise<Response> {
  if (request.method === "POST" && !fromThisSite(request)) return refused(403, "wrong origin");
  const session = await currentSession();
  if (!session) return refused(401, "sign in as a shop first");
  try {
    const db = getBillingDb();
    await requireRealShop(db, session.shopId);
    const recordKey = recordKeyFromEnv();
    if (!recordKey) return refused(503, "subscriptions are not configured");
    return await withCallLog(db, session.shopId, () => run({ db, client: payPalClientFromEnv(), shopId: session.shopId, recordKey, secret: secret("SHOP_DATA_KEY"), site: baseUrl(request) }));
  } catch (err) {
    if (err instanceof SubscriptionRefused) return withMessage(request, `${err.message} PayPal sandbox, no real charge. Everything that keeps families safe stays free.`);
    if (err instanceof PayPalApiError && err.status >= 400 && err.status < 500 && !err.uncertain) return withMessage(request, `PayPal refused the request (HTTP ${err.status}). PayPal sandbox, no real charge. Everything that keeps families safe stays free.`);
    return withMessage(request, "PayPal gave no clear subscription answer. Check PayPal before trying again. PayPal sandbox, no real charge. Everything that keeps families safe stays free.");
  }
}
