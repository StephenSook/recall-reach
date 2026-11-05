import { getDb } from "@/server/db/pg";
import { handleWebhookDelivery } from "@/server/paypal/webhookHandler";

export const dynamic = "force-dynamic";

// PayPal posts webhook events here. The raw bytes are read before any parsing because the
// signature covers the exact body PayPal sent.
export async function POST(request: Request): Promise<Response> {
  try {
    const rawBody = new Uint8Array(await request.arrayBuffer());
    const { status, body } = await handleWebhookDelivery({
      rawBody,
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
