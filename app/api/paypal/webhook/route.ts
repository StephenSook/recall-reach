import { after } from "next/server";
import { withCallLog } from "@/server/paypal/callLog";
import { getBillingDb, getDb } from "@/server/db/pg";
import { catchLiveSale } from "@/server/demo/liveCatch";
import { readCappedBody } from "@/server/http/body";
import { payPalClientFromEnv } from "@/server/paypal/client";
import { askPayPalToVerify } from "@/server/paypal/webhookCheck";
import { platformFromEnv } from "@/server/paypal/platform";
import { handleWebhookDelivery, MAX_WEBHOOK_BYTES, type PlatformWebhook } from "@/server/paypal/webhookHandler";
import { confirmRevoked } from "@/server/shop/connectFlow";
import { syncSubscriptionEvent } from "@/server/shop/subscription";
import { recordKeyFromEnv, type RecordKey } from "@/server/privacy/recordKey";
import { secret } from "@/server/web/http";

export const dynamic = "force-dynamic";

/** The platform app connected shops link to. Its events post here under its own webhook id. */
function platformWebhook(recordKey: RecordKey | null): PlatformWebhook | undefined {
  const webhookId = process.env.PAYPAL_PLATFORM_WEBHOOK_ID?.trim();
  if (!webhookId) return undefined;
  const platform = platformFromEnv();
  return {
    webhookId,
    checkWithPayPal: platform ? (transmission, id, rawBody) => askPayPalToVerify(platform.client, transmission, id, rawBody) : undefined,
    // Acted on only once PayPal's own status agrees. Without the platform app nothing uses a link, so it waits for one.
    onConsentRevoked: async (merchantId) => {
      if (!recordKey || !platform) return console.warn("PayPal consent revoked, but the platform app isn't set up to confirm it");
      const { forgotten, kept, replaced } = await withCallLog(getDb(), null, () => confirmRevoked(getDb(), platform, { merchantId, recordKey, secret: secret("SHOP_DATA_KEY") }));
      console.info(`PayPal consent revoked: forgotten=${forgotten} kept=${kept} replaced=${replaced}`);
    },
  };
}

// PayPal posts webhook events here. The raw bytes are read before any parsing because the
// signature covers the exact body PayPal sent; reading stops at MAX_WEBHOOK_BYTES.
export async function POST(request: Request): Promise<Response> {
  try {
    const read = await readCappedBody(request, MAX_WEBHOOK_BYTES);
    if (!read.ok) return Response.json({ error: "payload too large" }, { status: 413 });
    const recordKey = recordKeyFromEnv();
    const { status, body, followUp } = await handleWebhookDelivery({
      rawBody: read.body,
      headers: request.headers,
      webhookId: process.env.PAYPAL_WEBHOOK_ID,
      db: getDb(),
      recordKey,
      onCaptureCompleted: (captureId) => withCallLog(getDb(), null, () => catchLiveSale(getDb(), payPalClientFromEnv(), { captureId, now: new Date() })),
      onSubscriptionChanged: async (subscriptionId) => {
        if (recordKey) await withCallLog(getBillingDb(), null, () => syncSubscriptionEvent(getBillingDb(), payPalClientFromEnv(), { subscriptionId, recordKey, secret: secret("SHOP_DATA_KEY") }));
      },
      checkWithPayPal: (transmission, webhookId, rawBody) => askPayPalToVerify(payPalClientFromEnv(), transmission, webhookId, rawBody),
      platform: platformWebhook(recordKey),
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
