import { clientIp, createRateLimiter } from "../web/rateLimit";

/** Same single-instance limits as the shop's file form, shared across every shop link. */
export function createReceiptLimiter(opts: { now?: () => number } = {}) {
  const visitor = createRateLimiter({ limit: 5, windowMs: 3_600_000, now: opts.now });
  const global = createRateLimiter({ limit: 200, windowMs: 3_600_000, now: opts.now });
  return (headers: Headers): boolean => {
    const ip = clientIp(headers);
    return ip !== null && visitor(ip) && global("all");
  };
}

export const receiptAllowed = createReceiptLimiter();
