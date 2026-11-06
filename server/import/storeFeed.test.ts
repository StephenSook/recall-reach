import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:https";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TLSSocket } from "node:tls";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { MAX_LINES } from "./ownFile";
import {
  createStoreGate,
  FEED_USER_AGENT,
  FeedTooBig,
  isPublicAddress,
  pinnedGet,
  readStoreAddress,
  readStoreListings,
  robotsRules,
  StoreFeedRefused,
  type FeedAnswer,
  type FeedTarget,
  type StoreFeedDeps,
} from "./storeFeed";

const PUBLIC = "23.227.38.65";
const FEED = (page: number) => `/products.json?limit=250&page=${page}`;
const ok = (body: unknown): FeedAnswer => ({ status: 200, location: null, body: typeof body === "string" ? body : JSON.stringify(body) });
const missing: FeedAnswer = { status: 404, location: null, body: "not found" };
const moved = (location: string, status = 301): FeedAnswer => ({ status, location, body: "" });
const product = (title: unknown, available: boolean[] = [true]) => ({ title, vendor: "CONSIGNOR-SENTINEL", variants: available.map((a) => ({ available: a, price: "12.00" })), body_html: "<p>BODY-SENTINEL</p>" });
const pageOf = (n: number, start = 0) => ({ products: Array.from({ length: n }, (_, i) => product(`Item ${start + i}`)) });

/** A store that answers from a table, and remembers everything it was asked. */
function store(answers: Record<string, FeedAnswer | Error>, opts: { resolve?: (host: string, call: number) => string[] } = {}) {
  const calls: FeedTarget[] = [];
  const lookups: string[] = [];
  const slept: number[] = [];
  const deps: StoreFeedDeps = {
    resolve: async (host) => {
      lookups.push(host);
      return opts.resolve ? opts.resolve(host, lookups.length) : [PUBLIC];
    },
    get: async (target) => {
      calls.push(target);
      const key = `${target.host}${target.path}`;
      const answer = answers[key] ?? answers[target.path] ?? missing;
      if (answer instanceof Error) throw answer;
      return answer;
    },
    sleep: async (ms) => {
      slept.push(ms);
    },
  };
  return { deps, calls, lookups, slept };
}

const refusal = (p: Promise<unknown>) =>
  p.then(
    () => "no refusal",
    (e: unknown) => (e instanceof StoreFeedRefused ? e.code : `other: ${String(e)}`),
  );

describe("the address a stranger typed", () => {
  it.each([
    ["mystore.com", "mystore.com"],
    ["MyStore.COM", "mystore.com"],
    ["  mystore.com  ", "mystore.com"],
    ["mystore.com.", "mystore.com"],
    ["https://mystore.com", "mystore.com"],
    ["https://mystore.com/", "mystore.com"],
    ["https://www.mystore.com/collections/all?sort=new#top", "www.mystore.com"],
    ["https://mystore.com:443/", "mystore.com"],
    ["my-store.myshopify.com", "my-store.myshopify.com"],
    ["bücher.example", "xn--bcher-kva.example"],
  ])("reads %s as a store's name", (typed, host) => {
    expect(readStoreAddress(typed)).toBe(host);
  });

  it.each([
    "",
    "   ",
    "mystore",
    "http://mystore.com",
    "ftp://mystore.com",
    "file:///etc/passwd",
    "javascript:alert(1)",
    "mailto:someone@example.com",
    "https://user:password@mystore.com",
    "https://user@mystore.com",
    "https://mystore.com:8443",
    "mystore.com:22",
    "https://mystore.com:80",
    "localhost",
    "https://localhost",
    "foo.localhost",
    "printer.local",
    "metadata.google.internal",
    "4.3.2.1.in-addr.arpa",
    "hidden.onion",
    "127.0.0.1",
    "https://127.0.0.1",
    "https://2130706433",
    "https://0x7f.0.0.1",
    "https://0177.0.0.1",
    "169.254.169.254",
    "http://169.254.169.254/latest/meta-data",
    "10.0.0.1",
    "https://[::1]",
    "[::1]",
    "https://[::ffff:127.0.0.1]",
    "a b.com",
    "-bad.com",
    "bad-.com",
    "exa_mple.com",
    `${"x".repeat(300)}.com`,
  ])("refuses %j before any lookup", (typed) => {
    expect(() => readStoreAddress(typed)).toThrow(StoreFeedRefused);
  });
});

describe("which addresses may be connected to", () => {
  it.each([
    "0.0.0.0",
    "0.1.2.3",
    "10.1.2.3",
    "100.64.0.1",
    "100.127.255.255",
    "127.0.0.1",
    "127.8.8.8",
    "169.254.169.254",
    "172.16.0.1",
    "172.31.255.255",
    "192.0.0.1",
    "192.0.2.1",
    "192.88.99.1",
    "192.168.1.1",
    "198.18.0.1",
    "198.19.255.255",
    "198.51.100.1",
    "203.0.113.1",
    "224.0.0.1",
    "239.255.255.255",
    "240.0.0.1",
    "255.255.255.255",
    "::",
    "::1",
    "::127.0.0.1",
    "::ffff:127.0.0.1",
    "::ffff:169.254.169.254",
    "::ffff:23.227.38.65",
    "64:ff9b::7f00:1",
    "64:ff9b:1::1",
    "100::1",
    "2001::1",
    "2001:db8::1",
    "2002:7f00:1::1",
    "3fff::1",
    "fc00::1",
    "fd12:3456::1",
    "fe80::1",
    "fec0::1",
    "ff02::1",
    "not an address",
    "",
  ])("refuses %j", (address) => {
    expect(isPublicAddress(address)).toBe(false);
  });

  it.each(["23.227.38.65", "8.8.8.8", "172.32.0.1", "172.15.255.255", "100.128.0.1", "100.63.255.255", "192.169.0.1", "198.20.0.1", "2606:4700::1111", "2600:1f18::1"])("allows %s", (address) => {
    expect(isPublicAddress(address)).toBe(true);
  });
});

describe("robots.txt", () => {
  const SHOPIFY_DEFAULT = ["# we use Shopify", "User-agent: *", "Disallow: /admin", "Disallow: /cart", "Disallow: /collections/*sort_by*", "Sitemap: https://x/sitemap.xml", "", "User-agent: Nutch", "Disallow: /", "", "User-agent: AhrefsBot", "Crawl-delay: 10", "Disallow: /a"].join("\n");

  it("lets the feed through on Shopify's usual file, ignoring rules for other bots", () => {
    expect(robotsRules(SHOPIFY_DEFAULT)(FEED(1))).toBe(true);
    expect(robotsRules(SHOPIFY_DEFAULT).crawlDelayMs).toBe(0);
  });

  it.each([
    ["the feed by name", "User-agent: *\nDisallow: /products.json", false],
    ["everything", "User-agent: *\nDisallow: /", false],
    ["a wildcard", "User-agent: *\nDisallow: /*.json", false],
    ["a wildcard over the query", "User-agent: *\nDisallow: /products.json?*page=", false],
    ["an end anchor that doesn't reach", "User-agent: *\nDisallow: /products.json$", true],
    ["a longer allow beating a shorter disallow", "User-agent: *\nDisallow: /\nAllow: /products.json", true],
    ["a shorter allow losing to a longer disallow", "User-agent: *\nAllow: /\nDisallow: /products.json", false],
    ["an empty disallow", "User-agent: *\nDisallow:", true],
    ["a group naming us, over the star group", "User-agent: *\nDisallow:\n\nUser-agent: RecallReachBot\nDisallow: /", false],
    ["the same, in other letters, and a shared group", "User-agent: googlebot\nUSER-AGENT: recallreachbot\nDISALLOW: /products", false],
    ["a star group, when a group names us and allows", "User-agent: *\nDisallow: /\n\nUser-agent: RecallReachBot\nDisallow: /admin", true],
    ["a rule outside any group", "Disallow: /", true],
    ["no rules at all", "", true],
    ["an html page", "<html><body>Disallow: /</body></html>", true],
  ])("%s", (_name, text, allowed) => {
    expect(robotsRules(text)(FEED(1))).toBe(allowed);
  });

  it.each([
    ["lines ending in a bare CR", "User-agent: *\rDisallow: /products.json\r", false],
    ["lines ending in CRLF", "User-agent: *\r\nDisallow: /products.json\r\n", false],
    ["a byte order mark before the first line", "\ufeffUser-agent: *\nDisallow: /products.json", false],
    ["an encoded letter in the rule", "User-agent: *\nDisallow: /%70roducts.json", false],
    ["an encoded letter in other case", "User-agent: *\nDisallow: /%70RODUCTS.json", true],
    ["an encoded dot, which is a dot, and an encoded question mark, which isn't one", "User-agent: *\nDisallow: /products%2Ejson%3F", true],
    ["an encoded dot alone", "User-agent: *\nDisallow: /products%2Ejson", false],
    ["an encoded slash, which isn't a slash", "User-agent: *\nDisallow: %2Fproducts.json", true],
  ])("%s", (_name, text, allowed) => {
    expect(robotsRules(text)(FEED(1))).toBe(allowed);
  });

  it("can't be made to hang the server by a pattern written to blow up a regex", () => {
    const hostile = `User-agent: *\nDisallow: /${"*.".repeat(2000)}x${"*".repeat(2000)}y`;
    const started = Date.now();
    expect(robotsRules(hostile)(FEED(1))).toBe(true);
    expect(Date.now() - started).toBeLessThan(500);
  });

  it("reads a crawl delay for us, and not for another bot", () => {
    expect(robotsRules("User-agent: *\nCrawl-delay: 12").crawlDelayMs).toBe(12_000);
    expect(robotsRules("User-agent: other\nCrawl-delay: 12").crawlDelayMs).toBe(0);
    expect(robotsRules("User-agent: *\nCrawl-delay: soon").crawlDelayMs).toBe(0);
  });
});

describe("reading a store", () => {
  const titles = async (p: ReturnType<typeof readStoreListings>) => (await p).listings.map((l) => l.title);

  describe("what it won't connect to", () => {
    it.each([["127.0.0.1"], ["10.0.0.5"], ["169.254.169.254"], ["::1"], ["fd00::1"], ["::ffff:10.0.0.1"]])("a name that resolves to %s", async (address) => {
      const s = store({}, { resolve: () => [address] });
      expect(await refusal(readStoreListings("mystore.com", s.deps))).toBe("CANT_REACH");
      expect(s.calls).toEqual([]);
    });

    it("a name with one public and one private answer", async () => {
      const s = store({}, { resolve: () => [PUBLIC, "10.0.0.5"] });
      expect(await refusal(readStoreListings("mystore.com", s.deps))).toBe("CANT_REACH");
      expect(s.calls).toEqual([]);
    });

    it("a name with no answers, or one that fails to resolve", async () => {
      const none = store({}, { resolve: () => [] });
      expect(await refusal(readStoreListings("mystore.com", none.deps))).toBe("CANT_REACH");
      const failing = store(
        {},
        {
          resolve: () => {
            throw new Error("ENOTFOUND");
          },
        },
      );
      expect(await refusal(readStoreListings("mystore.com", failing.deps))).toBe("CANT_REACH");
      expect(failing.calls).toEqual([]);
    });
  });

  it("asks DNS once and uses that address for every request, so a name can't change its answer afterwards", async () => {
    const s = store({ [FEED(1)]: ok(pageOf(250)), [FEED(2)]: ok(pageOf(3, 250)) }, { resolve: (_h, call) => (call === 1 ? [PUBLIC] : ["127.0.0.1"]) });
    await readStoreListings("mystore.com", s.deps);
    expect(s.lookups).toEqual(["mystore.com"]);
    expect(s.calls.length).toBe(3);
    for (const c of s.calls) expect(c).toMatchObject({ host: "mystore.com", address: PUBLIC });
  });

  it("uses an IPv4 address when a name has both", async () => {
    const s = store({ [FEED(1)]: ok(pageOf(1)) }, { resolve: () => ["2606:4700::1111", PUBLIC] });
    await readStoreListings("mystore.com", s.deps);
    expect(s.calls[0].address).toBe(PUBLIC);
  });

  it("asks only for robots.txt and the feed, whatever path was typed", async () => {
    const s = store({ [FEED(1)]: ok(pageOf(250)), [FEED(2)]: ok(pageOf(1, 250)) });
    await readStoreListings("https://mystore.com/admin/secret?x=1", s.deps);
    expect(s.calls.map((c) => c.path)).toEqual(["/robots.txt", FEED(1), FEED(2)]);
  });

  describe("redirects", () => {
    it.each([
      ["another site", "https://elsewhere.example/products.json"],
      ["the metadata address", "http://169.254.169.254/latest/meta-data/"],
      ["itself over http", "http://mystore.com/products.json"],
      ["another path on the same host", "https://mystore.com/admin"],
      ["a relative path", "/en-ca/products.json"],
    ])("are not followed from the feed to %s", async (_name, location) => {
      const s = store({ [FEED(1)]: moved(location, 302) });
      expect(await refusal(readStoreListings("mystore.com", s.deps))).toBe("MOVED");
      expect(s.calls.map((c) => c.path)).toEqual(["/robots.txt", FEED(1)]);
    });

    it("are not followed from robots.txt to another site", async () => {
      const s = store({ "/robots.txt": moved("https://elsewhere.example/robots.txt") });
      expect(await refusal(readStoreListings("mystore.com", s.deps))).toBe("MOVED");
      expect(s.calls.map((c) => c.path)).toEqual(["/robots.txt"]);
    });

    it("start again at the www name, checked from the top like any typed address", async () => {
      const s = store({ "mystore.com/robots.txt": moved("https://www.mystore.com/robots.txt"), "www.mystore.com/robots.txt": missing, [`www.mystore.com${FEED(1)}`]: ok(pageOf(2)) });
      const read = await readStoreListings("mystore.com", s.deps);
      expect(read.host).toBe("www.mystore.com");
      expect(read.listings).toHaveLength(2);
      expect(s.lookups).toEqual(["mystore.com", "www.mystore.com"]);
    });

    it("refuse the www name if it resolves somewhere private", async () => {
      const s = store({ "mystore.com/robots.txt": moved("https://www.mystore.com/robots.txt") }, { resolve: (host) => (host === "www.mystore.com" ? ["127.0.0.1"] : [PUBLIC]) });
      expect(await refusal(readStoreListings("mystore.com", s.deps))).toBe("CANT_REACH");
      expect(s.calls.map((c) => c.host)).toEqual(["mystore.com"]);
    });

    it("drop www the same way, once and no more", async () => {
      const s = store({ "www.mystore.com/robots.txt": moved("https://mystore.com/robots.txt"), "mystore.com/robots.txt": moved("https://www.mystore.com/robots.txt") });
      expect(await refusal(readStoreListings("www.mystore.com", s.deps))).toBe("MOVED");
      expect(s.lookups).toEqual(["www.mystore.com", "mystore.com"]);
    });

    it("to www over plain http are refused", async () => {
      const s = store({ "mystore.com/robots.txt": moved("http://www.mystore.com/robots.txt") });
      expect(await refusal(readStoreListings("mystore.com", s.deps))).toBe("MOVED");
    });
  });

  describe("robots.txt", () => {
    it("reads nothing when it says no", async () => {
      const s = store({ "/robots.txt": ok("User-agent: *\nDisallow: /products.json"), [FEED(1)]: ok(pageOf(1)) });
      expect(await refusal(readStoreListings("mystore.com", s.deps))).toBe("ROBOTS");
      expect(s.calls.map((c) => c.path)).toEqual(["/robots.txt"]);
    });

    it("goes on when it's missing", async () => {
      const s = store({ "/robots.txt": missing, [FEED(1)]: ok(pageOf(1)) });
      expect((await readStoreListings("mystore.com", s.deps)).listings).toHaveLength(1);
    });

    it.each([500, 503, 403, 429])("stops when it answers %i", async (status) => {
      const s = store({ "/robots.txt": { status, location: null, body: "" }, [FEED(1)]: ok(pageOf(1)) });
      expect(await refusal(readStoreListings("mystore.com", s.deps))).toBe("NO_FEED");
      expect(s.calls.map((c) => c.path)).toEqual(["/robots.txt"]);
    });

    it("stops when it can't be read", async () => {
      const s = store({ "/robots.txt": new Error("timed out") });
      expect(await refusal(readStoreListings("mystore.com", s.deps))).toBe("CANT_REACH");
    });

    it("refuses when it asks for longer gaps than this visit can keep", async () => {
      const s = store({ "/robots.txt": ok("User-agent: *\nCrawl-delay: 120") });
      expect(await refusal(readStoreListings("mystore.com", s.deps))).toBe("ROBOTS");
    });
  });

  describe("pacing", () => {
    it("waits about 5 seconds before every request after the first", async () => {
      const s = store({ [FEED(1)]: ok(pageOf(250)), [FEED(2)]: ok(pageOf(1, 250)) });
      await readStoreListings("mystore.com", s.deps);
      expect(s.slept).toEqual([5000, 5000]);
    });

    it("waits longer when robots.txt asks", async () => {
      const s = store({ "/robots.txt": ok("User-agent: *\nCrawl-delay: 11"), [FEED(1)]: ok(pageOf(1)) });
      await readStoreListings("mystore.com", s.deps);
      expect(s.slept).toEqual([11_000]);
    });

    it("stops at a short page, without asking for another", async () => {
      const s = store({ [FEED(1)]: ok(pageOf(249)) });
      const read = await readStoreListings("mystore.com", s.deps);
      expect(s.calls.map((c) => c.path)).toEqual(["/robots.txt", FEED(1)]);
      expect(read.complete).toBe(true);
    });
  });

  describe("how far it reads", () => {
    const junk = { products: Array.from({ length: 250 }, () => ({ title: null })) };

    it("stops at the page limit when full pages hold nothing usable, however many a store has", async () => {
      const answers: Record<string, FeedAnswer> = {};
      for (let p = 1; p <= 40; p++) answers[FEED(p)] = ok(junk);
      const s = store(answers);
      expect(await refusal(readStoreListings("mystore.com", s.deps))).toBe("EMPTY_FEED");
      expect(s.calls.map((c) => c.path)).toEqual(["/robots.txt", FEED(1), FEED(2), FEED(3), FEED(4)]);
    });

    it("keeps what was usable, and says it stopped", async () => {
      const answers: Record<string, FeedAnswer> = { [FEED(1)]: ok({ products: [...junk.products.slice(0, 240), ...pageOf(10).products] }) };
      for (let p = 2; p <= 40; p++) answers[FEED(p)] = ok(junk);
      const read = await readStoreListings("mystore.com", store(answers).deps);
      expect(read.listings).toHaveLength(10);
      expect(read.complete).toBe(false);
    });
  });

  describe("one store at a time", () => {
    const quick = (gate: ReturnType<typeof createStoreGate>) => ({ ...store({ [FEED(1)]: ok(pageOf(1)) }).deps, enter: gate });

    it("won't read a store that's already being read", async () => {
      const gate = createStoreGate();
      let finish: (a: FeedAnswer) => void = () => {};
      const slow: StoreFeedDeps = { ...store({}).deps, enter: gate, get: () => new Promise((resolve) => (finish = resolve)) };
      const first = readStoreListings("mystore.com", slow);
      await new Promise((resolve) => setImmediate(resolve));
      expect(await refusal(readStoreListings("mystore.com", quick(gate)))).toBe("BUSY");
      expect((await readStoreListings("other-store.com", quick(gate))).listings).toHaveLength(1);
      finish({ status: 500, location: null, body: "" });
      expect(await refusal(first)).toBe("NO_FEED");
    });

    it("lets a store be read again after a read ends, however it ended", async () => {
      const gate = createStoreGate();
      const failing = { ...store({ "/robots.txt": new Error("reset") }).deps, enter: gate };
      expect(await refusal(readStoreListings("mystore.com", failing))).toBe("CANT_REACH");
      expect((await readStoreListings("mystore.com", quick(gate))).listings).toHaveLength(1);
    });

    it("won't read one store more than six times an hour, however many visitors ask", async () => {
      const gate = createStoreGate();
      for (let i = 0; i < 6; i++) await readStoreListings("popular-store.com", quick(gate));
      expect(await refusal(readStoreListings("popular-store.com", quick(gate)))).toBe("BUSY");
    });

    it("charges the www name too when a read moves there", async () => {
      const gate = createStoreGate();
      for (let i = 0; i < 6; i++) await readStoreListings("www.mystore.com", quick(gate));
      const s = store({ "mystore.com/robots.txt": moved("https://www.mystore.com/robots.txt") });
      expect(await refusal(readStoreListings("mystore.com", { ...s.deps, enter: gate }))).toBe("BUSY");
      expect(s.calls.map((c) => c.host)).toEqual(["mystore.com"]);
    });
  });

  describe("what isn't a feed", () => {
    it.each([
      ["a bot check served with a 200", ok("<html><title>Just a moment...</title></html>")],
      ["json of another shape", ok({ items: [] })],
      ["products that aren't a list", ok({ products: "none" })],
      ["a json string", ok('"hello"')],
      ["null", ok("null")],
      ["a 403", { status: 403, location: null, body: "denied" }],
      ["a 404", missing],
      ["a 500", { status: 500, location: null, body: "" }],
    ])("%s", async (_name, answer) => {
      const s = store({ [FEED(1)]: answer });
      expect(await refusal(readStoreListings("mystore.com", s.deps))).toBe("NO_FEED");
    });

    it("a first page over the byte limit", async () => {
      const s = store({ [FEED(1)]: new FeedTooBig() });
      expect(await refusal(readStoreListings("mystore.com", s.deps))).toBe("NO_FEED");
    });

    it("a first page that can't be reached", async () => {
      const s = store({ [FEED(1)]: new Error("ECONNRESET") });
      expect(await refusal(readStoreListings("mystore.com", s.deps))).toBe("CANT_REACH");
    });

    it("a feed with nothing in it", async () => {
      const s = store({ [FEED(1)]: ok({ products: [] }) });
      expect(await refusal(readStoreListings("mystore.com", s.deps))).toBe("EMPTY_FEED");
    });

    it("a feed with no usable title in it", async () => {
      const s = store({ [FEED(1)]: ok({ products: [{ title: 7 }, { title: "   " }, null, "text", { vendor: "x" }] }) });
      expect(await refusal(readStoreListings("mystore.com", s.deps))).toBe("EMPTY_FEED");
    });
  });

  describe("what it keeps", () => {
    it("a title and whether it's for sale. Never the vendor, which can hold a consignor's name", async () => {
      const s = store({ [FEED(1)]: ok({ products: [product("Stroller", [true]), product("Crib", [false]), product("Swing", [false, true])] }) });
      const read = await readStoreListings("mystore.com", s.deps);
      expect(read.listings).toEqual([
        { title: "Stroller", listed: true },
        { title: "Crib", listed: false },
        { title: "Swing", listed: true },
      ]);
      expect(JSON.stringify(read)).not.toContain("SENTINEL");
    });

    it("counts a listing with no sold-out field as for sale", async () => {
      const s = store({ [FEED(1)]: ok({ products: [{ title: "No variants" }, { title: "No state", variants: [{}] }, { title: "Odd state", variants: "x" }] }) });
      expect((await readStoreListings("mystore.com", s.deps)).listings.map((l) => l.listed)).toEqual([true, true, true]);
    });

    it("treats titles as untrusted: controls, zero-width and direction marks go, and length is capped", async () => {
      const raw = ["Crib\u0000 one", "Crib​‮ two", "  many   spaces\t\nhere  ", "x".repeat(500), "\ud800 lone", "<script>kept as text</script>"];
      const s = store({ [FEED(1)]: ok({ products: raw.map((t) => product(t)) }) });
      const got = await titles(readStoreListings("mystore.com", s.deps));
      expect(got.slice(0, 3)).toEqual(["Crib one", "Crib two", "many spaces here"]);
      expect(got[3]).toHaveLength(200);
      expect(got[4]).toBe("lone");
      expect(got[5]).toBe("<script>kept as text</script>");
    });

    it("reads no more than the file limit, and says it stopped", async () => {
      const answers: Record<string, FeedAnswer> = {};
      for (let p = 1; p <= 8; p++) answers[FEED(p)] = ok(pageOf(250, (p - 1) * 250));
      const s = store(answers);
      const read = await readStoreListings("mystore.com", s.deps);
      expect(read.listings).toHaveLength(MAX_LINES);
      expect(read.complete).toBe(false);
      expect(s.calls.map((c) => c.path)).toEqual(["/robots.txt", FEED(1), FEED(2), FEED(3), FEED(4)]);
    });

    it("cuts a page that ignored the page size at the same limit", async () => {
      const s = store({ [FEED(1)]: ok(pageOf(1500)) });
      const read = await readStoreListings("mystore.com", s.deps);
      expect(read.listings).toHaveLength(MAX_LINES);
      expect(read.complete).toBe(false);
      expect(s.calls.map((c) => c.path)).toEqual(["/robots.txt", FEED(1)]);
    });

    it.each([
      ["answers an error", { status: 429, location: null, body: "" } as FeedAnswer],
      ["redirects", moved("https://elsewhere.example/")],
      ["isn't json", ok("<html>")],
      ["goes over the byte limit", new FeedTooBig()],
      ["drops the connection", new Error("ECONNRESET")],
    ])("keeps what it read when a later page %s, says it stopped, and asks for nothing else", async (_name, answer) => {
      const s = store({ [FEED(1)]: ok(pageOf(250)), [FEED(2)]: answer });
      const read = await readStoreListings("mystore.com", s.deps);
      expect(read.listings).toHaveLength(250);
      expect(read.complete).toBe(false);
      expect(s.calls.map((c) => c.path)).toEqual(["/robots.txt", FEED(1), FEED(2)]);
    });
  });
});

// A real TLS server on this machine, with a certificate made here for a name that doesn't exist, so this proves what
// a real connection does: it goes to the address it was given, and the certificate still has to fit the store's name.
describe("the connection itself", () => {
  const dir = mkdtempSync(join(tmpdir(), "store-feed-"));
  const HOST = "store.example";
  let server: Server;
  let port: number;
  let cert: string;
  let seen: { host?: string; url?: string; sni?: string | false | null; agent?: string; encoding?: string }[] = [];

  beforeAll(async () => {
    execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", join(dir, "k.pem"), "-out", join(dir, "c.pem"), "-days", "2", "-subj", `/CN=${HOST}`, "-addext", `subjectAltName=DNS:${HOST}`], { stdio: "ignore" });
    cert = readFileSync(join(dir, "c.pem"), "utf8");
    server = createServer({ key: readFileSync(join(dir, "k.pem"), "utf8"), cert }, (req, res) => {
      seen.push({ host: req.headers.host, url: req.url, sni: (req.socket as TLSSocket).servername, agent: req.headers["user-agent"], encoding: req.headers["accept-encoding"] });
      if (req.url === "/redirect") {
        res.writeHead(302, { location: "https://elsewhere.example/" }).end();
      } else if (req.url === "/declared-big") {
        res.writeHead(200, { "content-length": "999999" });
        res.write("x");
      } else if (req.url === "/endless") {
        res.writeHead(200);
        const timer = setInterval(() => res.write("x".repeat(4096)), 1);
        res.on("close", () => clearInterval(timer));
      } else if (req.url === "/slow") {
        res.writeHead(200);
        res.write("x");
      } else {
        res.writeHead(200, { "content-type": "application/json" }).end('{"products":[]}');
      }
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    port = (server.address() as AddressInfo).port;
  });
  beforeEach(() => {
    seen = [];
  });
  afterAll(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    rmSync(dir, { recursive: true, force: true });
  });

  const get = (path: string, over: Partial<Parameters<typeof pinnedGet>[0]> = {}) => pinnedGet({ host: HOST, address: "127.0.0.1", path, port, ca: cert, ...over });

  it("connects to the address it was given, asks no DNS, and names the store in Host and TLS", async () => {
    const answer = await get("/products.json?limit=250&page=1");
    expect(answer).toEqual({ status: 200, location: null, body: '{"products":[]}' });
    expect(seen).toEqual([{ host: HOST, url: "/products.json?limit=250&page=1", sni: HOST, agent: FEED_USER_AGENT, encoding: "identity" }]);
  });

  it("says who it is, honestly", () => {
    expect(FEED_USER_AGENT).toMatch(/^RecallReachBot\/\d/);
    expect(FEED_USER_AGENT).toContain("https://");
  });

  it("refuses a certificate for another name, before sending anything", async () => {
    await expect(get("/anything", { host: "other.example" })).rejects.toThrow(/other\.example|altnames|certificate/i);
    expect(seen).toEqual([]);
  });

  it("refuses a certificate nobody vouches for", async () => {
    await expect(get("/anything", { ca: undefined })).rejects.toThrow();
    expect(seen).toEqual([]);
  });

  it("hands back a redirect and doesn't follow it", async () => {
    await expect(get("/redirect")).resolves.toEqual({ status: 302, location: "https://elsewhere.example/", body: "" });
    expect(seen).toHaveLength(1);
  });

  it("stops at the byte limit on a body with no end", async () => {
    await expect(get("/endless", { maxBytes: 100_000 })).rejects.toBeInstanceOf(FeedTooBig);
  });

  it("stops before reading a body declared over the limit", async () => {
    await expect(get("/declared-big", { maxBytes: 1000 })).rejects.toBeInstanceOf(FeedTooBig);
  });

  it("gives up on a body that never finishes", async () => {
    await expect(get("/slow", { timeoutMs: 200 })).rejects.toThrow();
  });
});
