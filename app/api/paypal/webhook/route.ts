import { getDb } from "@/server/db/pg";
import { readCappedBody } from "@/server/http/body";
import { handleWebhookDelivery, MAX_WEBHOOK_BYTES } from "@/server/paypal/webhookHandler";

export const dynamic = "force-dynamic";

// PayPal posts webhook events here. The raw bytes are read before any parsing because the
// signature covers the exact body PayPal sent; reading stops at MAX_WEBHOOK_BYTES.
export async function POST(request: Request): Promise<Response> {
  try {
    const read = await readCappedBody(request, MAX_WEBHOOK_BYTES);
    if (!read.ok) return Response.json({ error: "payload too large" }, { status: 413 });
    const { status, body } = await handleWebhookDelivery({
      rawBody: read.body,
      headers: request.headers,
      webhookId: process.env.PAYPAL_WEBHOOK_ID,
      db: getDb(),
    });
    return Response.json(body, { status });
  } catch (err) {
    // A non-2xx answer makes PayPal retry the delivery later.
    console.error("PayPal webhook handling failed:", err instanceof Error ? err.message : err);
    return Response.json({ error: "internal error" }, { status: 500 });
  }
}
