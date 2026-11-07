import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { FamilyView } from "@/server/notice/store";
import { FamilyNotice } from "./FamilyNotice";

const view: FamilyView = {
  kind: "SAFETY_NOTICE",
  shopName: "The Little Shop",
  recallNumber: "27072",
  product: "SuperFast Sterilizer",
  image: null,
  recallUrl: "https://www.cpsc.gov/Recalls/2027/x",
  hazards: ["The hazard, word for word."],
  remedies: ["The remedy, word for word."],
  question: null,
  stopped: false,
  result: null,
  expired: false,
  answerOpen: false,
};
const html = (action: string | null) => renderToStaticMarkup(createElement(FamilyNotice, { view, action }));

describe("what a family sees", () => {
  it("on a real notice, names the shop, posts to its own link and isn't called a sample", () => {
    const page = html("/api/family/abc");
    expect(page).toContain('action="/api/family/abc"');
    expect(page).toContain("This page was sent by The Little Shop.");
    expect(page).not.toContain("A sample.");
    expect(page).not.toMatch(/disabled/);
  });

  describe("on the sample", () => {
    it("says it's a sample before anything else", () => {
      const page = html(null);
      expect(page).toContain("A sample. This is what a family sees for a real CPSC recall. No shop sent it, and nothing here is stored.");
      expect(page.indexOf("A sample.")).toBeLessThan(page.indexOf("<h1>"));
    });

    it("has nothing to submit, and says the button does nothing", () => {
      const page = html(null);
      expect(page).not.toContain("<form");
      expect(page).toMatch(/<button[^>]*disabled/);
      expect(page).toContain("In a real notice, this tells the shop. Here it does nothing.");
    });

    it("shows CPSC's words as they are, the same as a real notice", () => {
      const page = html(null);
      expect(page).toContain("The hazard, word for word.");
      expect(page).toContain("The remedy, word for word.");
      expect(page).toContain("https://www.cpsc.gov/Recalls/2027/x");
    });

    it("calls CPSC's page CPSC's", () => {
      const page = html(null);
      expect(page).toContain('<a href="https://www.cpsc.gov/Recalls/2027/x">Open CPSC&#x27;s recall page</a>');
      expect(page).not.toMatch(/maker/i);
    });

    it("names no shop", () => {
      expect(html(null)).toContain("A real notice names the shop that sent it.");
      expect(html(null)).not.toContain("This page was sent by");
    });
  });
});
