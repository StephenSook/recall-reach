import { clientIp, createRateLimiter } from "./rateLimit";

// A shop's own check compares every line with every recall, so a file and a store address share one limit,
// per visitor and for everyone together.
const perVisitor = createRateLimiter({ limit: 5, windowMs: 60 * 60_000 });
const everyone = createRateLimiter({ limit: 30, windowMs: 60 * 60_000 });

export function ownCheckAllowed(headers: Headers): boolean {
  const visitor = clientIp(headers);
  return Boolean(visitor) && perVisitor(visitor as string) && everyone("all");
}
