import { createHmac } from "node:crypto";

/**
 * Keys for storing a reference to a PayPal id without storing the id. Whether a plain hash of a
 * PayPal transaction id still counts as transaction history is unclear (research/O-LEGAL-DATA-USE.md),
 * so references are an HMAC under a secret: unreadable and unlinkable without it.
 * The kind is mixed in, so the same id used for two purposes gives two unrelated keys.
 */
export type RecordKey = (kind: string, value: string) => string;

export function createRecordKey(secret: string): RecordKey {
  if (secret.length < 32) throw new Error("record key secret must be at least 32 characters");
  return (kind, value) => createHmac("sha256", secret).update(`${kind}\u0000${value}`).digest("hex");
}

/**
 * One secret for the whole deployment, RECORD_HMAC_SECRET, not one per shop. Returns null when it is not configured.
 */
export function recordKeyFromEnv(env: NodeJS.ProcessEnv = process.env): RecordKey | null {
  const secret = env.RECORD_HMAC_SECRET;
  return secret ? createRecordKey(secret) : null;
}
