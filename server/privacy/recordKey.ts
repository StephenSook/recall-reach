import { createHmac } from "node:crypto";
import { requireSecret } from "./secrets";

/**
 * Keys for storing a reference to a PayPal id without storing the id. Whether a plain hash of a
 * PayPal transaction id still counts as transaction history is unclear,
 * so references are an HMAC under a secret: unreadable and unlinkable without it.
 * The kind is mixed in, so the same id used for two purposes gives two unrelated keys.
 */
export type RecordKey = (kind: RecordKind, value: string) => string;

/** A fixed list with no separator in it, so a kind and a value can't run together into another kind's key. */
export type RecordKind = "paypal-event" | "paypal-body" | "paypal-transmission" | "paypal-resource" | "paypal-tracking" | "paypal-merchant";

export function createRecordKey(secret: string): RecordKey {
  requireSecret(secret, "record key");
  return (kind, value) => createHmac("sha256", secret).update(`${kind}\u0000${value}`).digest("hex");
}

/**
 * One secret for the whole deployment, RECORD_HMAC_SECRET, not one per shop. Returns null when it is not configured.
 */
export function recordKeyFromEnv(env: NodeJS.ProcessEnv = process.env): RecordKey | null {
  const secret = env.RECORD_HMAC_SECRET;
  return secret ? createRecordKey(secret) : null;
}
