// Which PayPal account a shop's refunds and reads go from. A shop connected through Partner Referrals has its own: the
// platform acts for it with PayPal-Auth-Assertion. Every other shop, the demo included, uses the platform's own account.
import type { Queryable } from "../db/types";
import { connectedMerchant } from "../shop/paypalConnection";
import { payPalClientFromEnv, type PayPalClient } from "./client";
import { platformFromEnv } from "./platform";

export async function payPalClientForShop(db: Queryable, shopId: string, env: NodeJS.ProcessEnv = process.env): Promise<{ client: PayPalClient; actingForShop: boolean }> {
  const platform = platformFromEnv(env);
  const secret = env.SHOP_DATA_KEY;
  if (platform && secret) {
    const merchant = await connectedMerchant(db, { shopId, secret });
    if (merchant) return { client: platform.actingFor(merchant), actingForShop: true };
  }
  return { client: payPalClientFromEnv(env), actingForShop: false };
}
