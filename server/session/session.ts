import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

export const SESSION_COOKIE = "rr_session";

const sign = (secret: string, payload: string) => createHmac("sha256", secret).update(`shop-session\u0000${payload}`).digest("base64url");

export interface ShopSession {
  shopId: string;
  sessionId: string;
}

const SESSION_MS = 24 * 3_600_000;

/**
 * A signed cookie value naming the shop and this browser's session. Approvals are bound to it. The expiry is
 * inside what is signed: the cookie's Max-Age only tells a browser when to drop it, and a copied one is not bound by that.
 */
export function sessionCookie(secret: string, shopId: string, now: Date = new Date(), lastsMs: number = SESSION_MS): { value: string; sessionId: string } {
  if (secret.length < 32) throw new Error("session secret must be at least 32 characters");
  const sessionId = randomBytes(16).toString("hex");
  const payload = `${shopId}.${sessionId}.${now.getTime() + lastsMs}`;
  return { value: `${payload}.${sign(secret, payload)}`, sessionId };
}

export function readSession(secret: string, value: string | undefined, now: Date = new Date()): ShopSession | null {
  if (!value) return null;
  const parts = value.split(".");
  if (parts.length !== 4) return null;
  const [shopId, sessionId, expires, signature] = parts;
  const given = Buffer.from(signature);
  const expected = Buffer.from(sign(secret, `${shopId}.${sessionId}.${expires}`));
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  if (!(Number(expires) > now.getTime())) return null;
  return { shopId, sessionId };
}
