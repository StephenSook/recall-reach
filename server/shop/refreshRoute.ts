// The status read behind PayPal's return link and the queue's "Check with PayPal" button.
import { getDb } from "../db/pg";
import { withCallLog } from "../paypal/callLog";
import { platformFromEnv } from "../paypal/platform";
import { recordKeyFromEnv } from "../privacy/recordKey";
import { currentSession, refused, secret, withMessage } from "../web/http";
import { refreshConnection } from "./connectFlow";
import { BUSY, refreshedMessage, TOO_OFTEN } from "./connectMessages";
import { linkChangeAllowed } from "./linkLimit";
import { ConnectionBusy } from "./paypalConnection";

export async function refreshAndSay(request: Request): Promise<Response> {
  const session = await currentSession();
  if (!session) return refused(401, "sign in as a shop first");
  const platform = platformFromEnv();
  if (!platform) return withMessage(request, "Connecting a PayPal account isn't set up on this site yet.");
  const recordKey = recordKeyFromEnv();
  if (!recordKey) throw new Error("RECORD_HMAC_SECRET is not set");
  if (!linkChangeAllowed(session.shopId)) return withMessage(request, TOO_OFTEN);
  const db = getDb();
  try {
    const done = await withCallLog(db, session.shopId, () => refreshConnection(db, platform, { shopId: session.shopId, recordKey, secret: secret("SHOP_DATA_KEY"), now: new Date() }));
    return withMessage(request, refreshedMessage(done));
  } catch (err) {
    if (err instanceof ConnectionBusy) return withMessage(request, BUSY);
    throw err;
  }
}
