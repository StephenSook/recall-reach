import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { createNewmanReader, integrationsFrom, integrationFacts, type IntegrationFacts } from "./integrations";

const NOW = new Date("2026-11-09T20:00:00.000Z");
const RECENT = "2026-11-09T19:00:00.000Z";
const OLD = "2026-10-01T00:00:00.000Z";

const healthy: IntegrationFacts = {
  databaseOk: true,
  checkedAt: NOW.toISOString(),
  cpsc: { fresh: true, recalls: 1855, lastPullAt: RECENT },
  claude: { mainFresh: true, mainAt: RECENT, anyFresh: true, anyAt: RECENT },
  paypal: { webhookConfigured: true, lastVerifiedWebhookAt: RECENT },
  channel3: { fresh: true, lastOkAt: RECENT, searched: 54, listings: 300 },
  replay: { lastRunAt: RECENT, task: { outcome: "FRESH", finishedAt: RECENT } },
  agGridLicence: true,
  agStudio: { licence: true, rows: 900 },
  newman: { conclusion: "success", at: RECENT },
};

const row = (facts: IntegrationFacts, id: string) => {
  const found = integrationsFrom(facts, NOW).rows.find((r) => r.id === id);
  if (!found) throw new Error(`no row ${id}`);
  return found;
};

describe("the integrations list", () => {
  it("is live for each thing whose own check passed, and client for what only runs in the browser", () => {
    const { rows, summary } = integrationsFrom(healthy, NOW);
    expect(rows.filter((r) => r.mode !== "live").map((r) => [r.id, r.mode])).toEqual([["ag-grid", "client"], ["ag-studio", "client"], ["bryntum", "client"]]);
    expect(summary).toEqual({ live: rows.length - 3, fallback: 0, off: 0, client: 3, of: rows.length });
  });

  it("gives a time for every live row", () => {
    for (const r of integrationsFrom(healthy, NOW).rows.filter((x) => x.mode === "live")) expect(Date.parse(r.checkedAt ?? "")).not.toBeNaN();
  });

  it("gives every row an id, a name and a line of plain detail", () => {
    for (const r of integrationsFrom(healthy, NOW).rows) {
      expect(r.id).toMatch(/^[a-z0-9-]+$/);
      expect(r.name.length).toBeGreaterThan(2);
      expect(r.detail.length).toBeGreaterThan(5);
    }
  });

  it("names Bryntum's installed version and doesn't call it live, because the server can't see the browser", () => {
    expect(row(healthy, "bryntum")).toMatchObject({ mode: "client", checkedAt: null, detail: expect.stringMatching(/\d+\.\d+\.\d+/) });
  });

  const broken: [string, string, Partial<IntegrationFacts>, string][] = [
    ["neon", "the database didn't answer", { databaseOk: false }, "off"],
    ["cpsc", "the last read is old or failed", { cpsc: { fresh: false, recalls: 1855, lastPullAt: OLD } }, "off"],
    ["claude", "no model has answered lately", { claude: { mainFresh: false, mainAt: OLD, anyFresh: false, anyAt: OLD } }, "off"],
    ["claude", "only the fallback model answered", { claude: { mainFresh: false, mainAt: OLD, anyFresh: true, anyAt: RECENT } }, "fallback"],
    ["paypal", "no webhook has been verified", { paypal: { webhookConfigured: true, lastVerifiedWebhookAt: null } }, "off"],
    ["paypal", "the last verified webhook is old", { paypal: { webhookConfigured: true, lastVerifiedWebhookAt: OLD } }, "off"],
    ["paypal", "webhooks aren't set up", { paypal: { webhookConfigured: false, lastVerifiedWebhookAt: RECENT } }, "off"],
    ["channel3", "the market search has gone quiet", { channel3: { fresh: false, lastOkAt: OLD, searched: 54, listings: 300 } }, "off"],
    ["render-workflows", "the task failed but the web service refreshed", { replay: { lastRunAt: RECENT, task: { outcome: "FAILED", finishedAt: RECENT } } }, "fallback"],
    ["render-workflows", "the task is old but the web service refreshed", { replay: { lastRunAt: RECENT, task: { outcome: "FRESH", finishedAt: OLD } } }, "fallback"],
    ["render-workflows", "the task has never run but the web service refreshed", { replay: { lastRunAt: RECENT, task: null } }, "fallback"],
    ["render-workflows", "the task never finished", { replay: { lastRunAt: OLD, task: { outcome: null, finishedAt: null } } }, "off"],
    ["ag-studio", "its data didn't answer", { agStudio: { licence: true, rows: null } }, "off"],
    ["ag-studio", "its data is empty", { agStudio: { licence: true, rows: 0 } }, "off"],
    ["ag-studio", "Recall Replay has no run yet", { agStudio: { licence: true, rows: "no-run" } }, "off"],
    ["newman", "the last run failed", { newman: { conclusion: "failure", at: RECENT } }, "off"],
    ["newman", "GitHub didn't say", { newman: null }, "off"],
    ["newman", "the last run is old", { newman: { conclusion: "success", at: OLD } }, "off"],
  ];

  it.each(broken)("%s isn't live when %s", (id, _why, change, mode) => {
    expect(row({ ...healthy, ...change }, id).mode).toBe(mode);
  });

  it("counts what isn't live", () => {
    const { summary } = integrationsFrom({ ...healthy, agStudio: { licence: true, rows: null }, claude: { mainFresh: false, mainAt: OLD, anyFresh: true, anyAt: RECENT } }, NOW);
    expect(summary).toMatchObject({ fallback: 1, off: 1, client: 2 });
  });

  it.each(["ag-grid", "ag-studio"])("doesn't call %s live on a licence key, because a key being set doesn't show the browser used it", (id) => {
    expect(row(healthy, id)).toMatchObject({ mode: "client", checkedAt: null });
    expect(row({ ...healthy, agGridLicence: false, agStudio: { licence: false, rows: 900 } }, id)).toMatchObject({ mode: "client", detail: expect.stringContaining("No licence key") });
  });

  it.each([
    [null, "Its data didn't answer."],
    ["no-run", "Recall Replay has no run yet, so it has no data."],
    [0, "Recall Replay's latest run has no rows."],
  ] as const)("says what AG Studio's data did when it was %s", (rows, words) => {
    expect(row({ ...healthy, agStudio: { licence: true, rows } }, "ag-studio").detail).toBe(words);
  });

  it("says only what it knows when the scheduled refresh failed but a recent run exists", () => {
    const detail = row({ ...healthy, replay: { lastRunAt: RECENT, task: { outcome: "FAILED", finishedAt: RECENT } } }, "render-workflows").detail;
    expect(detail).toBe("The scheduled refresh didn't finish cleanly lately. A Replay run from the last 2 days exists.");
  });

  it("doesn't guess why GitHub showed no scheduled run", () => {
    expect(row({ ...healthy, newman: null }, "newman").detail).toBe("GitHub showed no scheduled run. The repository may be private, or GitHub didn't answer.");
  });

  it("says when AG Studio's data answered", () => {
    expect(row(healthy, "ag-studio").detail).toContain("900 rows");
  });

  it("can only say live through the one helper that needs a passed check and a time", () => {
    const source = readFileSync("server/integrations.ts", "utf8").replace(/^\s*(\/\/|\*|\/\*).*$/gm, "");
    expect(source.match(/\? "live" :/g)).toHaveLength(1);
    expect(source).not.toMatch(/mode:\s*"live"/);
  });
});

describe("gathering the facts", () => {
  const health = {
    database: { ok: true },
    checkedAt: NOW.toISOString(),
    checks: { lastPull: true },
    cpsc: { recalls: 1855, lastPull: { finishedAt: RECENT } },
    claude: { mainModelFresh: true, mainModelOkAt: RECENT, fresh: true, lastOkAt: RECENT },
    paypal: { webhookConfigured: true, lastVerifiedWebhookAt: RECENT },
    market: { fresh: true, lastOkAt: RECENT },
    replay: { lastRunAt: RECENT, lastTaskRun: { outcome: "FRESH", finishedAt: RECENT } },
  } as never;
  const env = { AG_GRID_LICENSE_KEY: "PLANTED-GRID-KEY", AG_STUDIO_LICENSE_KEY: "PLANTED-STUDIO-KEY" };
  const deps = { sweepCounts: async () => ({ searched: 54, listings: 300 }), studioRows: async () => 900, newman: async () => ({ conclusion: "success", at: RECENT }) };

  it("shows whether a licence is set and never the licence", async () => {
    const facts = await integrationFacts({} as never, health, env, deps);
    expect(facts).toMatchObject({ agGridLicence: true, agStudio: { licence: true, rows: 900 } });
    expect(JSON.stringify(integrationsFrom(facts, NOW))).not.toContain("PLANTED");
  });

  it("treats a blank licence as none", async () => {
    expect((await integrationFacts({} as never, health, { AG_GRID_LICENSE_KEY: "  " }, deps)).agGridLicence).toBe(false);
  });

  it("marks one failed check down and leaves the others", async () => {
    const facts = await integrationFacts({} as never, health, env, { ...deps, studioRows: async () => { throw new Error("db"); }, sweepCounts: async () => { throw new Error("db"); } });
    expect(facts.agStudio.rows).toBeNull();
    expect(facts.channel3).toMatchObject({ fresh: false });
    expect(facts.newman).toMatchObject({ conclusion: "success" });
  });
});

describe("reading Newman's last run", () => {
  const STEPS = ["Run the public collection", "Check the counts"];
  const ranSteps = { jobs: [{ steps: STEPS.map((name) => ({ name, conclusion: "success" })) }] };
  const answered = (run: object | null, status = 200, jobs: object = ranSteps) =>
    vi.fn<typeof fetch>(async (url) => (String(url).includes("/jobs") ? Response.json(jobs) : Response.json({ workflow_runs: run ? [run] : [] }, { status })));

  it("names the workflow's own steps", () => {
    const workflow = readFileSync(".github/workflows/newman.yml", "utf8");
    for (const step of STEPS) expect(workflow).toContain(`name: ${step}`);
  });

  it("doesn't take a passed workflow as a passed check when its steps were skipped, as after it retires", async () => {
    const skipped = { jobs: [{ steps: STEPS.map((name) => ({ name, conclusion: "skipped" })) }] };
    expect(await createNewmanReader(answered({ id: 7, event: "schedule", head_branch: "main", conclusion: "success", updated_at: RECENT }, 200, skipped))(NOW)).toEqual({ conclusion: "skipped", at: RECENT });
  });

  it("asks only for scheduled runs on main, whose target is this site", async () => {
    const fetchImpl = answered({ id: 7, event: "schedule", head_branch: "main", conclusion: "success", updated_at: RECENT });
    await createNewmanReader(fetchImpl)(NOW);
    expect(String(fetchImpl.mock.calls[0][0])).toMatch(/[?&]event=schedule(&|$)/);
    expect(String(fetchImpl.mock.calls[0][0])).toMatch(/[?&]branch=main(&|$)/);
  });

  it.each([
    ["a manual run, which can point at another site", { event: "workflow_dispatch", head_branch: "main" }],
    ["a run on another branch", { event: "schedule", head_branch: "other" }],
  ])("ignores %s if GitHub hands one back", async (_name, run) => {
    expect(await createNewmanReader(answered({ id: 7, conclusion: "success", updated_at: RECENT, ...run }))(NOW)).toBeNull();
  });

  it("says unverified when GitHub won't show the steps", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async (url) => (String(url).includes("/jobs") ? new Response("{}", { status: 500 }) : Response.json({ workflow_runs: [{ id: 7, event: "schedule", head_branch: "main", conclusion: "success", updated_at: RECENT }] })));
    expect(await createNewmanReader(fetchImpl)(NOW)).toEqual({ conclusion: "unverified", at: RECENT });
  });

  it("reports a failed run without asking for its steps", async () => {
    const fetchImpl = answered({ id: 7, event: "schedule", head_branch: "main", conclusion: "failure", updated_at: RECENT });
    expect(await createNewmanReader(fetchImpl)(NOW)).toEqual({ conclusion: "failure", at: RECENT });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("reads the conclusion and time of the last finished run", async () => {
    const fetchImpl = answered({ id: 7, event: "schedule", head_branch: "main", conclusion: "success", updated_at: RECENT });
    expect(await createNewmanReader(fetchImpl)(NOW)).toEqual({ conclusion: "success", at: RECENT });
    expect(String(fetchImpl.mock.calls[0][0])).toContain("/actions/workflows/newman.yml/runs");
    expect(String(fetchImpl.mock.calls[1][0])).toContain("/actions/runs/7/jobs");
  });

  it("asks GitHub once an hour at most", async () => {
    const fetchImpl = answered({ id: 7, event: "schedule", head_branch: "main", conclusion: "success", updated_at: RECENT });
    const read = createNewmanReader(fetchImpl);
    await read(NOW);
    await read(new Date(NOW.getTime() + 59 * 60_000));
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    await read(new Date(NOW.getTime() + 61 * 60_000));
    expect(fetchImpl).toHaveBeenCalledTimes(4);
  });

  it("makes one request however many calls arrive together", async () => {
    const fetchImpl = answered({ id: 7, event: "schedule", head_branch: "main", conclusion: "success", updated_at: RECENT });
    const read = createNewmanReader(fetchImpl);
    const runs = await Promise.all(Array.from({ length: 100 }, () => read(NOW)));
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(runs.every((run) => run?.conclusion === "success")).toBe(true);
  });

  it("says nothing when GitHub won't show it, as with a private repository", async () => {
    expect(await createNewmanReader(answered(null, 404))(NOW)).toBeNull();
  });

  it("says nothing when there's no run yet", async () => {
    expect(await createNewmanReader(answered(null))(NOW)).toBeNull();
  });

  it("says nothing when GitHub can't be reached, and asks again sooner", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => { throw new Error("offline"); });
    const read = createNewmanReader(fetchImpl);
    expect(await read(NOW)).toBeNull();
    await read(new Date(NOW.getTime() + 6 * 60_000));
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
});
