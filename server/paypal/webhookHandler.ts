import { createHash } from "node:crypto";
import type { Queryable } from "../db/types";
import { readTransmissionHeaders, verifyWebhook, type CertFetcher, type WebhookEvent } from "./webhooks";

export const MAX_WEBHOOK_BYTES = 1_048_576;

export interface WebhookResponse {
  status: number;
  body: Record<string, unknown>;
}

const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");

function eventCreateTime(event: WebhookEvent): string | null {
  return typeof event.create_time === "string" && !Number.isNaN(Date.parse(event.create_time))
    ? event.create_time
    : null;
}

/**
 * Handles one PayPal webhook delivery: verify the signature, then record the event once.
 * 503 when no webhook id is configured (PayPal retries later), 401 when verification fails,
 * 200 for a verified event, including a repeat delivery of one already recorded.
 */
export async function handleWebhookDelivery(input: {
  rawBody: Uint8Array;
  headers: Headers;
  webhookId: string | undefined;
  db: Queryable;
  fetchCert?: CertFetcher;
}): Promise<WebhookResponse> {
  if (!input.webhookId) {
    console.error("PayPal webhook received but PAYPAL_WEBHOOK_ID is not set");
    return { status: 503, body: { error: "webhook not configured" } };
  }
  if (input.rawBody.byteLength > MAX_WEBHOOK_BYTES) {
    return { status: 413, body: { error: "payload too large" } };
  }

  const result = await verifyWebhook(input.rawBody, readTransmissionHeaders(input.headers), input.webhookId, {
    fetchCert: input.fetchCert,
  });
  if (!result.verified) {
    console.warn(`PayPal webhook rejected: ${result.reason}`);
    return { status: 401, body: { error: "signature not verified" } };
  }

  const { event } = result;
  const resourceId = typeof event.resource?.id === "string" ? event.resource.id : null;
  const { rows } = await input.db.query(
    `insert into paypal_webhook_events
       (event_id, event_type, resource_type, resource_id_sha256, event_create_time, verification_method)
     values ($1, $2, $3, $4, $5::timestamptz, 'self')
     on conflict (event_id) do nothing
     returning event_id`,
    [
      event.id,
      event.event_type,
      typeof event.resource_type === "string" ? event.resource_type : null,
      resourceId ? sha256(resourceId) : null,
      eventCreateTime(event),
    ],
  );
  return { status: 200, body: { received: true, duplicate: rows.length === 0 } };
}
