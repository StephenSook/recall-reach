// Which PayPal account a shop's refunds and reads go from. A real shop has only its own, once PayPal says it is connected
// through Partner Referrals: the platform then acts for it with PayPal-Auth-Assertion. Until then it has none, and never
// the demo's. A demo shop uses the demo's own sandbox account.
import type { Queryable } from "../db/types";
import { readConnection } from "../shop/paypalConnection";
import { payPalClientFromEnv, type PayPalClient } from "./client";
import { platformFromEnv } from "./platform";

/** What a refund route says when a real shop's PayPal account can't be used for a refund, and why. */
export const REFUSED = {
  NOT_CONNECTED: "Connect your PayPal account first. Refunds for your shop go from your own PayPal account, once PayPal says it's connected.",
  SALES_INCOMPLETE: "PayPal didn't answer for all of your sales the last time they were read. Press Check with PayPal for a full read, then refund.",
} as const;
export const NOT_CONNECTED = REFUSED.NOT_CONNECTED;

export type ShopClient = { client: PayPalClient; actingForShop: boolean; refused?: undefined } | { client: null; actingForShop: false; refused: keyof typeof REFUSED };

export async function payPalClientForShop(db: Queryable, shopId: string, env: NodeJS.ProcessEnv = process.env): Promise<ShopClient> {
  const { rows } = await db.query<{ kind: string }>("select kind from shops where id = $1", [shopId]);
  if (rows[0]?.kind !== "REAL") return { client: payPalClientFromEnv(env), actingForShop: false };
  const platform = platformFromEnv(env);
  const secret = env.SHOP_DATA_KEY;
  const link = platform && secret ? await readConnection(db, { shopId, secret }) : null;
  if (!platform || !link?.connected || !link.status) return { client: null, actingForShop: false, refused: "NOT_CONNECTED" };
  // A sales read that stopped partway can't show a payment is the only one for its sale, whatever older reads left behind.
  if (!link.salesReadComplete) return { client: null, actingForShop: false, refused: "SALES_INCOMPLETE" };
  return { client: platform.actingFor(link.status.merchantId), actingForShop: true };
}
