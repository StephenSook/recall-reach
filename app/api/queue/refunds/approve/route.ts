import { getDb } from "@/server/db/pg";
import { approveRefund, RefundRefused } from "@/server/paypal/refunds";
import { currentSession, fromThisSite, refused, seeOther, withMessage } from "@/server/web/http";

export const dynamic = "force-dynamic";

// The approval names the exact amount. Moving the money is a second, deliberate step.
export async function POST(request: Request): Promise<Response> {
  const session = await currentSession();
  if (!session || !fromThisSite(request)) return refused(401, "sign in as a shop first");
  const form = await request.formData();
  try {
    await approveRefund(getDb(), { shopId: session.shopId, sessionId: session.sessionId, matchId: String(form.get("matchId") ?? "") });
    return seeOther(request, "/queue");
  } catch (err) {
    if (err instanceof RefundRefused) return withMessage(request, err.message);
    throw err;
  }
}
