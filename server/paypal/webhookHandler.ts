import { createHash } from "node:crypto";
import type { Queryable } from "../db/types";
import type { RecordKey } from "../privacy/recordKey";
import { PAYPAL_PURGE_CUTOFF_HOURS } from "../privacy/retention";
import { readTransmissionHeaders, verifyWebhook, type CertFetcher, type WebhookEvent } from "./webhooks";

export const MAX_WEBHOOK_BYTES = 1_048_576;

// PayPal's own forms, such as PAYMENT.CAPTURE.COMPLETED and capture. The signature covers only a CRC of the body, so
// these aren't taken as they stand: they get stored, and the type gets logged.
const EVENT_TYPE = /^[A-Z0-9][A-Z0-9._-]{0,99}$/;
const RESOURCE_TYPE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;

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
 * 401 when verification fails or the transmission was already used for another event or other bytes,
 * 400 for an event type not in PayPal's form, 200 for a verified event, including a repeat delivery of
 * one already recorded. An event first seen before the purge's cutoff is finished: it answers as a
 * repeat, and is neither stored again nor acted on. Recording an event changes no other state:
 * anything that acts on an event must confirm the resource through the PayPal API.
 * A completed capture goes to onCaptureCompleted, which must be safe to repeat: if it throws, the
 * delivery fails and PayPal tries again.
 */
export async function handleWebhookDelivery(input: {
  rawBody: Uint8Array;
  headers: Headers;
  webhookId: string | undefined;
  db: Queryable;
  recordKey: RecordKey | null;
  fetchCert?: CertFetcher;
  now?: () => number;
  onCaptureCompleted?: (captureId: string) => Promise<unknown>;
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
  if (!EVENT_TYPE.test(event.event_type)) {
    console.warn("PayPal webhook rejected: the event type is not in PayPal's form");
    return { status: 400, body: { error: "event type not recognized" } };
  }
  const eventKey = key("paypal-event", event.id);
  const bodyKey = key("paypal-body", createHash("sha256").update(input.rawBody).digest("hex"));
  // Verification guarantees the transmission id is present. A transmission already used for a different
  // event or different bytes is a replay of a captured signature over a CRC-matching body: refuse it.
  const transmissionId = transmission.transmissionId!;
  const transmissionKey = key("paypal-transmission", transmissionId);
  const claimed = await input.db.query(
    `insert into paypal_webhook_transmissions (transmission_id_hmac, event_id_hmac, body_hmac) values ($1, $2, $3)
     on conflict (transmission_id_hmac) do nothing
     returning event_id_hmac`,
    [transmissionKey, eventKey, bodyKey],
  );
  if (claimed.rows.length === 0) {
    const prior = await input.db.query<{ event_id_hmac: string; body_hmac: string | null }>(
      "select event_id_hmac, body_hmac from paypal_webhook_transmissions where transmission_id_hmac = $1",
      [transmissionKey],
    );
    if (prior.rows[0]?.event_id_hmac !== eventKey) {
      console.warn("PayPal webhook rejected: the transmission was already used for another event");
      return { status: 401, body: { error: "signature not verified" } };
    }
    if (prior.rows[0].body_hmac !== null && prior.rows[0].body_hmac !== bodyKey) {
      console.warn("PayPal webhook rejected: the transmission was already used for other bytes");
      return { status: 401, body: { error: "signature not verified" } };
    }
  }
  const transmissionNew = claimed.rows.length > 0;
  const at = (input.now ?? Date.now)();

  // Past the cutoff the purge has taken this event's row, and this table is what's left to remember it. Storing it
  // again would restart its 48-hour clock, and an old delivery must not act as a new one. Inside the cutoff a missing
  // row goes on to be stored: a crash between these two writes has to be able to retry.
  const seen = await input.db.query<{ finished: boolean | null }>(
    `select min(received_at) < $2::timestamptz - make_interval(hours => $3) as finished
     from paypal_webhook_transmissions where event_id_hmac = $1`,
    [eventKey, new Date(at).toISOString(), PAYPAL_PURGE_CUTOFF_HOURS],
  );
  if (seen.rows[0]?.finished) {
    console.info(`PayPal webhook accepted: type=${event.event_type} already finished, nothing stored`);
    return { status: 200, body: { received: true, duplicate: true } };
  }

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
      typeof event.resource_type === "string" && RESOURCE_TYPE.test(event.resource_type) ? event.resource_type : null,
      resourceId ? key("paypal-resource", resourceId) : null,
      eventCreateTime(event),
    ],
  );
  const duplicate = rows.length === 0;
  // Delivery diagnostics without PayPal data: logs outlive the 48-hour rule, so they carry derived
  // facts only. A redelivery's age shows whether PayPal re-signs it with a new transmission time.
  const sentAt = Date.parse(transmission.transmissionTime ?? "");
  const age = Number.isNaN(sentAt) ? "unknown" : String(Math.round((at - sentAt) / 1000));
  console.info(
    `PayPal webhook accepted: type=${event.event_type} transmission_new=${transmissionNew} ` +
      `transmission_age_s=${age} duplicate=${duplicate}`,
  );
  if (event.event_type === "PAYMENT.CAPTURE.COMPLETED" && resourceId) await input.onCaptureCompleted?.(resourceId);
  return { status: 200, body: { received: true, duplicate } };
}
