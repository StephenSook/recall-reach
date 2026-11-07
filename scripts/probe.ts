// A daily look at the deployed site through the judging window, run by .github/workflows/probe.yml. It reads what each page
// says, because a challenge page or a broken render can answer 200. Starting a demo shop is the deepest step: it reaches
// PayPal's sandbox, CPSC's stored records, the database and the matcher, and refunds nothing. The shop purges itself.
// No secrets, and it imports nothing, so it runs with no install.

export const RETIRES_AFTER = "2026-12-22";
const SITE = "https://recall-reach-web-e022.onrender.com";
const TIMEOUT_MS = 120_000;
const LOOK_AGAIN_MS = 120_000;
const RECALLS_FROM_2025 = 934;
const RECALLS_CHECKED = 1855;
const REPLAY_RECOUNT = /href="(\/api\/proof\/[0-9a-f-]{36})"/;
const CHECK_PATH = "/api/check?title=Baby%20Brezza%20sterilizer&model=BRZ0083";

export interface Check {
  name: string;
  ok: boolean;
  detail: string;
}

/** The words a person sees: no scripts or styles, no tags, entities undone. */
function visible(html: string): string {
  return html
    .replace(/<(script|style)\b[\s\S]*?<\/\1>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&#x27;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ");
}

const pass = (name: string, detail = "ok"): Check => ({ name, ok: true, detail });
const fail = (name: string, detail: string): Check => ({ name, ok: false, detail });

export async function probe(base: string, fetchImpl: typeof fetch = fetch): Promise<Check[]> {
  const read = async (path: string, init?: RequestInit) => {
    const res = await fetchImpl(`${base}${path}`, { signal: AbortSignal.timeout(TIMEOUT_MS), ...init });
    return { status: res.status, body: await res.text(), headers: res.headers };
  };
  /** One check. Anything thrown, a dead host included, is that check failing. */
  const attempt = async (name: string, check: () => Promise<Check>): Promise<Check> => {
    try {
      return await check();
    } catch (err) {
      return fail(name, `no answer: ${err instanceof Error ? err.name : "unknown error"}`);
    }
  };
  const pageSays = (name: string, path: string, words: string[]) =>
    attempt(name, async () => {
      const { status, body } = await read(path);
      const text = visible(body);
      const missing = words.filter((w) => !text.includes(w));
      return missing.length === 0 ? pass(name) : fail(name, `${path} answered ${status} without: ${missing.join("; ")}`);
    });

  const checks: Check[] = [];
  let cpscSince: string | null = null;
  let claude: { fresh?: boolean; lastOkAt?: string | null } | undefined;
  checks.push(
    await attempt("health", async () => {
      const { status, body } = await read("/api/health");
      const health = JSON.parse(body) as { ok?: boolean; checks?: Record<string, boolean>; market?: { fresh?: boolean }; degraded?: { source?: string; since?: string | null } | null; claude?: { fresh?: boolean; lastOkAt?: string | null } };
      claude = health.claude;
      const named = Object.entries(health.checks ?? {});
      const off = named.filter(([, on]) => on !== true).map(([name]) => name);
      // Only CPSC's own failing, reported on its own line below so nobody chases this site's code. Anything of ours still fails here.
      if (health.degraded?.source === "CPSC" && named.length > 0 && off.every((name) => name === "lastPull" || name === "poll")) {
        cpscSince = health.degraded.since ?? "an unknown time";
        return pass("health", "only CPSC is failing; this site's own checks pass");
      }
      if (health.ok !== true || named.length === 0 || off.length > 0) return fail("health", `answered ${status}, ok ${String(health.ok)}, off: ${off.join(", ") || "none"}`);
      return pass("health", `${named.length} checks true${health.market?.fresh ? "" : "; the market search is stale, which isn't part of ok"}`);
    }),
  );
  checks.push(claude?.fresh === true ? pass("Claude", `last good answer ${claude.lastOkAt}`) : fail("Claude", `no good answer in 2 days: last ${claude?.lastOkAt ?? "none on record"}. Its balance may be spent.`));
  if (cpscSince !== null) checks.push(fail("CPSC is failing", `since ${cpscSince}. Not this site's code: it works from the recalls it holds.`));
  let replayHtml = "";
  checks.push(
    await attempt("replay numbers", async () => {
      const { status, body } = await read("/replay");
      replayHtml = body;
      const text = visible(body);
      const checked = Number(/([\d,]+) Recalls checked/.exec(text)?.[1]?.replaceAll(",", "") ?? 0);
      const matched = Number(/(\d+) Recalls matched/.exec(text)?.[1] ?? 0);
      // Floors: CPSC keeps publishing, so these only grow.
      return checked >= RECALLS_FROM_2025 && matched >= 1 ? pass("replay numbers", `${checked} checked, ${matched} matched`) : fail("replay numbers", `answered ${status}, read ${checked} checked, ${matched} matched`);
    }),
  );
  checks.push(
    await attempt("replay recount", async () => {
      const link = REPLAY_RECOUNT.exec(replayHtml)?.[1];
      if (!link) return fail("replay recount", "/replay has no recount link");
      const { body } = await read(link);
      return (JSON.parse(body) as { agree?: boolean }).agree === true ? pass("replay recount") : fail("replay recount", "the recount disagrees with the stored run");
    }),
  );
  // The committed eval, so these are exact: the repo is frozen.
  checks.push(await pageSays("eval numbers", "/eval", ["37 of 83", "2 of 83", "11 of 12", "52 of 60", "One labeller"]));
  checks.push(
    await attempt("public check", async () => {
      const { status, body } = await read(CHECK_PATH);
      const answer = JSON.parse(body) as { results?: { recallNumber?: string; verdict?: string }[]; checked?: { recalls?: number } };
      const found = answer.results?.find((r) => r.recallNumber === "27072");
      return found?.verdict === "MATCH" && (answer.checked?.recalls ?? 0) >= RECALLS_CHECKED ? pass("public check", "27072 for BRZ0083") : fail("public check", `answered ${status}, 27072 read ${found?.verdict ?? "missing"}`);
    }),
  );
  checks.push(
    await attempt("mcp", async () => {
      const { status, body } = await read("/api/mcp", {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "check_recall", arguments: { title: "Baby Brezza sterilizer", model: "BRZ0083" } } }),
      });
      return body.includes("27072") && body.includes("MATCH") && !body.includes('"isError":true') ? pass("mcp", "27072 for BRZ0083") : fail("mcp", `answered ${status} without 27072`);
    }),
  );
  checks.push(await pageSays("home", "/", ["Try it as a demo shop"]));
  checks.push(await pageSays("judge", "/judge", ["Three minutes", "Try it as a demo shop"]));
  checks.push(await pageSays("check page", "/check", ["Check my file"]));
  checks.push(await pageSays("safety", "/safety", ["5 of 5 refused"]));
  checks.push(await pageSays("paypal evidence", "/evidence/paypal", ["PayPal"]));
  checks.push(await pageSays("ag grid evidence", "/evidence/ag-grid", ["AG Grid"]));
  checks.push(await pageSays("privacy", "/privacy", ["What this app keeps"]));
  checks.push(await pageSays("status", "/status", ["Postgres", "Answered when this page loaded", "This page never calls Claude"]));
  checks.push(
    await attempt("demo start", async () => {
      const started = await read("/api/demo/start", { method: "POST", redirect: "manual", headers: { origin: base } });
      const location = started.headers.get("location") ?? "";
      const cookie = started.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
      if (started.status !== 303 || !location.endsWith("/queue") || !cookie) return fail("demo start", `answered ${started.status}, sent to ${location || "nowhere"}`);
      const queue = visible((await read("/queue", { headers: { cookie } })).body);
      const items = Number(/(\d+) items? wait/.exec(queue)?.[1] ?? 0);
      return queue.includes("DEMO SHOP") && queue.includes("27072") && items >= 1 ? pass("demo start", `${items} items wait`) : fail("demo start", `the queue read ${items} items`);
    }),
  );
  return checks;
}

export async function runProbe(opts: { base: string; now: Date; fetchImpl?: typeof fetch; log?: (line: string) => void; wait?: (ms: number) => Promise<void> }): Promise<number> {
  const log = opts.log ?? console.log;
  const wait = opts.wait ?? ((ms: number) => new Promise<void>((done) => setTimeout(done, ms)));
  if (opts.now.toISOString().slice(0, 10) > RETIRES_AFTER) {
    log(`retired: judging ended and the site only had to stay up through ${RETIRES_AFTER}`);
    return 0;
  }
  let checks = await probe(opts.base, opts.fetchImpl);
  if (checks.some((c) => !c.ok)) {
    log(`failed on the first look: ${checks.filter((c) => !c.ok).map((c) => c.name).join(", ")}. Looking again.`);
    await wait(LOOK_AGAIN_MS);
    checks = await probe(opts.base, opts.fetchImpl);
  }
  for (const c of checks) log(`${c.ok ? "ok  " : "FAIL"} ${c.name}: ${c.detail}`);
  return checks.every((c) => c.ok) ? 0 : 1;
}

if (process.argv[1]?.endsWith("probe.ts")) {
  void runProbe({ base: (process.env.BASE_URL || SITE).replace(/\/$/, ""), now: new Date() }).then((code) => {
    process.exitCode = code;
  });
}
