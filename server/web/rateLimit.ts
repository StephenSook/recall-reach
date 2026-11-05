/** In memory, which is enough for this single-instance service. Returns whether this call may proceed. */
export function createRateLimiter(opts: {
  limit: number;
  windowMs: number;
  now?: () => number;
  onSweep?: (sizeAfter: number) => void;
}): (key: string) => boolean {
  const now = opts.now ?? Date.now;
  const hits = new Map<string, number[]>();
  let lastSweep = now();
  return (key) => {
    const at = now();
    if (at - lastSweep > opts.windowMs) {
      for (const [k, times] of hits) {
        const live = times.filter((t) => at - t <= opts.windowMs);
        if (live.length === 0) hits.delete(k);
        else hits.set(k, live);
      }
      lastSweep = at;
      hits.set(key, []);
      opts.onSweep?.(hits.size);
    }
    const recent = (hits.get(key) ?? []).filter((t) => at - t <= opts.windowMs);
    if (recent.length >= opts.limit) {
      hits.set(key, recent);
      return false;
    }
    recent.push(at);
    hits.set(key, recent);
    return true;
  };
}

export function clientIp(headers: Headers): string {
  return headers.get("x-forwarded-for")?.split(",")[0].trim() || "unknown";
}
