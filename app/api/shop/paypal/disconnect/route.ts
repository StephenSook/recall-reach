import { getDb } from "@/server/db/pg";
import { disconnectShop, withConnectionLock } from "@/server/shop/paypalConnection";
import { currentSession, fromThisSite, refused, withMessage } from "@/server/web/http";

export const dynamic = "force-dynamic";

// Forgets the shop's link to its PayPal account. PayPal's own permission is the seller's to remove in PayPal.
export async function POST(request: Request): Promise<Response> {
  const session = await currentSession();
  if (!session || !fromThisSite(request)) return refused(401, "sign in as a shop first");
  await withConnectionLock(getDb(), session.shopId, (tx) => disconnectShop(tx, session.shopId));
  return withMessage(request, "Disconnected. Refunds no longer go from your PayPal account here. To remove the permission in PayPal too, remove this site in your PayPal account's settings.");
}
