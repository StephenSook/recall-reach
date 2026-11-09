// What each outside service is doing right now, one row each, for /api/health, so anyone can check the wiring with one GET.
// A row reads live only after its own check passed: there's one helper that can say so, and a test holds it to that.
// Whether a licence is set is all that's read about one. Its value never comes here.
import packageJson from "../package.json";
import type { Queryable } from "./db/types";
import type { Health } from "./health";
import { sweepCounts } from "./sweep/sweep";

export type IntegrationMode = "live" | "fallback" | "off" | "client";

export interface IntegrationRow {
  id: string;
  name: string;
  mode: IntegrationMode;
  detail: string;
  /** When the check ran, or when the thing last worked. Null when there's nothing to show. */
  checkedAt: string | null;
}

export interface Integrations {
  summary: { live: number; fallback: number; off: number; client: number; of: number };
  rows: IntegrationRow[];
}

export interface NewmanRun { conclusion: string | null; at: string | null }

export interface IntegrationFacts {
  databaseOk: boolean;
  checkedAt: string;
  cpsc: { fresh: boolean; recalls: number; lastPullAt: string | null };
  claude: { mainFresh: boolean; mainAt: string | null; anyFresh: boolean; anyAt: string | null };
  paypal: { webhookConfigured: boolean; lastVerifiedWebhookAt: string | null };
  channel3: { fresh: boolean; lastOkAt: string | null; searched: number; listings: number };
  replay: { lastRunAt: string | null; task: { outcome: string | null; finishedAt: string | null } | null };
  agGridLicence: boolean;
  /** The latest Replay run's rows, as AG Studio reads them. "no-run" when Replay has none; null when the query failed. */
  agStudio: { licence: boolean; rows: number | "no-run" | null };
  newman: NewmanRun | null;
}

const DAY_MS = 86_400_000;
const WEBHOOK_MAX_AGE_MS = 7 * DAY_MS;
const RUN_MAX_AGE_MS = 2 * DAY_MS;

interface Check {
  passed: boolean;
  at: string | null;
  detail: string;
  otherwise?: "fallback" | "off";
}

/** The only place a row can say live: its check passed, and there's a time to show for it. */
function checked(id: string, name: string, { passed, at, detail, otherwise = "off" }: Check): IntegrationRow {
  return { id, name, mode: passed && at !== null ? "live" : otherwise, detail, checkedAt: at };
}

/** Runs in the visitor's browser, so this server can't see it working. A licence key being set doesn't show that either. */
function inBrowser(id: string, name: string, detail: string): IntegrationRow {
  return { id, name, mode: "client", detail: `Runs in the browser, so this server can't check it. ${detail}`, checkedAt: null };
}

export function integrationsFrom(facts: IntegrationFacts, now: Date): Integrations {
  const within = (at: string | null, ms: number) => at !== null && now.getTime() - Date.parse(at) <= ms;
  const { claude, paypal, channel3, replay, newman, agStudio, cpsc } = facts;

  const taskWorked = replay.task !== null && replay.task.outcome !== null && replay.task.outcome !== "FAILED" && within(replay.task.finishedAt, RUN_MAX_AGE_MS);
  const replayFresh = within(replay.lastRunAt, RUN_MAX_AGE_MS);
  const webhookSeen = paypal.webhookConfigured && within(paypal.lastVerifiedWebhookAt, WEBHOOK_MAX_AGE_MS);
  const newmanPassed = newman?.conclusion === "success" && within(newman.at, RUN_MAX_AGE_MS);

  const rows: IntegrationRow[] = [
    checked("neon", "Neon Postgres", { passed: facts.databaseOk, at: facts.databaseOk ? facts.checkedAt : null, detail: facts.databaseOk ? "Answered this request." : "Didn't answer." }),
    checked("cpsc", "CPSC recalls", { passed: cpsc.fresh, at: cpsc.lastPullAt, detail: cpsc.fresh ? `${cpsc.recalls} recalls held. Polled in the last 2.5 hours.` : "The last poll is old or failed." }),
    checked("claude", "Claude", {
      passed: claude.mainFresh,
      at: claude.mainFresh ? claude.mainAt : claude.anyAt,
      detail: claude.mainFresh ? "The main model answered in the last 2 days." : claude.anyFresh ? "Only the fallback model answered in the last 2 days." : "No answer in the last 2 days.",
      otherwise: claude.anyFresh ? "fallback" : "off",
    }),
    checked("paypal", "PayPal sandbox webhooks", {
      passed: webhookSeen,
      at: paypal.lastVerifiedWebhookAt,
      detail: webhookSeen ? "PayPal's signature on a webhook was verified in the last 7 days." : paypal.webhookConfigured ? "No webhook verified in the last 7 days." : "Webhooks aren't set up.",
    }),
    checked("channel3", "Channel3 market search", {
      passed: channel3.fresh,
      at: channel3.lastOkAt,
      detail: channel3.fresh ? `Searched ${channel3.searched} recalls, holding ${channel3.listings} listings.` : "No good search in the last 8 days.",
    }),
    checked("render-workflows", "Render Workflows", {
      passed: taskWorked,
      at: taskWorked ? (replay.task?.finishedAt ?? null) : replay.lastRunAt,
      // A run row doesn't say who wrote it, the task or the web service, so the fallback says only that one exists.
      detail: taskWorked ? `The scheduled refresh ended ${replay.task?.outcome} in the last 2 days.` : replayFresh ? "The scheduled refresh didn't finish cleanly lately. A Replay run from the last 2 days exists." : "No refresh in the last 2 days.",
      otherwise: replayFresh ? "fallback" : "off",
    }),
    inBrowser("ag-grid", "AG Grid Enterprise", facts.agGridLicence ? "Licence key is set on the server, for the queue and Replay tables." : "No licence key is set, so the tables show AG's watermark."),
    typeof agStudio.rows !== "number" || agStudio.rows === 0
      ? checked("ag-studio", "AG Studio", { passed: false, at: null, detail: agStudio.rows === null ? "Its data didn't answer." : agStudio.rows === "no-run" ? "Recall Replay has no run yet, so it has no data." : "Recall Replay's latest run has no rows." })
      : inBrowser("ag-studio", "AG Studio", `${agStudio.licence ? "Licence key is set on the server" : "No licence key is set"}. Its data answered with ${agStudio.rows} rows.`),
    inBrowser("bryntum", "Bryntum Scheduler", `Package version ${packageJson.dependencies["@bryntum/scheduler-community"]}.`),
    checked("newman", "Postman collection (Newman in CI)", {
      passed: newmanPassed,
      at: newman?.at ?? null,
      detail: newmanPassed ? "The last scheduled run against this site passed." : newman ? `The last run isn't a recent pass (${newman.conclusion ?? "unknown"}).` : "GitHub showed no scheduled run. The repository may be private, or GitHub didn't answer.",
    }),
  ];

  const count = (mode: IntegrationMode) => rows.filter((r) => r.mode === mode).length;
  return { summary: { live: count("live"), fallback: count("fallback"), off: count("off"), client: count("client"), of: rows.length }, rows };
}

const GITHUB_REPO = "https://api.github.com/repos/StephenSook/recall-reach";
// Scheduled runs on main only: a manual run can be pointed at another site, so it says nothing about this one.
const NEWMAN_RUNS = `${GITHUB_REPO}/actions/workflows/newman.yml/runs?event=schedule&branch=main&status=completed&per_page=1`;
/** The workflow can pass with these skipped, as it does once it retires, so a passed run alone proves nothing. */
const NEWMAN_STEPS = ["Run the public collection", "Check the counts"];
const NEWMAN_CACHE_MS = 60 * 60_000;
const NEWMAN_RETRY_MS = 5 * 60_000;

/** GitHub's public API, at most hourly: a health check mustn't spend its rate limit. Null when GitHub won't say, as with a private repository. */
export function createNewmanReader(fetchImpl: typeof fetch = (...args) => fetch(...args)): (now: Date) => Promise<NewmanRun | null> {
  let held: { run: NewmanRun | null; until: number } | null = null;
  // Calls arriving together share one request: this route is public, and the first call after the cache lapses can be many.
  let asking: Promise<NewmanRun | null> | null = null;
  const ask = async (now: Date): Promise<NewmanRun | null> => {
    try {
      const request = () => ({ headers: { accept: "application/vnd.github+json" }, cache: "no-store" as const, redirect: "error" as const, signal: AbortSignal.timeout(3000) });
      const res = await fetchImpl(NEWMAN_RUNS, request());
      const body = res.ok ? ((await res.json()) as { workflow_runs?: { id?: number; event?: string; head_branch?: string; conclusion?: string | null; updated_at?: string }[] }) : null;
      const last = body?.workflow_runs?.find((r) => r.event === "schedule" && r.head_branch === "main");
      let run: NewmanRun | null = last ? { conclusion: last.conclusion ?? null, at: last.updated_at ?? null } : null;
      if (run && last && run.conclusion === "success") {
        const jobsRes = await fetchImpl(`${GITHUB_REPO}/actions/runs/${Number(last.id)}/jobs`, request());
        const jobs = jobsRes.ok ? ((await jobsRes.json()) as { jobs?: { steps?: { name?: string; conclusion?: string | null }[] }[] }) : null;
        if (!jobs) run = { ...run, conclusion: "unverified" };
        else {
          const steps = (jobs.jobs ?? []).flatMap((job) => job.steps ?? []);
          if (!NEWMAN_STEPS.every((name) => steps.some((step) => step.name === name && step.conclusion === "success"))) run = { ...run, conclusion: "skipped" };
        }
      }
      held = { run, until: now.getTime() + NEWMAN_CACHE_MS };
      return run;
    } catch {
      held = { run: null, until: now.getTime() + NEWMAN_RETRY_MS };
      return null;
    }
  };
  return async (now) => {
    if (held && now.getTime() < held.until) return held.run;
    asking ??= ask(now).finally(() => { asking = null; });
    return asking;
  };
}

const readNewman = createNewmanReader();

interface Readers {
  sweepCounts: (db: Queryable) => Promise<{ searched: number; listings: number }>;
  studioRows: (db: Queryable) => Promise<number | "no-run">;
  newman: (now: Date) => Promise<NewmanRun | null>;
}

/** A count of the rows AG Studio reads (server/studio/dataset.ts), without loading them: this route is public. */
async function studioRowCount(db: Queryable): Promise<number | "no-run"> {
  const { rows } = await db.query<{ run: string | null; n: string }>(
    `with latest as (select id from replay_runs order by created_at desc, id limit 1)
     select (select id::text from latest) as run, (select count(*) from replay_rows where run_id = (select id from latest))::text as n`,
  );
  return rows[0]?.run ? Number(rows[0].n) : "no-run";
}

const REAL_READERS: Readers = {
  sweepCounts,
  studioRows: studioRowCount,
  newman: readNewman,
};

const orNull = async <T>(read: () => Promise<T>): Promise<T | null> => {
  try {
    return await read();
  } catch (err) {
    // The name only: a database error can quote what it was given.
    console.error("integration check failed:", err instanceof Error ? err.name : "unknown error");
    return null;
  }
};

/** Reads what /api/health doesn't already hold. One check failing marks that row down and leaves the others. */
export async function integrationFacts(
  db: Queryable,
  health: Pick<Health, "database" | "checkedAt" | "checks" | "cpsc" | "claude" | "paypal" | "market" | "replay">,
  env: { AG_GRID_LICENSE_KEY?: string; AG_STUDIO_LICENSE_KEY?: string },
  readers: Readers = REAL_READERS,
  now: Date = new Date(),
): Promise<IntegrationFacts> {
  const [sweep, studio, newman] = await Promise.all([orNull(() => readers.sweepCounts(db)), orNull(() => readers.studioRows(db)), orNull(() => readers.newman(now))]);
  return {
    databaseOk: health.database.ok,
    checkedAt: health.checkedAt,
    cpsc: { fresh: health.checks.lastPull, recalls: health.cpsc?.recalls ?? 0, lastPullAt: health.cpsc?.lastPull?.finishedAt ?? null },
    claude: { mainFresh: health.claude.mainModelFresh, mainAt: health.claude.mainModelOkAt, anyFresh: health.claude.fresh, anyAt: health.claude.lastOkAt },
    paypal: { webhookConfigured: health.paypal.webhookConfigured, lastVerifiedWebhookAt: health.paypal.lastVerifiedWebhookAt },
    channel3: { fresh: health.market.fresh && sweep !== null, lastOkAt: health.market.lastOkAt, searched: sweep?.searched ?? 0, listings: sweep?.listings ?? 0 },
    replay: { lastRunAt: health.replay.lastRunAt, task: health.replay.lastTaskRun ? { outcome: health.replay.lastTaskRun.outcome, finishedAt: health.replay.lastTaskRun.finishedAt } : null },
    agGridLicence: Boolean(env.AG_GRID_LICENSE_KEY?.trim()),
    agStudio: { licence: Boolean(env.AG_STUDIO_LICENSE_KEY?.trim()), rows: studio },
    newman,
  };
}

/** The whole /api/health answer: the checks, then one row per outside service. The route and the OpenAPI test both use this. */
export async function withIntegrations<H extends Parameters<typeof integrationFacts>[1]>(
  db: Queryable,
  health: H,
  env: { AG_GRID_LICENSE_KEY?: string; AG_STUDIO_LICENSE_KEY?: string },
  readers: Partial<Readers> = {},
  now: Date = new Date(),
): Promise<H & { integrations: Integrations }> {
  const facts = await integrationFacts(db, health, env, { ...REAL_READERS, ...readers }, now);
  return { ...health, integrations: integrationsFrom(facts, now) };
}
