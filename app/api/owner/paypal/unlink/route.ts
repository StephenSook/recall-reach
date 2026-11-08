import { getDb } from "@/server/db/pg";
import { unlinkOwner } from "@/server/owner/ownerLink";
import { currentSession, fromThisSite, refused, withMessage } from "@/server/web/http";

export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
  const session = await currentSession();
  if (!session || !fromThisSite(request)) return refused(401, "sign in as a shop first");
  await unlinkOwner(getDb(), session.shopId);
  return withMessage(request, "Unlinked. Your PayPal login no longer opens this shop.");
}
