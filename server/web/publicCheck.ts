import { clientIp, createRateLimiter } from "./rateLimit";

// Each check wakes the database, so the public ways in share one limit, per visitor and for everyone together.
const perVisitor = createRateLimiter({ limit: 60, windowMs: 60 * 60_000 });
const everyone = createRateLimiter({ limit: 600, windowMs: 60 * 60_000 });

export function publicCheckAllowed(headers: Headers): boolean {
  const visitor = clientIp(headers);
  return Boolean(visitor) && perVisitor(visitor as string) && everyone("all");
}
