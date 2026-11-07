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

  it("closes the held refunds only on a measured cause and a refund that completed on the deployed site", () => {
    const pending = DEFECTS.find((d) => /PENDING/.test(d.title));
    expect(pending?.found).toContain("We didn't know why then.");
    expect(pending?.changed).toContain("funded");
    expect(pending?.checked).toContain("its $18 refund read COMPLETED");
    expect(pending?.open).toBe(false);
  });

  it("links each commit, and writes no em dashes", () => {
    const html = renderToStaticMarkup(DefectsPage());
    for (const sha of DEFECTS.flatMap((d) => d.commits)) expect(html).toContain(`https://github.com/StephenSook/recall-reach/commit/${sha}`);
    expect(html).not.toMatch(/[–—“”]/);
  });
});
