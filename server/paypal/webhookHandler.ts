import type { Queryable } from "../db/types";
import type { RecordKey } from "../privacy/recordKey";
import { readTransmissionHeaders, verifyWebhook, type CertFetcher, type WebhookEvent } from "./webhooks";

export const MAX_WEBHOOK_BYTES = 1_048_576;

export interface WebhookResponse {
  status: number;
  body: Record<string, unknown>;
}

function eventCreateTime(event: WebhookEvent): string | null {
  return typeof event.create_time === "string" && !Number.isNaN(Date.parse(event.create_time))
    ? event.create_time
    : null;
}

/**
 * Handles one PayPal webhook delivery: verify the signature, then record the event once.
 * PayPal ids are stored only as HMACs under the shop's secret (recordKey), never raw.
 * 503 when the webhook id or the record key secret is not configured (PayPal retries later),
 * 401 when verification fails or the transmission was already used for another event, 200 for a
 * verified event, including a repeat delivery of one already recorded. Recording an event changes
 * no other state: anything that acts on an event must confirm the resource through the PayPal API.
 */
export async function handleWebhookDelivery(input: {
  rawBody: Uint8Array;
  headers: Headers;
  webhookId: string | undefined;
  db: Queryable;
  recordKey: RecordKey | null;
  fetchCert?: CertFetcher;
  now?: () => number;
}): Promise<WebhookResponse> {
  if (!input.webhookId || !input.recordKey) {
    console.error("PayPal webhook received but PAYPAL_WEBHOOK_ID or RECORD_HMAC_SECRET is not set");
    return { status: 503, body: { error: "webhook not configured" } };
  }
  const key = input.recordKey;
  if (input.rawBody.byteLength > MAX_WEBHOOK_BYTES) {
    return { status: 413, body: { error: "payload too large" } };
  }

  const transmission = readTransmissionHeaders(input.headers);
  const result = await verifyWebhook(input.rawBody, transmission, input.webhookId, {
    fetchCert: input.fetchCert,
  });
  if (!result.verified) {
    console.warn(`PayPal webhook rejected: ${result.reason}`);
    return { status: 401, body: { error: "signature not verified" } };
  }

  const { event } = result;
  const eventKey = key("paypal-event", event.id);
  // Verification guarantees the transmission id is present. A transmission already used for a
  // different event is a replay of a captured signature over a CRC-matching body: refuse it.
  const transmissionId = transmission.transmissionId!;
  const transmissionKey = key("paypal-transmission", transmissionId);
  const claimed = await input.db.query(
    `insert into paypal_webhook_transmissions (transmission_id_hmac, event_id_hmac) values ($1, $2)
     on conflict (transmission_id_hmac) do nothing
     returning event_id_hmac`,
    [transmissionKey, eventKey],
  );
  if (claimed.rows.length === 0) {
    const prior = await input.db.query<{ event_id_hmac: string }>(
      "select event_id_hmac from paypal_webhook_transmissions where transmission_id_hmac = $1",
      [transmissionKey],
    );
    if (prior.rows[0]?.event_id_hmac !== eventKey) {
      console.warn("PayPal webhook rejected: the transmission was already used for another event");
      return { status: 401, body: { error: "signature not verified" } };
    }
  }
  const transmissionNew = claimed.rows.length > 0;

  const resourceId = typeof event.resource?.id === "string" ? event.resource.id : null;
  const { rows } = await input.db.query(
    `insert into paypal_webhook_events
       (event_id_hmac, event_type, resource_type, resource_id_hmac, event_create_time, verification_method)
     values ($1, $2, $3, $4, $5::timestamptz, 'self')
     on conflict (event_id_hmac) do nothing
     returning event_id_hmac`,
    [
      eventKey,
      event.event_type,
      typeof event.resource_type === "string" ? event.resource_type : null,
      resourceId ? key("paypal-resource", resourceId) : null,
      eventCreateTime(event),
    ],
  );
  const duplicate = rows.length === 0;
  // Delivery diagnostics without PayPal data: logs outlive the 48-hour rule, so they carry derived
  // facts only. A redelivery's age shows whether PayPal re-signs it with a new transmission time.
  const sentAt = Date.parse(transmission.transmissionTime ?? "");
  const age = Number.isNaN(sentAt) ? "unknown" : String(Math.round(((input.now ?? Date.now)() - sentAt) / 1000));
  console.info(
    `PayPal webhook accepted: type=${event.event_type} transmission_new=${transmissionNew} ` +
      `transmission_age_s=${age} duplicate=${duplicate}`,
  );
  return { status: 200, body: { received: true, duplicate } };
}
