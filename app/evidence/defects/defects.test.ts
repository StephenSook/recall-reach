import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { DEFECTS } from "./defects";
import DefectsPage from "./page";

describe("the defects we publish", () => {
  it("each says what was found, what changed and how it was checked, with its commits", () => {
    expect(DEFECTS.length).toBeGreaterThanOrEqual(3);
    for (const d of DEFECTS) {
      expect(d.found.length).toBeGreaterThan(20);
      expect(d.changed.length).toBeGreaterThan(20);
      expect(d.checked.length).toBeGreaterThan(20);
      expect(d.commits.length).toBeGreaterThan(0);
      for (const sha of d.commits) expect(sha).toMatch(/^[0-9a-f]{7}$/);
    }
  });

  it("doesn't claim to know why the sandbox holds refunds, and says it's still open", () => {
    const pending = DEFECTS.find((d) => /PENDING/.test(d.title));
    expect(pending?.found).toContain("We don't know why.");
    expect(pending?.open).toBe(true);
    expect(pending?.checked).toContain("Still open.");
  });

  it("links each commit, and writes no em dashes", () => {
    const html = renderToStaticMarkup(DefectsPage());
    for (const sha of DEFECTS.flatMap((d) => d.commits)) expect(html).toContain(`https://github.com/StephenSook/recall-reach/commit/${sha}`);
    expect(html).not.toMatch(/[–—“”]/);
  });
});
