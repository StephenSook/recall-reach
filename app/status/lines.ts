// What the status page says. Each line gives a reading and what that reading actually measures, so "key present" or
// "last read" never passes for "working right now". Only Postgres is asked anything when the page loads.
import { ranAt } from "@/app/replay/labels";
import type { Health } from "@/server/health";

export type LineState = "ok" | "problem" | "unknown";

export interface StatusLine {
  service: string;
  state: LineState;
  reading: string;
  measures: string;
}

const NOT_READ = "Can't tell: this is stored in the database, which did not answer.";

export function statusLines(h: Health, env: { claudeKeySet: boolean }): StatusLine[] {
  const db = h.database.ok;
  const pull = h.cpsc?.lastPull;
  const verified = h.paypal.lastVerifiedWebhookAt;
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
      service: "Channel3",
      state: !db ? "unknown" : h.market.fresh ? "ok" : "problem",
      reading: !db ? NOT_READ : h.market.lastOkAt ? `Last good search ${ranAt(h.market.lastOkAt)}.` : "No good search on record.",
      measures: "The last good market search, and whether it's under 8 days old. Its page reads stored rows, so nobody waits on Channel3.",
    },
    {
      service: "Claude",
      state: !env.claudeKeySet ? "problem" : !db ? "unknown" : h.claude.fresh ? "ok" : "problem",
      reading: !env.claudeKeySet ? "No key set. The Claude check says it's unavailable." : !db ? NOT_READ : h.claude.lastOkAt ? `Last good answer ${ranAt(h.claude.lastOkAt)}.` : "No good answer on record.",
      measures: "The last good answer on record, from a check or a daily call on the cheapest model, and whether it's under 2 days old. This page never calls Claude.",
    },
  ];
}
