import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { ShopWarning } from "@/server/warnings/warnings";
import { warningMailto, WarningCards } from "./WarningCards";

const warning: ShopWarning = { number: "27-002", warnedOn: "2026-10-01", title: "t", product: "Mbabyjon Crib Bumpers", description: "d", hazard: "A hazard, word for word.", consumerAction: "An action, word for word.", soldAt: "s", itemTitle: "Mbabyjon crib bumpers" };
const html = (warnings: ShopWarning[], demo = false) => renderToStaticMarkup(createElement(WarningCards, { warnings, demo }));

describe("a shop's CPSC warnings", () => {
  it("shows nothing when there are none", () => {
    expect(html([])).toBe("");
  });

  it("starts closed, with its own label and count", () => {
    const page = html([warning]);
    expect(page).toMatch(/^<details/);
    expect(page).not.toMatch(/^<details[^>]* open/);
    expect(page).toContain("CPSC warnings (1)");
    expect(page).toContain("CPSC WARNING");
  });

  it("gives CPSC's words as they are", () => {
    const page = html([warning]);
    expect(page).toContain("A hazard, word for word.");
    expect(page).toContain("An action, word for word.");
  });

  it("offers no refund, and says why", () => {
    const page = html([warning]);
    expect(page).toContain("No refund is offered here.");
    expect(page).not.toMatch(/<button|Review refund/);
  });

  it("opens a notice in the seller's own mail, with no address and CPSC's words", () => {
    const link = decodeURIComponent(warningMailto(warning));
    expect(link.startsWith("mailto:?subject=")).toBe(true);
    expect(link).toContain("A hazard, word for word.");
    expect(link).toContain("An action, word for word.");
  });

  it("says a demo shop's title is a sample, not a sale", () => {
    expect(html([warning], true)).toContain("A labelled sample title, not a sale");
    expect(html([warning])).not.toContain("sample");
  });
});
