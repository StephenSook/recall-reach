import { createHmac, timingSafeEqual } from "node:crypto";
import { requireSecret } from "../privacy/secrets";

const signature = (secret: string, key: string) => createHmac("sha256", secret).update(`safety-receipt\u0000${key}`).digest("base64url");

/** Signs a random public key, never a shop id. A receipt link grants no owner access. */
export function receiptTokenFor(secret: string, key: string): string {
  requireSecret(secret, "safety receipt");
  const opaque = Buffer.from(key.replaceAll("-", ""), "hex").toString("base64url");
  return `${opaque}.${signature(secret, opaque)}`;
}

export function receiptKeyFromToken(secret: string, token: string): string | null {
  requireSecret(secret, "safety receipt");
  if (!/^[\w-]{22}\.[\w-]{43}$/.test(token)) return null;
  const [key, signed] = token.split(".");
  const expected = Buffer.from(signature(secret, key));
  if (!timingSafeEqual(Buffer.from(signed), expected)) return null;
  const bytes = Buffer.from(key, "base64url");
  if (bytes.toString("base64url") !== key) return null;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
