import { describe, expect, it } from "vitest";
import type { Health } from "@/server/health";
import { statusLines } from "./lines";

const NOW = "2026-11-07T12:00:00.000Z";
const healthy: Health = {
  ok: true,
  checkedAt: NOW,
  checks: { database: true, webhook: true, lastPull: true, purge: true, poll: true, replay: true, logging: true },
  database: { ok: true },
  cpsc: { recalls: 1855, byYear: {}, lastPull: { id: 1, status: "ok", rangeField: "LastPublishDate", rangeStart: "a", rangeEnd: "b", finishedAt: "2026-11-07T11:30:00.000Z" } },
  poll: { lastPollAt: "2026-11-07T11:45:00.000Z", lastPollOk: true, dbTouched: false },
  replay: { lastRunAt: "2026-11-07T10:00:00.000Z" },
  market: { lastOkAt: "2026-11-05T10:00:00.000Z", fresh: true },
  claude: { lastOkAt: "2026-11-07T09:00:00.000Z", fresh: true },
  degraded: null,
  paypal: { environment: "sandbox", webhookConfigured: true, lastVerifiedWebhookAt: "2026-11-07T09:00:00.000Z" },
};
const line = (h: Health, name: string, claude = true) => statusLines(h, { claudeKeySet: claude }).find((l) => l.service === name);

describe("the status page's lines", () => {
  it("has one line for each outside service, in a fixed order", () => {
    expect(statusLines(healthy, { claudeKeySet: true }).map((l) => l.service)).toEqual(["Postgres", "CPSC recalls", "PayPal webhooks", "PayPal data rule", "Recall Replay", "Channel3", "Claude"]);
  });

  it("says on every line what the reading measures", () => {
    for (const l of statusLines(healthy, { claudeKeySet: true })) expect(l.measures.length).toBeGreaterThan(10);
  });

  it("never says live, up or working about something it didn't call just now", () => {
    for (const l of statusLines(healthy, { claudeKeySet: true })) {
      if (l.service === "Postgres") continue;
      expect(`${l.reading} ${l.measures}`).not.toMatch(/\blive\b|\bup\b|online|operational/i);
    }
  });

  it("gives Claude's last good answer, and says this page doesn't call it", () => {
    expect(line(healthy, "Claude")?.state).toBe("ok");
    expect(line(healthy, "Claude")?.reading).toMatch(/^Last good answer Nov 7, 2026, /);
    expect(line(healthy, "Claude")?.measures).toContain("never calls Claude");
    expect(line(healthy, "Claude", false)).toMatchObject({ state: "problem", reading: "No key set. The Claude check says it's unavailable." });
  });

  it("gives PayPal's last verified delivery, and says no PayPal call is made here", () => {
    expect(line(healthy, "PayPal webhooks")?.reading).toContain("Last verified delivery");
    expect(line(healthy, "PayPal webhooks")?.measures).toContain("makes no PayPal call");
    const none = { ...healthy, paypal: { ...healthy.paypal, lastVerifiedWebhookAt: null } };
    expect(line(none, "PayPal webhooks")).toMatchObject({ state: "ok", reading: "Webhook ID set. No delivery on record." });
    const unset = { ...healthy, paypal: { ...healthy.paypal, webhookConfigured: false } };
    expect(line(unset, "PayPal webhooks")?.state).toBe("problem");
  });

  it("says plainly when CPSC is what's failing, since when, and what still works", () => {
    const failing: Health = { ...healthy, ok: false, checks: { ...healthy.checks, lastPull: false }, degraded: { source: "CPSC", since: "2026-11-07T00:05:00.000Z", lastGoodAt: "2026-11-06T23:43:00.000Z" } };
    const l = line(failing, "CPSC recalls");
    expect(l?.state).toBe("problem");
    expect(l?.reading).toBe("CPSC's API has been failing since Nov 6, 2026, 7:05 PM ET. Last good read Nov 6, 2026, 6:43 PM ET. The 1,855 recalls held here still work.");
  });

  it("shows a stale CPSC poll as a problem, with when it last worked", () => {
    const stale = { ...healthy, checks: { ...healthy.checks, lastPull: false } };
    expect(line(stale, "CPSC recalls")?.state).toBe("problem");
    expect(line(stale, "CPSC recalls")?.reading).toContain("Last read finished");
  });

  it("shows Channel3 as cached rows, and a stale search as a problem", () => {
    expect(line(healthy, "Channel3")?.measures).toContain("stored");
    expect(line({ ...healthy, market: { lastOkAt: null, fresh: false } }, "Channel3")).toMatchObject({ state: "problem", reading: "No good search on record." });
  });

  it("shows the database down, and doesn't invent the rest", () => {
    const down: Health = { ...healthy, ok: false, checks: { ...healthy.checks, database: false, lastPull: false, purge: false, replay: false }, database: { ok: false }, cpsc: null, replay: { lastRunAt: null }, market: { lastOkAt: null, fresh: false }, paypal: { ...healthy.paypal, lastVerifiedWebhookAt: null } };
    expect(line(down, "Postgres")).toMatchObject({ state: "problem", reading: "Did not answer" });
    expect(line(down, "CPSC recalls")?.state).toBe("unknown");
    expect(line(down, "Recall Replay")?.state).toBe("unknown");
    expect(line(down, "PayPal data rule")?.state).toBe("unknown");
    expect(line(down, "Channel3")?.state).toBe("unknown");
  });

  it("says nothing of Render Workflows until a real run has been proved", () => {
    expect(JSON.stringify(statusLines(healthy, { claudeKeySet: true }))).not.toMatch(/workflow/i);
  });
});
