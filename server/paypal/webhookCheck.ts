// PayPal's own check of a webhook delivery (POST /v1/notifications/verify-webhook-signature), asked after our own
// certificate check has passed and PayPal has its answer. It is a second opinion we record, never a gate. The event
// goes back as the exact text PayPal sent: parsing and re-serializing can change the bytes PayPal checks.
import type { PayPalClient } from "./client";
import type { PayPalCheck } from "./webhookHandler";
import type { TransmissionHeaders } from "./webhooks";

const PATH = "/v1/notifications/verify-webhook-signature";

/** The request, with the event spliced in as the raw text it arrived as. */
export function verifyRequestBody(t: TransmissionHeaders, webhookId: string, rawEvent: string): string {
  const field = (name: string, value: string | undefined) => `${JSON.stringify(name)}:${JSON.stringify(value ?? "")}`;
  return `{${[
    field("auth_algo", t.authAlgo),
    field("cert_url", t.certUrl),
    field("transmission_id", t.transmissionId),
    field("transmission_sig", t.transmissionSig),
    field("transmission_time", t.transmissionTime),
    field("webhook_id", webhookId),
  ].join(",")},"webhook_event":${rawEvent}}`;
}

/** SUCCESS or FAILURE as PayPal says. Anything else, including no answer within timeoutMs, is UNAVAILABLE. */
export async function askPayPalToVerify(client: PayPalClient, t: TransmissionHeaders, webhookId: string, rawBody: Uint8Array, timeoutMs = 5_000): Promise<PayPalCheck> {
  if (!t.authAlgo || !t.certUrl || !t.transmissionId || !t.transmissionSig || !t.transmissionTime) return "UNAVAILABLE";
  let rawEvent: string;
  try {
    rawEvent = new TextDecoder("utf-8", { fatal: true }).decode(rawBody);
  } catch {
    return "UNAVAILABLE";
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<"UNAVAILABLE">((resolve) => {
    timer = setTimeout(() => resolve("UNAVAILABLE"), timeoutMs);
  });
  const asked = client
    .request<{ verification_status?: unknown }>("POST", PATH, { rawJson: verifyRequestBody(t, webhookId, rawEvent) })
    .then(({ data }): PayPalCheck => (data?.verification_status === "SUCCESS" ? "SUCCESS" : data?.verification_status === "FAILURE" ? "FAILURE" : "UNAVAILABLE"))
    .catch((): PayPalCheck => "UNAVAILABLE");
  try {
    return await Promise.race([asked, timedOut]);
  } finally {
    clearTimeout(timer);
  }
}
