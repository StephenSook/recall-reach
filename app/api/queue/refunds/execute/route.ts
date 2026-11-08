import { getDb } from "@/server/db/pg";
import { withCallLog } from "@/server/paypal/callLog";
import { payPalClientForShop } from "@/server/paypal/shopClient";
import { executeRefund, RefundRefused } from "@/server/paypal/refunds";
import { recordKeyFromEnv } from "@/server/privacy/recordKey";
import { currentSession, fromThisSite, refused, seeOther, withMessage } from "@/server/web/http";

export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
  const session = await currentSession();
  if (!session || !fromThisSite(request)) return refused(401, "sign in as a shop first");
  const recordKey = recordKeyFromEnv();
  if (!recordKey) return refused(503, "the server is missing its record key");
  const form = await request.formData();
  try {
    const { client } = await payPalClientForShop(getDb(), session.shopId);
    const outcome = await withCallLog(getDb(), session.shopId, () =>
      executeRefund(getDb(), client, {
        shopId: session.shopId,
        sessionId: session.sessionId,
        approvalId: String(form.get("approvalId") ?? ""),
        recordKey,
      }),
    );
    return seeOther(request, `/queue/refunds/${outcome.refundId}`);
  } catch (err) {
    if (err instanceof RefundRefused) return withMessage(request, err.message);
    throw err;
  }
}
