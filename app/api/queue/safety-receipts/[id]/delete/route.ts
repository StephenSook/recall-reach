import { getDb } from "@/server/db/pg";
import { deleteShopReceipt } from "@/server/safetyReceipt/store";
import { currentSession, fromThisSite, refused, seeOther } from "@/server/web/http";

export const dynamic = "force-dynamic";

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  const session = await currentSession();
  if (!session || !fromThisSite(request)) return refused(401, "Sign in as this shop first.");
  await deleteShopReceipt(getDb(), session.shopId, (await params).id);
  return seeOther(request, "/queue/safety-receipts");
}
