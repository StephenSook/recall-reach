import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

export const SESSION_COOKIE = "rr_session";

const sign = (secret: string, payload: string) => createHmac("sha256", secret).update(`shop-session\u0000${payload}`).digest("base64url");

export interface ShopSession {
  shopId: string;
  sessionId: string;
}

/** A signed cookie value naming the shop and this browser's session. Approvals are bound to it. */
export function sessionCookie(secret: string, shopId: string): { value: string; sessionId: string } {
  if (secret.length < 32) throw new Error("session secret must be at least 32 characters");
  const sessionId = randomBytes(16).toString("hex");
  const payload = `${shopId}.${sessionId}`;
  return { value: `${payload}.${sign(secret, payload)}`, sessionId };
}

export function readSession(secret: string, value: string | undefined): ShopSession | null {
  if (!value) return null;
  const parts = value.split(".");
  if (parts.length !== 3) return null;
  const [shopId, sessionId, signature] = parts;
  const given = Buffer.from(signature);
  const expected = Buffer.from(sign(secret, `${shopId}.${sessionId}`));
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  return { shopId, sessionId };
}
