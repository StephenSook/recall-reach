import { getDb } from "@/server/db/pg";
import { deleteOwnShop } from "@/server/import/ownFile";
import { SESSION_COOKIE } from "@/server/session/session";
import { currentSession, fromThisSite, refused, seeOther, withMessage } from "@/server/web/http";

export const dynamic = "force-dynamic";

// "Delete my data": the shop's file, its checks and its messages, for good.
export async function POST(request: Request): Promise<Response> {
  const session = await currentSession();
  if (!session || !fromThisSite(request)) return refused(401, "sign in as a shop first");
  if (!(await deleteOwnShop(getDb(), session.shopId))) return withMessage(request, "A demo shop has no data of yours to delete.");
  const response = seeOther(request, "/?demo=deleted");
  response.headers.append("Set-Cookie", `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
  return response;
}
