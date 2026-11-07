import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const read = vi.hoisted(() => vi.fn());
vi.mock("@/server/db/pg", () => ({ getDb: () => ({}) }));
vi.mock("@/server/match/textCheck", async (original) => ({ ...(await original<typeof import("@/server/match/textCheck")>()), readPublicRecall: read }));

import PublicRecallPage from "./page";

const RECALL = {
  found: true,
  recallNumber: "27072",
  title: "Baby Brezza Recalls SuperFast Sterilizer Dryers",
  recallDate: "2026-11-05",
  url: "https://www.cpsc.gov/Recalls/2027/x",
  description: "d",
  products: [{ name: "SuperFast Sterilizer", model: "BRZ0083", type: null, units: null }],
  hazards: ["The hazard, word for word."],
  remedies: ["The remedy, word for word."],
};
const page = async (number = "27072") => renderToStaticMarkup(createElement("div", null, await PublicRecallPage({ params: Promise.resolve({ number }) })));

describe("the public recall page", () => {
  beforeEach(() => {
    read.mockReset();
    read.mockResolvedValue(RECALL);
  });

  it("is CPSC's title, hazard and remedy, its source, and its link", async () => {
    const html = await page();
    expect(html).toContain(`<h1>${RECALL.title}</h1>`);
    expect(html).toContain("The hazard, word for word.");
    expect(html).toContain("The remedy, word for word.");
    expect(html).toContain("From CPSC&#x27;s public recall record.");
    expect(html).toContain(`<a href="${RECALL.url}">Open CPSC&#x27;s recall page</a>`);
  });

  it("says nothing about a shop, a payment, Claude or a match, and has no form", async () => {
    const html = await page();
    expect(html).not.toMatch(/shop|paypal|claude|match|refund|<form/i);
  });

  it.each(["../etc", "a b", "x".repeat(30)])("won't read %s", async (number) => {
    await expect(page(number)).rejects.toThrow();
    expect(read).not.toHaveBeenCalled();
  });

  it("is not found for a recall that isn't held", async () => {
    read.mockResolvedValue({ found: false, note: "n" });
    await expect(page("99999")).rejects.toThrow();
  });
});
