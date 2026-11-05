import { createSign, generateKeyPairSync } from "node:crypto";
import { signedMessage } from "../server/paypal/webhooks";

// A throwaway key pair that stands in for PayPal's signing certificate in tests.
// It is generated at runtime; no key material is stored in the repo.
const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });

export const TEST_PUBLIC_PEM = publicKey.export({ type: "spki", format: "pem" }).toString();
export const TEST_CERT_URL = "https://api.sandbox.paypal.com/v1/notifications/certs/CERT-test";
export const fetchTestCert = async () => TEST_PUBLIC_PEM;

/** HTTP headers exactly as PayPal would send them for this body and webhook id. */
export function paypalHeaders(rawBody: Uint8Array, webhookId: string): Headers {
  const transmissionId = "0f3c9b10-test";
  const transmissionTime = "2026-11-05T20:00:00Z";
  const signer = createSign("sha256WithRSAEncryption");
  signer.update(signedMessage(transmissionId, transmissionTime, webhookId, rawBody));
  return new Headers({
    "content-type": "application/json",
    "paypal-transmission-id": transmissionId,
    "paypal-transmission-time": transmissionTime,
    "paypal-transmission-sig": signer.sign(privateKey).toString("base64"),
    "paypal-cert-url": TEST_CERT_URL,
    "paypal-auth-algo": "SHA256withRSA",
  });
}
