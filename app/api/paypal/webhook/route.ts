import { after } from "next/server";
import { withCallLog } from "@/server/paypal/callLog";
import { getDb } from "@/server/db/pg";
import { catchLiveSale } from "@/server/demo/liveCatch";
import { readCappedBody } from "@/server/http/body";
import { payPalClientFromEnv } from "@/server/paypal/client";
import { askPayPalToVerify } from "@/server/paypal/webhookCheck";
import { handleWebhookDelivery, MAX_WEBHOOK_BYTES } from "@/server/paypal/webhookHandler";
import { recordKeyFromEnv } from "@/server/privacy/recordKey";

export const dynamic = "force-dynamic";

// PayPal posts webhook events here. The raw bytes are read before any parsing because the
// signature covers the exact body PayPal sent; reading stops at MAX_WEBHOOK_BYTES.
export async function POST(request: Request): Promise<Response> {
  try {
    const read = await readCappedBody(request, MAX_WEBHOOK_BYTES);
    if (!read.ok) return Response.json({ error: "payload too large" }, { status: 413 });
    const { status, body, followUp } = await handleWebhookDelivery({
      rawBody: read.body,
      headers: request.headers,
      webhookId: process.env.PAYPAL_WEBHOOK_ID,
      db: getDb(),
      recordKey: recordKeyFromEnv(),
      onCaptureCompleted: (captureId) => withCallLog(getDb(), null, () => catchLiveSale(getDb(), payPalClientFromEnv(), { captureId, now: new Date() })),
      checkWithPayPal: (transmission, webhookId, rawBody) => askPayPalToVerify(payPalClientFromEnv(), transmission, webhookId, rawBody),
    });
    // PayPal's own check runs once PayPal has its answer, so neither the reply nor a live catch waits on it.
    if (followUp) after(followUp);
    return Response.json(body, { status });
  } catch (err) {
    // A non-2xx answer makes PayPal retry the delivery later.
    console.error("PayPal webhook handling failed:", err instanceof Error ? err.message : err);
    return Response.json({ error: "internal error" }, { status: 500 });
  }
}
