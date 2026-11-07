import { describe, expect, it, vi } from "vitest";
import { probe, RETIRES_AFTER, runProbe } from "./probe";

const BASE = "https://site.test";

/** The real site's words, trimmed to what the probe reads. */
const GOOD: Record<string, string> = {
  "/api/health": JSON.stringify({ claude: { fresh: true, lastOkAt: "2026-11-07T00:00:00.000Z" }, ok: true, checks: { database: true, webhook: true, lastPull: true, purge: true, poll: true, replay: true, logging: true }, market: { fresh: true } }),
  "/replay": `<main><p>934 Recalls checked</p><p>3 Recalls matched</p><a href="/api/proof/1f597fa0-6d9b-4a42-8ea2-923a79d466f6">Recount these numbers</a></main>`,
  "/api/proof/1f597fa0-6d9b-4a42-8ea2-923a79d466f6": JSON.stringify({ agree: true }),
  "/eval": "<main>37 of 83 2 of 83 11 of 12 52 of 60 One labeller</main>",
  "/api/check?title=Baby%20Brezza%20sterilizer&model=BRZ0083": JSON.stringify({ results: [{ recallNumber: "27072", verdict: "MATCH", strength: "CONFIRMED" }], checked: { recalls: 1855 } }),
  "/api/mcp": `event: message\ndata: {"result":{"content":[{"type":"text","text":"27072 MATCH"}]}}`,
  "/": "<main>Try it as a demo shop</main>",
  "/judge": "<main>Three minutes, no login. Try it as a demo shop</main>",
  "/check": "<main>Check my file</main>",
  "/safety": "<main>5 of 5 refused</main>",
  "/evidence/paypal": "<main>PayPal</main>",
  "/evidence/ag-grid": "<main>AG Grid</main>",
  "/privacy": "<main>What this app keeps</main>",
  "/status": "<main>Postgres: OK. Answered when this page loaded. This page never calls Claude.</main>",
  "/queue": "<main>DEMO SHOP 9 items wait for you 27072</main>",
};

function site(over: Record<string, string | { status: number; body?: string; location?: string } | Error> = {}) {
  const calls: { url: string; init?: RequestInit }[] = [];
  const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
    const path = String(url).replace(BASE, "");
    calls.push({ url: path, init });
    const answer = path in over ? over[path] : path === "/api/demo/start" ? { status: 303, location: `${BASE}/queue` } : GOOD[path];
    if (answer instanceof Error) throw answer;
    if (answer === undefined) return new Response("not found", { status: 404 });
    if (typeof answer === "string") return new Response(answer, { status: 200 });
    const headers = new Headers(answer.location ? { location: answer.location, "set-cookie": "session=abc; Path=/; HttpOnly" } : {});
    return new Response(answer.status === 303 ? null : (answer.body ?? ""), { status: answer.status, headers });
  }) as typeof fetch;
  return { fetchImpl, calls };
}
const failed = async (over: Parameters<typeof site>[0]) => (await probe(BASE, site(over).fetchImpl)).filter((c) => !c.ok).map((c) => c.name);

describe("probe", () => {
  it("passes on the real site's words", async () => {
    const checks = await probe(BASE, site().fetchImpl);
    expect(checks.filter((c) => !c.ok)).toEqual([]);
    expect(checks.length).toBeGreaterThanOrEqual(12);
  });

  it("reads content, not status: a 200 challenge page fails every page it replaces", async () => {
    const page = "<html><body>Please wait while we check your browser</body></html>";
    expect(await failed({ "/replay": page })).toContain("replay numbers");
    expect(await failed({ "/eval": page })).toContain("eval numbers");
    expect(await failed({ "/": page })).toContain("home");
    expect(await failed({ "/judge": page })).toContain("judge");
    expect(await failed({ "/api/health": page })).toContain("health");
  });

  it("doesn't count words that are only in a script", async () => {
    expect(await failed({ "/eval": "<main>nothing</main><script>37 of 83 2 of 83 11 of 12 52 of 60 One labeller</script>" })).toContain("eval numbers");
  });

  it("fails when health says not ok, or any one check is false, or no checks came back", async () => {
    const health = (body: object) => JSON.stringify(body);
    expect(await failed({ "/api/health": health({ ok: false, checks: { database: true } }) })).toContain("health");
    expect(await failed({ "/api/health": health({ ok: true, checks: { database: true, purge: false } }) })).toContain("health");
    expect(await failed({ "/api/health": health({ ok: true, checks: {} }) })).toContain("health");
  });

  describe("Claude's last good answer", () => {
    const withClaude = (claude: object | undefined) => JSON.stringify({ ...JSON.parse(GOOD["/api/health"]), claude });

    it("fails when it's over 2 days old, and says when it last worked", async () => {
      const checks = await probe(BASE, site({ "/api/health": withClaude({ fresh: false, lastOkAt: "2026-11-01T00:00:00.000Z" }) }).fetchImpl);
      expect(checks.filter((c) => !c.ok).map((c) => c.name)).toEqual(["Claude"]);
      expect(checks.find((c) => c.name === "Claude")?.detail).toContain("2026-11-01");
    });

    it("fails when health stops saying, rather than taking silence for good news", async () => {
      expect(await failed({ "/api/health": withClaude(undefined) })).toContain("Claude");
    });

    it("passes when it's fresh", async () => {
      const checks = await probe(BASE, site().fetchImpl);
      expect(checks.find((c) => c.name === "Claude")?.ok).toBe(true);
    });
  });

  describe("when only CPSC is failing", () => {
    const degraded = JSON.stringify({
      ...JSON.parse(GOOD["/api/health"]),
      ok: false,
      checks: { ...JSON.parse(GOOD["/api/health"]).checks, lastPull: false },
      degraded: { source: "CPSC", since: "2026-11-07T00:05:00.000Z", lastGoodAt: "2026-11-06T23:43:00.000Z" },
    });

    it("fails on a check named for CPSC, not on this site's health", async () => {
      const checks = await probe(BASE, site({ "/api/health": degraded }).fetchImpl);
      expect(checks.filter((c) => !c.ok).map((c) => c.name)).toEqual(["CPSC is failing"]);
      expect(checks.find((c) => c.name === "CPSC is failing")?.detail).toContain("2026-11-07T00:05:00.000Z");
      expect(checks.find((c) => c.name === "health")?.detail).toContain("only CPSC");
    });

    it("still fails on health if something of ours is off as well, whatever the page claims", async () => {
      const body = JSON.stringify({ ...JSON.parse(degraded), checks: { ...JSON.parse(degraded).checks, purge: false } });
      expect(await failed({ "/api/health": body })).toContain("health");
    });

    it("has no such line when CPSC is answering", async () => {
      const checks = await probe(BASE, site().fetchImpl);
      expect(checks.map((c) => c.name)).not.toContain("CPSC is failing");
    });
  });

  it("doesn't fail on the market search going quiet, which isn't part of ok, and says so", async () => {
    const body = JSON.stringify({ ...JSON.parse(GOOD["/api/health"]), market: { fresh: false } });
    const checks = await probe(BASE, site({ "/api/health": body }).fetchImpl);
    expect(checks.filter((c) => !c.ok)).toEqual([]);
    expect(checks.find((c) => c.name === "health")?.detail).toContain("market search is stale");
  });

  it("fails when Replay's run shrinks or its recount disagrees", async () => {
    expect(await failed({ "/replay": GOOD["/replay"].replace("934", "12") })).toContain("replay numbers");
    expect(await failed({ "/replay": GOOD["/replay"].replace("3 Recalls", "0 Recalls") })).toContain("replay numbers");
    expect(await failed({ "/api/proof/1f597fa0-6d9b-4a42-8ea2-923a79d466f6": JSON.stringify({ agree: false }) })).toContain("replay recount");
    expect(await failed({ "/replay": "<main>934 Recalls checked 3 Recalls matched</main>" })).toContain("replay recount");
  });

  it("fails when the public check stops finding 27072 for BRZ0083", async () => {
    const path = "/api/check?title=Baby%20Brezza%20sterilizer&model=BRZ0083";
    expect(await failed({ [path]: JSON.stringify({ results: [], checked: { recalls: 1855 } }) })).toContain("public check");
    expect(await failed({ [path]: JSON.stringify({ results: [{ recallNumber: "27072", verdict: "SCOPE_GAP" }], checked: { recalls: 1855 } }) })).toContain("public check");
    expect(await failed({ "/api/mcp": `data: {"result":{"isError":true,"content":[]}}` })).toContain("mcp");
  });

  it("fails when a demo shop can't start, which is the path that reaches PayPal", async () => {
    expect(await failed({ "/api/demo/start": { status: 303, location: `${BASE}/?demo=failed` } })).toContain("demo start");
    expect(await failed({ "/queue": "<main>DEMO SHOP</main>" })).toContain("demo start");
  });

  it("starts the demo from this site, and reads the queue with its session", async () => {
    const { fetchImpl, calls } = site();
    await probe(BASE, fetchImpl);
    const start = calls.find((c) => c.url === "/api/demo/start");
    expect(start?.init).toMatchObject({ method: "POST", redirect: "manual" });
    expect(new Headers(start?.init?.headers).get("origin")).toBe(BASE);
    expect(new Headers(calls.find((c) => c.url === "/queue")?.init?.headers).get("cookie")).toBe("session=abc");
  });

  it("reports a host that won't answer as a failure, and doesn't throw", async () => {
    const checks = await probe(BASE, (async () => Promise.reject(new Error("connection refused"))) as typeof fetch);
    expect(checks.length).toBeGreaterThanOrEqual(12);
    expect(checks.every((c) => !c.ok)).toBe(true);
  });
});

describe("runProbe", () => {
  const quiet = { log: vi.fn(), wait: async () => {} };
  const inTheWindow = new Date("2026-12-01T13:37:00Z");

  it("exits 0 on a good site and 1 on a bad one", async () => {
    expect(await runProbe({ ...quiet, base: BASE, fetchImpl: site().fetchImpl, now: inTheWindow })).toBe(0);
    expect(await runProbe({ ...quiet, base: BASE, fetchImpl: site({ "/eval": "nope" }).fetchImpl, now: inTheWindow })).toBe(1);
  });

  it("looks again before calling a blip a failure", async () => {
    let tries = 0;
    const good = site().fetchImpl;
    const flaky = (async (url: string | URL, init?: RequestInit) => {
      if (String(url).endsWith("/eval") && tries++ === 0) return new Response("Bad gateway", { status: 502 });
      return good(url, init);
    }) as typeof fetch;
    const wait = vi.fn(async () => {});
    expect(await runProbe({ log: vi.fn(), wait, base: BASE, fetchImpl: flaky, now: inTheWindow })).toBe(0);
    expect(wait).toHaveBeenCalledTimes(1);
  });

  it("still runs on its last day, and retires itself the day after, without calling anything", async () => {
    const { fetchImpl, calls } = site({ "/eval": "nope" });
    expect(await runProbe({ ...quiet, base: BASE, fetchImpl, now: new Date(`${RETIRES_AFTER}T23:00:00Z`) })).toBe(1);
    calls.length = 0;
    expect(await runProbe({ ...quiet, base: BASE, fetchImpl, now: new Date("2026-12-23T00:00:00Z") })).toBe(0);
    expect(calls).toEqual([]);
  });
});
