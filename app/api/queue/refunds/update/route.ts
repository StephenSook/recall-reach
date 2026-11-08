import { getDb } from "@/server/db/pg";
import { withCallLog } from "@/server/paypal/callLog";
import { payPalClientForShop } from "@/server/paypal/shopClient";
import { reconcileRefund, RefundRefused } from "@/server/paypal/refunds";
import { recordKeyFromEnv } from "@/server/privacy/recordKey";
import { currentSession, fromThisSite, refused, seeOther, withMessage } from "@/server/web/http";

export const dynamic = "force-dynamic";

// Opening the refund page only reads. This is the deliberate step that changes the ledger.
export async function POST(request: Request): Promise<Response> {
  const session = await currentSession();
  if (!session || !fromThisSite(request)) return refused(401, "sign in as a shop first");
  const recordKey = recordKeyFromEnv();
  if (!recordKey) return refused(503, "the server is missing its record key");
  const form = await request.formData();
  const refundId = String(form.get("refundId") ?? "");
  try {
    const { client } = await payPalClientForShop(getDb(), session.shopId);
    await withCallLog(getDb(), session.shopId, () => reconcileRefund(getDb(), client, { shopId: session.shopId, refundId, recordKey }));
    return seeOther(request, `/queue/refunds/${refundId}`);
  } catch (err) {
    if (err instanceof RefundRefused) return withMessage(request, err.message);
    throw err;
  }
}
