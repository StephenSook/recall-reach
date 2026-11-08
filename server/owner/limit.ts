import { clientIp, createRateLimiter } from "../web/rateLimit";

/** Each start of a PayPal sign-in from one visitor. Enough to retry, too few to churn PayPal's sign-in for anyone. */
const perVisitor = createRateLimiter({ limit: 20, windowMs: 10 * 60_000 });

export function ownerSignInAllowed(headers: Headers): boolean {
  const ip = clientIp(headers);
  return ip !== null && perVisitor(ip);
}
