import { isIP } from "node:net";

/**
 * In memory, which is enough for this single-instance service. Returns whether this call may proceed.
 * The map stays bounded inside the window too: past maxKeys it drops the key that has gone longest unused.
 */
export function createRateLimiter(opts: {
  limit: number;
  windowMs: number;
  now?: () => number;
  maxKeys?: number;
  onSweep?: (sizeAfter: number) => void;
  onSize?: (size: number) => void;
}): (key: string) => boolean {
  const now = opts.now ?? Date.now;
  const maxKeys = opts.maxKeys ?? 10_000;
  const hits = new Map<string, number[]>();
  let lastSweep = now();
  return (key) => {
    const at = now();
    const sweeping = at - lastSweep > opts.windowMs;
    if (sweeping) {
      for (const [k, times] of hits) {
        const live = times.filter((t) => at - t <= opts.windowMs);
        if (live.length === 0) hits.delete(k);
        else hits.set(k, live);
      }
      lastSweep = at;
    }
    const recent = (hits.get(key) ?? []).filter((t) => at - t <= opts.windowMs);
    const allowed = recent.length < opts.limit;
    if (allowed) recent.push(at);
    hits.delete(key);
    hits.set(key, recent);
    for (const oldest of hits.keys()) {
      if (hits.size <= maxKeys) break;
      hits.delete(oldest);
    }
    if (sweeping) opts.onSweep?.(hits.size);
    opts.onSize?.(hits.size);
    return allowed;
  };
}

/**
 * Who is asking. Measured on Render, 2026-11-06, with forged headers: x-forwarded-for keeps whatever the caller
 * sent on its left, and its last entry is a proxy, not the visitor. True-Client-IP ignored a forged value, and
 * forging CF-Connecting-IP got a 403 from Cloudflare. Null on the host means it cannot tell, so nothing is spent.
 */
export function clientIp(headers: Headers, onHost: boolean = Boolean(process.env.RENDER_EXTERNAL_URL)): string | null {
  const address = headers.get("true-client-ip")?.trim();
  if (address) return visitorKey(address);
  return onHost ? null : "local";
}

/** One visitor per IPv4 address or IPv6 /64: a single home network can hold countless IPv6 addresses. */
function visitorKey(address: string): string | null {
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address)?.[1];
  const plain = mapped ?? address;
  if (isIP(plain) === 4) return plain;
  if (isIP(plain) !== 6) return null;
  const [head, tail = ""] = plain.toLowerCase().split("%")[0].split("::");
  const front = head ? head.split(":") : [];
  const back = tail ? tail.split(":") : [];
  const groups = plain.includes("::") ? [...front, ...Array<string>(8 - front.length - back.length).fill("0"), ...back] : front;
  return groups.slice(0, 4).map((g) => g.replace(/^0+(?=.)/, "")).join(":") + "::/64";
}
