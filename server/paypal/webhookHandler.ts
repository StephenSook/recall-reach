import { valueToCents } from "./orders";
import { BILLING_EVENTS } from "../shop/subscription";
import { createHash } from "node:crypto";
import type { Queryable } from "../db/types";
import type { RecordKey } from "../privacy/recordKey";
import { PAYPAL_PURGE_CUTOFF_HOURS } from "../privacy/retention";
import { readTransmissionHeaders, verifyWebhook, type CertFetcher, type TransmissionHeaders, type WebhookEvent } from "./webhooks";

export const MAX_WEBHOOK_BYTES = 1_048_576;

// PayPal's own forms, such as PAYMENT.CAPTURE.COMPLETED and capture. The signature covers only a CRC of the body, so
// these aren't taken as they stand: they get stored, and the type gets logged.
const EVENT_TYPE = /^[A-Z0-9][A-Z0-9._-]{0,99}$/;
const RESOURCE_TYPE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;

export interface WebhookResponse {
  status: number;
  body: Record<string, unknown>;
  /** Asks PayPal's own check about a newly stored event and records its answer. Run it after answering PayPal. */
  followUp?: () => Promise<void>;
}

/** PayPal's own answer about a delivery. Never a gate: our certificate check is. */
export type PayPalCheck = "SUCCESS" | "FAILURE" | "UNAVAILABLE";

/** A refund event's own status and amount, kept only when they read exactly. */
function refundFacts(event: WebhookEvent): { status: string | null; cents: number | null; currency: string | null } {
  const none = { status: null, cents: null, currency: null };
  if (event.event_type !== "PAYMENT.CAPTURE.REFUNDED") return none;
  const r = event.resource as { status?: unknown; amount?: { value?: unknown; currency_code?: unknown } } | undefined;
  const status = typeof r?.status === "string" && /^[A-Z_]{1,30}$/.test(r.status) ? r.status : null;
  const value = r?.amount?.value;
  const currency = r?.amount?.currency_code;
  const amount = typeof value === "string" && /^\d{1,9}(\.\d{1,2})?$/.test(value) && typeof currency === "string" && /^[A-Z]{3}$/.test(currency);
  return { status, cents: amount ? valueToCents(value as string) : null, currency: amount ? (currency as string) : null };
}

// PayPal's form. Date.parse also takes "1" and "Nov 5 2026 8pm", which either fail in Postgres or get stored as a guess.
const ISO_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:?\d{2})$/;

function eventCreateTime(event: WebhookEvent): string | null {
  return typeof event.create_time === "string" && ISO_TIME.test(event.create_time) && !Number.isNaN(Date.parse(event.create_time))
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
export interface PlatformWebhook {
  webhookId: string | undefined;
  checkWithPayPal?: (transmission: TransmissionHeaders, webhookId: string, rawBody: Uint8Array) => Promise<PayPalCheck>;
  /** A seller took back the consent it gave the platform. Must be safe to repeat. */
  onConsentRevoked?: (merchantId: string) => Promise<unknown>;
}

const MERCHANT_ID = /^[A-Z0-9]{8,20}$/;

export async function handleWebhookDelivery(input: {
  rawBody: Uint8Array;
  headers: Headers;
  webhookId: string | undefined;
  db: Queryable;
  recordKey: RecordKey | null;
  fetchCert?: CertFetcher;
  now?: () => number;
  onCaptureCompleted?: (captureId: string) => Promise<unknown>;
  /** A payout item event, verified. Must read the batch from PayPal before it moves anything, and be safe to repeat. */
  onPayoutItem?: (resource: unknown, recordKey: RecordKey) => Promise<unknown>;
  /** Demo app only. Reads the current subscription at PayPal so delayed events cannot rewind it. */
  onSubscriptionChanged?: (subscriptionId: string) => Promise<unknown>;
  /** PayPal's verify-webhook-signature, given the exact bytes. Asked only about a new event our check verified. */
  checkWithPayPal?: (transmission: TransmissionHeaders, webhookId: string, rawBody: Uint8Array) => Promise<PayPalCheck>;
  /** The platform app, which connected shops link to. Its events post to the same URL under its own webhook id. */
  platform?: PlatformWebhook;
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
  let result = await verifyWebhook(input.rawBody, transmission, input.webhookId, {
    fetchCert: input.fetchCert,
  });
  // The signature covers the webhook id, so an event verifies under exactly one app's id. That app's id and check go with it.
  let webhookId = input.webhookId;
  let check = input.checkWithPayPal;
  let fromPlatform = false;
  const platformId = input.platform?.webhookId;
  if (!result.verified && platformId && platformId !== input.webhookId) {
    const second = await verifyWebhook(input.rawBody, transmission, platformId, { fetchCert: input.fetchCert });
    if (second.verified) {
      result = second;
      webhookId = platformId;
      check = input.platform?.checkWithPayPal;
      fromPlatform = true;
    }
  }
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
  const at = (input.now ?? Date.now)();

  // The purge takes this event's row at its cutoff, and the transmissions table is what's left to remember it. Storing
  // it again would restart its 48-hour clock, and an old delivery must not act as a new one, so it stores nothing at
  // all. This goes an hour before the cutoff, so a clock a little behind the purge's can't bring one back. Inside that a
  // missing row goes on to be stored: a crash between the two writes below has to be able to retry.
  const seen = await input.db.query<{ finished: boolean | null }>(
    `select min(received_at) < $2::timestamptz - make_interval(hours => $3) as finished
     from paypal_webhook_transmissions where event_id_hmac = $1`,
    [eventKey, new Date(at).toISOString(), PAYPAL_PURGE_CUTOFF_HOURS - 1],
  );
  if (seen.rows[0]?.finished) {
    console.info(`PayPal webhook accepted: type=${event.event_type} already finished, nothing stored`);
    return { status: 200, body: { received: true, duplicate: true } };
  }

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
    // From before the bytes were remembered, so there's no telling this is the same delivery. It acts on nothing.
    if (prior.rows[0].body_hmac === null) {
      console.info(`PayPal webhook accepted: type=${event.event_type} older transmission, nothing stored`);
      return { status: 200, body: { received: true, duplicate: true } };
    }
    if (prior.rows[0].body_hmac !== bodyKey) {
      console.warn("PayPal webhook rejected: the transmission was already used for other bytes");
      return { status: 401, body: { error: "signature not verified" } };
    }
  }
  const transmissionNew = claimed.rows.length > 0;
  const resourceId = typeof event.resource?.id === "string" ? event.resource.id : null;
  const refund = refundFacts(event);
  const { rows } = await input.db.query(
    `insert into paypal_webhook_events
       (event_id_hmac, event_type, resource_type, resource_id_hmac, event_create_time, verification_method, resource_status, resource_amount_cents, resource_currency)
     values ($1, $2, $3, $4, $5::timestamptz, 'self', $6, $7, $8)
     on conflict (event_id_hmac) do nothing
     returning event_id_hmac`,
    [
      eventKey,
      event.event_type,
      typeof event.resource_type === "string" && RESOURCE_TYPE.test(event.resource_type) ? event.resource_type : null,
      resourceId ? key("paypal-resource", resourceId) : null,
      eventCreateTime(event),
      refund.status,
      refund.cents,
      refund.currency,
    ],
  );
  const duplicate = rows.length === 0;
  // Delivery diagnostics without PayPal data: logs outlive the 48-hour rule, so they carry derived
  // facts only. A redelivery's age shows whether PayPal re-signs it with a new transmission time.
  const sentAt = Date.parse(transmission.transmissionTime ?? "");
  const age = Number.isNaN(sentAt) ? "unknown" : String(Math.round((at - sentAt) / 1000));
  console.info(
    `PayPal webhook accepted: type=${event.event_type} app=${fromPlatform ? "platform" : "demo"} transmission_new=${transmissionNew} ` +
      `transmission_age_s=${age} duplicate=${duplicate}`,
  );
  // A connected shop's capture is that shop's own sale, read through its own connection, never the demo's live catch.
  if (event.event_type === "PAYMENT.CAPTURE.COMPLETED" && resourceId && !fromPlatform) await input.onCaptureCompleted?.(resourceId);
  if (!fromPlatform && Object.hasOwn(BILLING_EVENTS, event.event_type) && resourceId) await input.onSubscriptionChanged?.(resourceId);
  // Forgetting a link fails safe, so it doesn't wait on a PayPal read. Only the platform app's own event counts.
  const revokedMerchant = (event.resource as { merchant_id?: unknown } | undefined)?.merchant_id;
  if (fromPlatform && event.event_type === "MERCHANT.PARTNER-CONSENT.REVOKED" && typeof revokedMerchant === "string" && MERCHANT_ID.test(revokedMerchant)) {
    await input.platform?.onConsentRevoked?.(revokedMerchant);
  }
  // Like a capture, a payout's state is confirmed through the API: the event says only which batch to read.
  if (event.event_type?.startsWith("PAYMENT.PAYOUTS-ITEM.") && event.resource) await input.onPayoutItem?.(event.resource, key);
  // Asked once, for a new event, after PayPal has its answer. Whatever goes wrong is recorded as no answer, never a pass.
  const followUp =
    check && !duplicate
      ? async () => {
          let answer: PayPalCheck = "UNAVAILABLE";
          try {
            answer = await check(transmission, webhookId!, input.rawBody);
          } catch {
            answer = "UNAVAILABLE";
          }
          await input.db.query("update paypal_webhook_events set paypal_check = $2, paypal_checked_at = now() where event_id_hmac = $1", [eventKey, answer]);
        }
      : undefined;
  return { status: 200, body: { received: true, duplicate }, followUp };
}
