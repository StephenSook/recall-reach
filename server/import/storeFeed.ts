// Reads a store's public Shopify feed from an address a stranger typed. The server makes that request, so the name
// and everything it answers are hostile until checked: https only, public addresses only, the checked address is
// the one connected to, no redirects are followed, and only /robots.txt and /products.json are ever asked for.
// Only a title and whether it's for sale are kept. A feed's vendor field can hold a consignor's name, so it's never read.
import { lookup } from "node:dns/promises";
import { request } from "node:https";
import { BlockList, isIP } from "node:net";
import { setTimeout as wait } from "node:timers/promises";
import { createRateLimiter } from "../web/rateLimit";
import { MAX_LINES } from "./ownFile";

export const FEED_USER_AGENT = "RecallReachBot/1.0 (+https://recall-reach-web-e022.onrender.com/privacy)";
const ROBOTS_TOKEN = "recallreachbot";
const ROBOTS_PATH = "/robots.txt";
const PAGE_SIZE = 250;
/** Counted in pages as well as listings: a store can send full pages with nothing usable on them, forever. */
const MAX_PAGES = Math.ceil(MAX_LINES / PAGE_SIZE);
const GAP_MS = 5000;
/** A store asking for longer gaps than this can't be read during one visit, so it isn't read. */
const MAX_GAP_MS = 30_000;
const REQUEST_TIMEOUT_MS = 20_000;
/** Measured: a full page of 250 from a real store is 1.8 MB. */
const MAX_PAGE_BYTES = 8_000_000;
const MAX_ROBOTS_BYTES = 512_000;
const MAX_ADDRESS = 300;
const MAX_TITLE = 200;

export type StoreFeedCode = "BAD_ADDRESS" | "CANT_REACH" | "NO_FEED" | "ROBOTS" | "MOVED" | "EMPTY_FEED" | "BUSY";

export class StoreFeedRefused extends Error {
  constructor(readonly code: StoreFeedCode) {
    super(code);
    this.name = "StoreFeedRefused";
  }
}

export class FeedTooBig extends Error {
  constructor() {
    super("the answer was over the byte limit");
    this.name = "FeedTooBig";
  }
}

export interface FeedAnswer {
  status: number;
  location: string | null;
  body: string;
}

export interface FeedTarget {
  host: string;
  /** Already checked. Nothing below this asks DNS again, so a name can't change its answer afterwards. */
  address: string;
  path: string;
  maxBytes?: number;
}

export interface StoreFeedDeps {
  resolve: (host: string) => Promise<string[]>;
  get: (target: FeedTarget) => Promise<FeedAnswer>;
  sleep: (ms: number) => Promise<void>;
  /** May this store be read now? Answers with how to say the read is over, or null. Absent means no limit. */
  enter?: StoreGate;
}

export type StoreGate = (host: string) => (() => void) | null;

/**
 * One read of a store at a time, so the gap between pages holds however many people ask, and a few reads an hour. Each
 * name is charged when a read reaches it, so moving from mystore.com to www.mystore.com pays for both.
 */
export function createStoreGate(): StoreGate {
  const reading = new Set<string>();
  const allowed = createRateLimiter({ limit: 6, windowMs: 60 * 60_000 });
  return (host) => {
    if (reading.has(host) || !allowed(host)) return null;
    reading.add(host);
    return () => reading.delete(host);
  };
}

export interface StoreListing {
  title: string;
  listed: boolean;
}

export interface StoreRead {
  host: string;
  listings: StoreListing[];
  /** False when it stopped early: at the limit, or when the store stopped answering. */
  complete: boolean;
}

const HOST_LABEL = /^(?!-)[a-z0-9-]{1,63}(?<!-)$/;
const NEVER_PUBLIC_NAME = /(?:^|\.)(?:localhost|local|internal|arpa|onion)$/;

/** The store's name, or a refusal, with no network used. Whatever path was typed is dropped here. */
export function readStoreAddress(typed: string): string {
  const refuse = () => new StoreFeedRefused("BAD_ADDRESS");
  const text = typed.trim();
  if (!text || text.length > MAX_ADDRESS) throw refuse();
  const hasScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(text);
  if (hasScheme && !/^https:\/\//i.test(text)) throw refuse();
  let url: URL;
  try {
    url = new URL(hasScheme ? text : `https://${text}`);
  } catch {
    throw refuse();
  }
  // The parser has already turned 2130706433, 0x7f.1 and 0177.0.0.1 into 127.0.0.1, and dropped a port of 443.
  if (url.protocol !== "https:" || url.username || url.password || url.port) throw refuse();
  const host = url.hostname.replace(/\.$/, "").toLowerCase();
  const labels = host.split(".");
  if (isIP(host.replace(/^\[|\]$/g, "")) || labels.length < 2 || host.length > 253 || !labels.every((l) => HOST_LABEL.test(l)) || NEVER_PUBLIC_NAME.test(host)) throw refuse();
  return host;
}

const NOT_PUBLIC_V4 = new BlockList();
for (const [net, bits] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.31.196.0", 24],
  ["192.52.193.0", 24],
  ["192.88.99.0", 24],
  ["192.168.0.0", 16],
  ["192.175.48.0", 24],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
] as const) {
  NOT_PUBLIC_V4.addSubnet(net, bits, "ipv4");
}

// IPv6 is an allow list: global unicast only, less the parts of it that aren't. That shuts out mapped and embedded
// IPv4 (::ffff:, 64:ff9b::), loopback, link-local and unique-local without naming each one.
const GLOBAL_V6 = new BlockList();
GLOBAL_V6.addSubnet("2000::", 3, "ipv6");
const NOT_PUBLIC_V6 = new BlockList();
for (const [net, bits] of [
  ["2001::", 23],
  ["2001:db8::", 32],
  ["2002::", 16],
  ["3fff::", 20],
] as const) {
  NOT_PUBLIC_V6.addSubnet(net, bits, "ipv6");
}

export function isPublicAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return !NOT_PUBLIC_V4.check(address, "ipv4");
  if (family === 6) return GLOBAL_V6.check(address, "ipv6") && !NOT_PUBLIC_V6.check(address, "ipv6");
  return false;
}

/** An encoded letter or digit means that letter or digit, so a rule can't hide behind one. An encoded ? or / means something else, and stays (RFC 3986). */
const decodeUnreserved = (pattern: string) =>
  pattern.replace(/%([0-9a-f]{2})/gi, (whole, hex: string) => {
    const character = String.fromCharCode(parseInt(hex, 16));
    return /[A-Za-z0-9\-._~]/.test(character) ? character : whole.toUpperCase();
  });

/** A robots.txt pattern against a path, with * and a final $. A loop, not a regex: anyone can write this file, and a regex built from it could hang the server. */
function patternMatches(pattern: string, path: string): boolean {
  const anchored = pattern.endsWith("$");
  const p = anchored ? pattern.slice(0, -1) : pattern;
  let i = 0;
  let j = 0;
  let star = -1;
  let mark = 0;
  while (i < path.length) {
    if (!anchored && j === p.length) return true;
    if (j < p.length && p[j] === "*") {
      star = j++;
      mark = i;
    } else if (j < p.length && p[j] === path[i]) {
      i++;
      j++;
    } else if (star >= 0) {
      j = star + 1;
      i = ++mark;
    } else {
      return false;
    }
  }
  while (j < p.length && p[j] === "*") j++;
  return j === p.length;
}

interface RobotsGroup {
  agents: string[];
  rules: { allow: boolean; pattern: string }[];
  delayMs: number;
}

/** The rules that apply to this bot. A group naming it replaces the star group. The longest match wins, and allow wins a tie (RFC 9309). */
export function robotsRules(text: string): ((path: string) => boolean) & { crawlDelayMs: number } {
  const groups: RobotsGroup[] = [];
  let current: RobotsGroup | null = null;
  let lastWasAgent = false;
  for (const line of text.replace(/^\ufeff/, "").split(/\r\n|\r|\n/)) {
    const field = /^\s*([a-z-]+)\s*:\s*(.*?)\s*$/i.exec(line.split("#")[0]);
    if (!field) continue;
    const key = field[1].toLowerCase();
    const value = field[2];
    if (key === "user-agent") {
      if (!current || !lastWasAgent) {
        current = { agents: [], rules: [], delayMs: 0 };
        groups.push(current);
      }
      current.agents.push(value.toLowerCase());
      lastWasAgent = true;
    } else if (key === "allow" || key === "disallow") {
      lastWasAgent = false;
      if (current && value) current.rules.push({ allow: key === "allow", pattern: decodeUnreserved(value) });
    } else if (key === "crawl-delay") {
      lastWasAgent = false;
      const seconds = Number(value);
      if (current && Number.isFinite(seconds) && seconds > 0) current.delayMs = seconds * 1000;
    }
  }
  const mine = groups.filter((g) => g.agents.includes(ROBOTS_TOKEN));
  const applied = mine.length > 0 ? mine : groups.filter((g) => g.agents.includes("*"));
  const rules = applied.flatMap((g) => g.rules);
  const allowed = (path: string) => {
    let best: { allow: boolean; pattern: string } | null = null;
    for (const rule of rules) {
      if (!patternMatches(rule.pattern, path)) continue;
      if (!best || rule.pattern.length > best.pattern.length || (rule.pattern.length === best.pattern.length && rule.allow)) best = rule;
    }
    return best ? best.allow : true;
  };
  return Object.assign(allowed, { crawlDelayMs: Math.max(0, ...applied.map((g) => g.delayMs)) });
}

/** One GET to the checked address. TLS still has to prove the store's name, and a redirect comes back as an answer. */
export function pinnedGet(target: FeedTarget & { port?: number; ca?: string; timeoutMs?: number }): Promise<FeedAnswer> {
  const maxBytes = target.maxBytes ?? MAX_PAGE_BYTES;
  return new Promise((resolve, reject) => {
    const req = request(
      {
        host: target.address,
        port: target.port ?? 443,
        path: target.path,
        method: "GET",
        servername: target.host,
        ca: target.ca,
        agent: false,
        headers: { host: target.host, "user-agent": FEED_USER_AGENT, accept: "application/json, text/plain", "accept-encoding": "identity", connection: "close" },
        signal: AbortSignal.timeout(target.timeoutMs ?? REQUEST_TIMEOUT_MS),
      },
      (res) => {
        const tooBig = () => {
          reject(new FeedTooBig());
          req.destroy();
        };
        if (Number(res.headers["content-length"]) > maxBytes) return tooBig();
        const chunks: Buffer[] = [];
        let total = 0;
        res.on("data", (chunk: Buffer) => {
          total += chunk.length;
          if (total > maxBytes) return tooBig();
          chunks.push(chunk);
        });
        res.on("end", () => resolve({ status: res.statusCode ?? 0, location: res.headers.location ?? null, body: Buffer.concat(chunks).toString("utf8") }));
        res.on("error", reject);
        res.on("close", () => {
          if (!res.complete) reject(new Error("the connection closed before the answer ended"));
        });
      },
    );
    req.on("error", reject);
    req.end();
  });
}

const REAL_DEPS: StoreFeedDeps = {
  enter: createStoreGate(),
  resolve: async (host) => (await lookup(host, { all: true, verbatim: true })).map((a) => a.address),
  get: (target) => pinnedGet(target),
  sleep: async (ms) => {
    await wait(ms);
  },
};

/** Every answer DNS gives has to be public, since the connection could otherwise be steered to the private one. */
async function checkedAddress(host: string, deps: StoreFeedDeps): Promise<string> {
  let addresses: string[];
  try {
    addresses = await deps.resolve(host);
  } catch {
    throw new StoreFeedRefused("CANT_REACH");
  }
  if (addresses.length === 0 || !addresses.every(isPublicAddress)) throw new StoreFeedRefused("CANT_REACH");
  return addresses.find((a) => isIP(a) === 4) ?? addresses[0];
}

const isRedirect = (status: number) => status >= 300 && status < 400;

/** The one redirect worth acting on: the same name with or without www. It is treated as a newly typed address, not followed. */
function sameStoreOtherName(host: string, location: string | null): string | null {
  if (!location) return null;
  try {
    const url = new URL(location, `https://${host}/`);
    if (url.protocol !== "https:" || url.port || url.username || url.password) return null;
    const to = readStoreAddress(url.hostname);
    return to === `www.${host}` || host === `www.${to}` ? to : null;
  } catch {
    return null;
  }
}

function cleanTitle(title: string): string {
  const flat = title.replace(/\p{C}+/gu, " ").replace(/\s+/g, " ").trim();
  return Array.from(flat).slice(0, MAX_TITLE).join("").trim();
}

function toListing(product: unknown): StoreListing | null {
  if (typeof product !== "object" || product === null) return null;
  const { title, variants } = product as { title?: unknown; variants?: unknown };
  if (typeof title !== "string") return null;
  const clean = cleanTitle(title);
  if (!clean) return null;
  const states = Array.isArray(variants) ? variants : [];
  const soldOut = states.length > 0 && states.every((v) => (v as { available?: unknown } | null)?.available === false);
  return { title: clean, listed: !soldOut };
}

/** A 200 proves nothing: a bot check can arrive as one, so the content decides. */
function feedProducts(answer: FeedAnswer): unknown[] | null {
  if (answer.status !== 200) return null;
  try {
    const products = (JSON.parse(answer.body) as { products?: unknown } | null)?.products;
    return Array.isArray(products) ? products : null;
  } catch {
    return null;
  }
}

const refusalFor = (err: unknown) => new StoreFeedRefused(err instanceof FeedTooBig ? "NO_FEED" : "CANT_REACH");

async function readFrom(host: string, deps: StoreFeedDeps, mayChangeName: boolean): Promise<StoreRead> {
  const leave = deps.enter ? deps.enter(host) : () => {};
  if (!leave) throw new StoreFeedRefused("BUSY");
  try {
    return await readEntered(host, deps, mayChangeName);
  } finally {
    leave();
  }
}

async function readEntered(host: string, deps: StoreFeedDeps, mayChangeName: boolean): Promise<StoreRead> {
  const address = await checkedAddress(host, deps);
  const moveOn = async (location: string | null) => {
    const other = mayChangeName ? sameStoreOtherName(host, location) : null;
    if (!other) throw new StoreFeedRefused("MOVED");
    await deps.sleep(GAP_MS);
    return readFrom(other, deps, false);
  };

  let robots: FeedAnswer;
  try {
    robots = await deps.get({ host, address, path: ROBOTS_PATH, maxBytes: MAX_ROBOTS_BYTES });
  } catch (err) {
    throw refusalFor(err);
  }
  if (isRedirect(robots.status)) return moveOn(robots.location);
  // Missing means no rules. Anything else that isn't an answer is a reason to stop, not a reason to go ahead.
  if (robots.status !== 200 && robots.status !== 404 && robots.status !== 410) throw new StoreFeedRefused("NO_FEED");
  const rules = robotsRules(robots.status === 200 ? robots.body : "");
  if (rules.crawlDelayMs > MAX_GAP_MS) throw new StoreFeedRefused("ROBOTS");
  const gap = Math.max(GAP_MS, rules.crawlDelayMs);

  const listings: StoreListing[] = [];
  let complete = true;
  for (let page = 1; page <= MAX_PAGES; page++) {
    const path = `/products.json?limit=${PAGE_SIZE}&page=${page}`;
    if (!rules(path)) {
      if (page === 1) throw new StoreFeedRefused("ROBOTS");
      complete = false;
      break;
    }
    await deps.sleep(gap);
    let answer: FeedAnswer;
    try {
      answer = await deps.get({ host, address, path });
    } catch (err) {
      if (page === 1) throw refusalFor(err);
      complete = false;
      break;
    }
    if (page === 1 && isRedirect(answer.status)) return moveOn(answer.location);
    const products = feedProducts(answer);
    if (!products) {
      if (page === 1) throw new StoreFeedRefused("NO_FEED");
      complete = false;
      break;
    }
    for (const product of products) {
      const listing = toListing(product);
      if (listing) listings.push(listing);
    }
    if (listings.length >= MAX_LINES) {
      complete = false;
      break;
    }
    if (products.length < PAGE_SIZE) break;
    if (page === MAX_PAGES) complete = false;
  }
  if (listings.length === 0) throw new StoreFeedRefused("EMPTY_FEED");
  return { host, listings: listings.slice(0, MAX_LINES), complete };
}

export function readStoreListings(typed: string, deps: StoreFeedDeps = REAL_DEPS): Promise<StoreRead> {
  return (async () => readFrom(readStoreAddress(typed), deps, true))();
}
