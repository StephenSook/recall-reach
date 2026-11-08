// The state a Log in with PayPal round trip carries. A random value goes to PayPal and comes back in the URL; the same
// value, what the sign-in is for, and its expiry ride in a signed cookie only this site can make. The return accepts
// the code only when the two agree, so another site can't start a sign-in that lands in someone's session.
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { requireSecret } from "../privacy/secrets";

export const OWNER_STATE_COOKIE = "rr_owner_paypal";
export const OWNER_STATE_MS = 10 * 60_000;

/** Link: a signed-in shop ties its owner's PayPal login to itself. Sign in: that login opens the shop again. */
export type OwnerIntent = { kind: "link"; shopId: string } | { kind: "signin" };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const sign = (secret: string, payload: string) => createHmac("sha256", secret).update(`owner-paypal-state\u0000${payload}`).digest("base64url");
const same = (a: string, b: string) => {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};

export function startOwnerState(secret: string, intent: OwnerIntent, now: Date = new Date()): { state: string; cookie: string } {
  requireSecret(secret, "owner sign-in");
  const state = randomBytes(32).toString("base64url");
  const payload = `${state}.${intent.kind}.${intent.kind === "link" ? intent.shopId : "-"}.${now.getTime() + OWNER_STATE_MS}`;
  return { state, cookie: `${payload}.${sign(secret, payload)}` };
}

export function readOwnerState(secret: string, cookie: string | undefined, state: string, now: Date = new Date()): OwnerIntent | null {
  requireSecret(secret, "owner sign-in");
  if (!cookie || !state) return null;
  const parts = cookie.split(".");
  if (parts.length !== 5) return null;
  const [saved, kind, shopId, expires, signature] = parts;
  if (!same(signature, sign(secret, `${saved}.${kind}.${shopId}.${expires}`))) return null;
  if (!(Number(expires) > now.getTime())) return null;
  if (!same(saved, state)) return null;
  if (kind === "signin" && shopId === "-") return { kind: "signin" };
  if (kind === "link" && UUID.test(shopId)) return { kind: "link", shopId };
  return null;
}
