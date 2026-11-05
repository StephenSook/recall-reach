// PayPal webhook signature verification ("self" method: RSA check against PayPal's certificate).
//
// Approach adapted from paypaldev/video-bytemonkio-paypal-tutorial (src/paypal/webhooks.ts),
// MIT License, Copyright (c) 2026 ByteMonk LLC. Changes here: certificates are accepted only
// from PayPal's sandbox hosts and certificate path (this app never runs against live PayPal),
// the auth algorithm is pinned, and a verified body must look like a webhook event.
//
// Contract (developer.paypal.com/api/rest/webhooks/rest/): PayPal signs
//   transmission_id | transmission_time | webhook_id | crc32(raw body, decimal)
// with SHA256withRSA, and names the signing certificate in the paypal-cert-url header.
// The CRC must be computed over the exact bytes received; re-serialized JSON will not match.
import { createPublicKey, verify } from "node:crypto";
import { crc32 } from "node:zlib";
import { readCappedBody } from "../http/body";

export interface TransmissionHeaders {
  transmissionId?: string;
  transmissionTime?: string;
  transmissionSig?: string;
  certUrl?: string;
  authAlgo?: string;
}

export interface WebhookEvent {
  id: string;
  event_type: string;
  create_time?: string;
  resource_type?: string;
  resource?: Record<string, unknown>;
  [key: string]: unknown;
}

export type VerifyResult = { verified: true; event: WebhookEvent } | { verified: false; reason: string };

export type CertFetcher = (certUrl: string) => Promise<string>;

const SANDBOX_CERT_HOSTS = new Set(["api.sandbox.paypal.com", "api-m.sandbox.paypal.com"]);
// One path segment of letters, digits and hyphens, as in CERT-360caa42-fca2a594-1d93a270: no
// encoded slashes, no dots, so the path cannot be walked to some other endpoint on the host.
const CERT_PATH = /^\/v1\/notifications\/certs\/[A-Za-z0-9-]+$/;
const MAX_CERT_BYTES = 64 * 1024;
const AUTH_ALGO = "SHA256withRSA";

/** The paypal-cert-url header is attacker-controlled: only PayPal sandbox certificate URLs pass. */
export function isTrustedCertUrl(certUrl: string): boolean {
  let url: URL;
  try {
    url = new URL(certUrl);
  } catch {
    return false;
  }
  return (
    url.protocol === "https:" &&
    url.port === "" &&
    url.username === "" &&
    url.password === "" &&
    !certUrl.includes("?") &&
    !certUrl.includes("#") &&
    SANDBOX_CERT_HOSTS.has(url.hostname) &&
    CERT_PATH.test(url.pathname)
  );
}

export function readTransmissionHeaders(headers: Headers): TransmissionHeaders {
  const get = (name: string) => headers.get(name) ?? undefined;
  return {
    transmissionId: get("paypal-transmission-id"),
    transmissionTime: get("paypal-transmission-time"),
    transmissionSig: get("paypal-transmission-sig"),
    certUrl: get("paypal-cert-url"),
    authAlgo: get("paypal-auth-algo"),
  };
}

export function signedMessage(
  transmissionId: string,
  transmissionTime: string,
  webhookId: string,
  rawBody: Uint8Array,
): string {
  return `${transmissionId}|${transmissionTime}|${webhookId}|${crc32(rawBody)}`;
}

/**
 * Downloads signing certificates from trusted URLs and keeps them in memory (they are stable). A
 * redirect is an error, not followed: only the URL that passed the check may supply the key. Only a
 * certificate that parses as a public key is cached.
 */
export function createCertFetcher(fetchImpl: typeof fetch = fetch, maxEntries = 16): CertFetcher {
  const cache = new Map<string, string>();
  return async (certUrl) => {
    if (!isTrustedCertUrl(certUrl)) throw new Error(`untrusted certificate URL: ${certUrl}`);
    const { origin, pathname } = new URL(certUrl);
    const key = origin + pathname;
    const cached = cache.get(key);
    if (cached) return cached;
    const res = await fetchImpl(certUrl, { signal: AbortSignal.timeout(10_000), cache: "no-store", redirect: "error" });
    if (!res.ok) throw new Error(`could not download signing certificate: HTTP ${res.status}`);
    const read = await readCappedBody(res, MAX_CERT_BYTES);
    if (!read.ok) throw new Error("signing certificate download is too large");
    const pem = Buffer.from(read.body).toString("utf8");
    try {
      createPublicKey(pem);
    } catch {
      throw new Error("signing certificate download is not a usable public key");
    }
    if (cache.size >= maxEntries) cache.delete(cache.keys().next().value as string);
    cache.set(key, pem);
    return pem;
  };
}

const defaultCertFetcher = createCertFetcher();

function isWebhookEvent(value: unknown): value is WebhookEvent {
  const v = value as Record<string, unknown> | null;
  return typeof v === "object" && v !== null && typeof v.id === "string" && typeof v.event_type === "string";
}

/**
 * Verifies a delivery and only then parses it. There is no way to get the event out of a
 * failed verification, so a caller cannot act on an unverified event. Never throws.
 */
export async function verifyWebhook(
  rawBody: Uint8Array,
  headers: TransmissionHeaders,
  webhookId: string,
  deps: { fetchCert?: CertFetcher } = {},
): Promise<VerifyResult> {
  const { transmissionId, transmissionTime, transmissionSig, certUrl, authAlgo } = headers;
  const missing = Object.entries({ transmissionId, transmissionTime, transmissionSig, certUrl, authAlgo })
    .filter(([, v]) => !v)
    .map(([k]) => k);
  if (missing.length > 0) return { verified: false, reason: `missing PayPal transmission header(s): ${missing.join(", ")}` };
  if (authAlgo !== AUTH_ALGO) return { verified: false, reason: `unexpected auth algorithm: ${authAlgo}` };
  if (!isTrustedCertUrl(certUrl!)) return { verified: false, reason: `untrusted certificate URL: ${certUrl}` };

  try {
    const pem = await (deps.fetchCert ?? defaultCertFetcher)(certUrl!);
    const message = signedMessage(transmissionId!, transmissionTime!, webhookId, rawBody);
    const ok = verify("sha256", Buffer.from(message), createPublicKey(pem), Buffer.from(transmissionSig!, "base64"));
    if (!ok) return { verified: false, reason: "signature did not match (wrong webhook id, or a forged event)" };
  } catch (err) {
    return { verified: false, reason: `verification error: ${err instanceof Error ? err.message : String(err)}` };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(rawBody).toString("utf8"));
  } catch {
    parsed = undefined;
  }
  if (!isWebhookEvent(parsed)) return { verified: false, reason: "verified bytes are not a PayPal webhook event" };
  return { verified: true, event: parsed };
}
