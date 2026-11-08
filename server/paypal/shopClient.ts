// Which PayPal account a shop's refunds and reads go from. A real shop has only its own, once PayPal says it is connected
// through Partner Referrals: the platform then acts for it with PayPal-Auth-Assertion. Until then it has none, and never
// the demo's. A demo shop uses the demo's own sandbox account.
import type { Queryable } from "../db/types";
import { connectedMerchant } from "../shop/paypalConnection";
import { payPalClientFromEnv, type PayPalClient } from "./client";
import { platformFromEnv } from "./platform";

/** What a refund route says to a real shop with no PayPal account connected. */
export const NOT_CONNECTED = "Connect your PayPal account first. Refunds for your shop go from your own PayPal account, once PayPal says it's connected.";

export async function payPalClientForShop(db: Queryable, shopId: string, env: NodeJS.ProcessEnv = process.env): Promise<{ client: PayPalClient | null; actingForShop: boolean }> {
  const { rows } = await db.query<{ kind: string }>("select kind from shops where id = $1", [shopId]);
  if (rows[0]?.kind !== "REAL") return { client: payPalClientFromEnv(env), actingForShop: false };
  const platform = platformFromEnv(env);
  const secret = env.SHOP_DATA_KEY;
  const merchant = platform && secret ? await connectedMerchant(db, { shopId, secret }) : null;
  return platform && merchant ? { client: platform.actingFor(merchant), actingForShop: true } : { client: null, actingForShop: false };
}
