// What the status page says. Each line gives a reading and what that reading actually measures, so "key present" or
// "last read" never passes for "working right now". Only Postgres is asked anything when the page loads.
import { ranAt } from "@/app/replay/labels";
import type { Health } from "@/server/health";
import type { TaskRun } from "@/server/replay/taskRuns";

export type LineState = "ok" | "problem" | "unknown";

export interface StatusLine {
  service: string;
  state: LineState;
  reading: string;
  measures: string;
}

/** What the app does when an outside service fails, and how we know: seen for real, or only tested. */
export const WHAT_HAPPENS: { when: string; does: string; seen: string }[] = [
  {
    when: "CPSC's API fails",
    does: "The recalls held here keep working, and the CPSC line above says since when. A failed read marks no dates as read, so they're read again when CPSC answers. A single record that can't be read is reported and isn't stored.",
    seen: "Seen on the deployed site from Nov 7, 2026.",
  },
  {
    when: "Claude's daily limit runs out",
    does: "The Claude check says it has reached today's limit. Matching doesn't use Claude, and a notice falls back to a hand-written question, CPSC's model numbers or a plain one.",
    seen: "Tested with a stand-in. Not seen on the deployed site as of Nov 6, 2026.",
  },
  {
    when: "PayPal answers a refund with PENDING",
    does: "The refund page says PayPal hasn't finished it, and the sale doesn't count as refunded.",
    seen: "Seen on the sandbox from Nov 6, 2026. We don't know why it started. See /evidence/defects.",
  },
  {
    when: "PayPal gives no clear answer to a refund",
    does: "The refund stays open and the page says to check PayPal. Asking again repeats the same request id, so PayPal returns the first refund and doesn't make a second.",
    seen: "Tested with a stand-in PayPal. The repeated request id was measured on the sandbox Nov 5, 2026.",
  },
];

const NOT_READ = "Can't tell: this is stored in the database, which did not answer.";

/** What each outcome of the refresh task means, in the task's own words for it. */
const TASK_DID = { FRESH: "the numbers were fresh, so it changed nothing", RAN: "it ran Replay again", DISCARDED: "it ran Replay but kept the last run", FAILED: "it failed" } as const;
/** The task's own 30-minute limit, and a little for the host to start it. */
const TASK_LIMIT_MS = 35 * 60_000;
/** The task is started daily and a start can be skipped, so a run older than this says nothing about now. */
const TASK_STALE_MS = 2 * 24 * 3_600_000;

function taskReading(task: TaskRun | null, checkedAt: string): { state: LineState; reading: string } {
  if (!task) return { state: "unknown", reading: "No run on record." };
  const age = Date.parse(checkedAt) - Date.parse(task.startedAt);
  if (!task.finishedAt) {
    return age > TASK_LIMIT_MS
      ? { state: "problem", reading: `Started ${ranAt(task.startedAt)}, and didn't finish within 30 minutes.` }
      : { state: "unknown", reading: `Started ${ranAt(task.startedAt)}, not finished.` };
  }
  const did = `Last run finished ${ranAt(task.finishedAt)}: ${TASK_DID[task.outcome ?? "FAILED"]}.${task.taskRunId ? ` Run ${task.taskRunId}.` : ""}`;
  if (task.outcome === "FAILED") return { state: "problem", reading: did };
  if (age > TASK_STALE_MS) return { state: "unknown", reading: `${did} That was over 2 days ago.` };
  return { state: "ok", reading: did };
}

export function statusLines(h: Health, env: { claudeKeySet: boolean }): StatusLine[] {
  const db = h.database.ok;
  const pull = h.cpsc?.lastPull;
  const verified = h.paypal.lastVerifiedWebhookAt;
  const task = taskReading(h.replay.lastTaskRun, h.checkedAt);
  const paypalReading = !h.paypal.webhookConfigured ? "Webhook isn't set up, so a delivery can't be verified." : verified ? `Last verified delivery ${ranAt(verified)}.` : "Webhook ID set. No delivery on record.";
  return [
    {
      service: "Postgres",
      state: db ? "ok" : "problem",
      reading: db ? "Answered when this page loaded" : "Did not answer",
      measures: "A query made as this page loaded. The only outside call this page makes.",
    },
    {
      service: "CPSC recalls",
      state: !db ? "unknown" : h.checks.lastPull ? "ok" : "problem",
      reading: !db
        ? NOT_READ
        : h.degraded
          ? `CPSC's API has been failing since ${h.degraded.since ? ranAt(h.degraded.since) : "the last read"}. Last good read ${h.degraded.lastGoodAt ? ranAt(h.degraded.lastGoodAt) : "not on record"}. The ${h.cpsc?.recalls.toLocaleString("en-US")} recalls held here still work.`
          : pull ? `Last read finished ${ranAt(pull.finishedAt)}. ${h.cpsc?.recalls.toLocaleString("en-US")} recalls held.` : "No read on record.",
      measures: "The last hourly read of CPSC's API, and whether it worked in the last 2.5 hours. Not a call made now.",
    },
    {
      service: "CPSC warnings",
      state: !db ? "unknown" : h.warnings.fresh ? "ok" : "problem",
      reading: !db ? NOT_READ : h.warnings.lastOkAt ? `Last read ${ranAt(h.warnings.lastOkAt)}. ${h.warnings.count.toLocaleString("en-US")} warnings held.` : "No read on record.",
      measures: "The last daily read of CPSC's warnings file, and whether it's under 8 days old. Apart from recalls. Not a call made now.",
    },
    {
      service: "PayPal webhooks",
      state: h.paypal.webhookConfigured ? "ok" : "problem",
      reading: paypalReading,
      measures: "The webhook setting, and the last delivery whose signature was verified. Sandbox only. This page makes no PayPal call.",
    },
    {
      service: "PayPal data rule",
      state: !db ? "unknown" : h.checks.purge ? "ok" : "problem",
      reading: !db ? NOT_READ : h.checks.purge ? "Nothing has outlived the 48-hour rule." : "Something has outlived the 48-hour rule.",
      measures: "Whether any stored PayPal row or demo shop is past 48 hours.",
    },
    {
      service: "Recall Replay",
      state: !db ? "unknown" : h.checks.replay ? "ok" : "problem",
      reading: !db ? NOT_READ : h.replay.lastRunAt ? `Last run ${ranAt(h.replay.lastRunAt)}.` : "No run on record.",
      measures: "The newest stored run, and whether it's under 2 days old.",
    },
    {
      service: "Replay's daily task",
      state: !db ? "unknown" : task.state,
      reading: !db ? NOT_READ : task.reading,
      measures:
        "The row the refresh task writes on every run, including runs that change nothing. Its daily start can be skipped, and then the web service refreshes Replay itself once the numbers pass 28 hours.",
    },
    {
      service: "Channel3",
      state: !db ? "unknown" : h.market.fresh ? "ok" : "problem",
      reading: !db ? NOT_READ : h.market.lastOkAt ? `Last good search ${ranAt(h.market.lastOkAt)}.` : "No good search on record.",
      measures: "The last good market search, and whether it's under 8 days old. Its page reads stored rows, so nobody waits on Channel3.",
    },
    {
      service: "Claude",
      state: !env.claudeKeySet ? "problem" : !db ? "unknown" : h.claude.fresh && h.claude.mainModelFresh ? "ok" : "problem",
      reading: !env.claudeKeySet
        ? "No key set. The Claude check says it's unavailable."
        : !db
          ? NOT_READ
          : !h.claude.lastOkAt
            ? "No good answer on record."
            : `Last good answer ${ranAt(h.claude.lastOkAt)}. Main model last answered ${h.claude.mainModelOkAt ? ranAt(h.claude.mainModelOkAt) : "not on record"}.`,
      measures: "The last good answers on record, from a check or the daily calls, and whether each is under 2 days old. A check can fall back to the cheaper model, so the main model has its own date. This page never calls Claude.",
    },
  ];
}
