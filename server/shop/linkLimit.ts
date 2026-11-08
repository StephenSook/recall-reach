// How often one shop may check or connect its PayPal account. Each holds a database connection while PayPal answers, so
// one shop mustn't keep the shared slots full. Disconnecting is never limited.
import { createRateLimiter } from "../web/rateLimit";

export const LINK_CHANGES_PER_WINDOW = 10;

export function createLinkLimiter(opts: { now?: () => number } = {}): (shopId: string) => boolean {
  return createRateLimiter({ limit: LINK_CHANGES_PER_WINDOW, windowMs: 10 * 60_000, now: opts.now });
}

export const linkChangeAllowed = createLinkLimiter();
