import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const latest = vi.hoisted(() => vi.fn());
vi.mock("@/server/db/pg", () => ({ getDb: () => ({}) }));
vi.mock("@/server/shopper/exampleRuns", async (original) => ({ ...(await original<typeof import("@/server/shopper/exampleRuns")>()), latestExampleRun: latest }));

import ShopperEvidence, { paymentLine } from "./page";

const NOW = Date.parse("2026-11-08T02:30:00.000Z");
const RUN = {
  ask: "A high chair",
  budgetCents: 20000,
  ranAt: "2026-11-08T02:00:00.000Z",
  outcome: "PICKED",
  models: ["claude-sonnet-5-5"],
  steps: [
    { kind: "search", query: "high chair", found: 12, inBudget: 9 },
    { kind: "check", title: "Convertible high chair", result: "NAMES_A_RECALL", recalls: ["22113"] },
    { kind: "check", title: "Wooden high chair", result: "NO_MATCH_FOUND", recalls: [] },
  ],
  blocked: [{ title: "Convertible high chair", priceCents: 9900, recalls: [{ number: "22113", title: "High chairs recalled", url: null }] }],
  pick: { title: "Wooden high chair", brand: "Plan Toys", priceCents: 14900, recallsChecked: 934, from: "a shop", similar: 2 },
  slipId: null,
  offerExpiresAt: "2026-11-08T02:10:00.000Z",
  paidAt: null,
};
const render = async () => renderToStaticMarkup(createElement("div", null, await ShopperEvidence()));

describe("/evidence/shopper", () => {
  beforeEach(() => latest.mockReset());

  it("shows the recorded run, labelled with its date and the model that answered", async () => {
    latest.mockResolvedValue(RUN);
    const html = await render();
    expect(html).toContain("Recorded run");
    expect(html).toContain("Nov 7, 2026");
    expect(html).toContain("claude-sonnet-5-5");
    expect(html).toContain("A high chair");
  });

  it("shows what it searched, each recall check, what it couldn't offer and what it offered", async () => {
    latest.mockResolvedValue(RUN);
    const html = await render();
    expect(html).toContain("Searched for &quot;high chair&quot;: 12 listings, 9 in budget.");
    expect(html).toContain('href="/recall/22113"');
    expect(html).toContain("Wooden high chair");
    expect(html).toContain("149.00 USD");
    expect(html).toContain("934");
  });

  it("says when nothing has been recorded yet", async () => {
    latest.mockResolvedValue(null);
    expect(await render()).toContain("No run has been recorded yet.");
  });

  it("says whether the offer was paid, without claiming a payment that didn't happen", () => {
    expect(paymentLine({ ...RUN, paidAt: "2026-11-08T02:04:00.000Z" }, NOW)).toMatch(/^Paid on PayPal&apos;s page|^Paid on PayPal's page/);
    expect(paymentLine(RUN, NOW)).toMatch(/^Not yet paid\. The offer ran out/);
    expect(paymentLine({ ...RUN, offerExpiresAt: "2026-11-08T02:40:00.000Z" }, NOW)).toMatch(/^Not yet paid\. The offer is open until/);
    expect(paymentLine({ ...RUN, pick: null, offerExpiresAt: null }, NOW)).toBe("It offered nothing, so there was nothing to pay.");
  });
});
