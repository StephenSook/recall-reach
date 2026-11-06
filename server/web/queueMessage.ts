// The queue page shows a message passed in its address. Signing it means a link from anyone else can't put
// words on the seller's screen.
import { createHmac, timingSafeEqual } from "node:crypto";

const signature = (secret: string, message: string) => createHmac("sha256", secret).update(`queue-message:${message}`).digest("base64url");

export function messageQuery(secret: string, message: string): string {
  return `message=${encodeURIComponent(message)}&sig=${signature(secret, message)}`;
}

/** The message, if this server wrote it. */
export function trustedMessage(secret: string, message: unknown, sig: unknown): string | null {
  if (typeof message !== "string" || typeof sig !== "string") return null;
  const given = Buffer.from(sig);
  const expected = Buffer.from(signature(secret, message));
  return given.length === expected.length && timingSafeEqual(given, expected) ? message : null;
}
