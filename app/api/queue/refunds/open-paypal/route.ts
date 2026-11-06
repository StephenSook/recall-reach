import { getDb } from "@/server/db/pg";
import { PAYPAL_ACTIVITY_URL, RefundRefused, sendSellerToPayPal } from "@/server/paypal/refunds";
import { currentSession, fromThisSite, refused, withMessage } from "@/server/web/http";

export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
  const session = await currentSession();
  if (!session || !fromThisSite(request)) return refused(401, "sign in as a shop first");
  const form = await request.formData();
  try {
    await sendSellerToPayPal(getDb(), { shopId: session.shopId, refundId: String(form.get("refundId") ?? "") });
    return new Response(null, { status: 303, headers: { Location: PAYPAL_ACTIVITY_URL } });
  } catch (err) {
    if (err instanceof RefundRefused) return withMessage(request, err.message);
    throw err;
  }
}
