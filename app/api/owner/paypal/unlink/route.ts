import { getDb } from "@/server/db/pg";
import { ranAt } from "@/app/replay/labels";
import { unlinkOwner } from "@/server/owner/ownerLink";
import { shopLifetime } from "@/server/shop/lifetime";
import { currentSession, fromThisSite, refused, withMessage } from "@/server/web/http";

export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
  const session = await currentSession();
  if (!session || !fromThisSite(request)) return refused(401, "sign in as a shop first");
  const db = getDb();
  await unlinkOwner(db, session.shopId);
  // Back to the 7-day rule, which for an older shop has already passed: the hourly purge takes it next.
  const life = await shopLifetime(db, session.shopId);
  const when = life && life.deletesAfter.getTime() > Date.now() ? `after ${ranAt(life.deletesAfter.toISOString())}` : "within the hour";
  return withMessage(request, `Unlinked. Your PayPal login no longer opens this shop, and it is no longer kept: its data is deleted ${when}.`);
}
