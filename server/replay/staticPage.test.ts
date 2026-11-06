import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import type { Replay, ReplayRow } from "./replay";
import { renderStaticReplay, SavedRunRefused } from "./staticPage";

const row = (over: Partial<ReplayRow> = {}): ReplayRow => ({ recallNumber: "27072", recallTitle: "Baby Brezza Recalls Sterilizers", recallDate: "2026-11-05", outcome: "NOT_NEAR", saleSplit: null, itemTitle: null, reason: null, ...over });
const RUN = "00000000-0000-4000-8000-000000000001";
const rows: ReplayRow[] = [
  row({ outcome: "MATCH", saleSplit: "REFUND_ELIGIBLE", itemTitle: "Baby Brezza BRZ0083", reason: "The shop's text names recalled model BRZ0083." }),
  row({ recallNumber: "27040", outcome: "SCOPE_GAP", itemTitle: "Costway high chair", reason: "The same product line." }),
  row({ recallNumber: "27001", outcome: "CLEARED", itemTitle: "Picture book lot", reason: "Shares no product word." }),
  row({ recallNumber: "26900" }),
];
const replay = (over: Partial<Replay> = {}): Replay => ({
  runId: RUN,
  ms: 4321,
  createdAt: "2026-11-09T15:00:00.000Z",
  counts: { checked: 4, matched: 1, scopeGaps: 1, cleared: 1, notNear: 1, noticeOnly: 0, refundEligible: 1, unidentified: 1 },
  search: { windows: 3, failedWindows: 0, complete: true },
  recallYearsMissing: [],
  rows,
  ...over,
});
const render = (r = replay()) => renderStaticReplay(r, { site: "https://example.test" });

/** Runs the page's own script against its own rows, the way a browser would. */
function recount(html: string) {
  const rowOutcomes = [...html.matchAll(/<tr data-outcome="([A-Z_]+)"/g)].map((m) => m[1]);
  const script = /<script>([\s\S]*)<\/script>/.exec(html)?.[1] ?? "";
  const said: { textContent?: string } = {};
  runInNewContext(script, {
    document: {
      querySelectorAll: (selector: string) => (selector === "tr[data-outcome]" ? rowOutcomes.map((o) => ({ dataset: { outcome: o } })) : []),
      getElementById: (id: string) => (id === "recount" ? said : { dataset: { counts: /data-counts='([^']+)'/.exec(html)?.[1] } }),
    },
    JSON,
  });
  return said.textContent;
}

describe("the saved copy in docs/replay", () => {
  const html = readFileSync("docs/replay/index.html", "utf8");

  it("recounts to the numbers it states", () => {
    expect(recount(html)).toMatch(/^Recounted from the rows on this page: \d+ checked.* They agree with the numbers above\.$/);
  });

  it("is a real run, and says it's a copy", () => {
    expect(html).toMatch(/Run [0-9a-f-]{36}, made /);
    expect(html).toContain("A saved copy of one run");
    expect([...html.matchAll(/<tr data-outcome=/g)].length).toBeGreaterThan(100);
  });
});

describe("a saved copy of one Replay run", () => {
  it("states the run's numbers, its id and when it ran", () => {
    const html = render();
    expect(html).toContain(RUN);
    expect(html).toContain("Nov 9, 2026");
    expect(html).toMatch(/<span class="value">4<\/span>\s*<span class="label">Recalls checked/);
    expect(html).toMatch(/<span class="value">1<\/span>\s*<span class="label">Recalls matched/);
  });

  it("says plainly that it's a copy, that it runs nothing, and that the dates are the demo shop's", () => {
    const html = render();
    expect(html).toContain("A saved copy of one run");
    expect(html).toContain("It runs nothing");
    expect(html).toContain("the demo shop's, on seeded dates");
  });

  it("holds every row, so the count can be done from the page alone", () => {
    expect([...render().matchAll(/<tr data-outcome=/g)]).toHaveLength(4);
  });

  it("recounts its own rows in the browser, and says they agree", () => {
    expect(recount(render())).toBe("Recounted from the rows on this page: 4 checked, 1 matched, 1 can't tell yet, 1 cleared, 1 not near. They agree with the numbers above.");
  });

  it("says so if the rows and the stated numbers differ", () => {
    const html = render().replace('data-counts=\'{"checked":4', 'data-counts=\'{"checked":5');
    expect(recount(html)).toContain("do not agree");
  });

  it("links to the live page and the live recount, and says those need the server", () => {
    const html = render();
    expect(html).toContain(`https://example.test/replay/${RUN}`);
    expect(html).toContain(`https://example.test/api/proof/${RUN}`);
    expect(html).toContain("need the live site");
  });

  it("treats every title as text", () => {
    const html = render(replay({ rows: [row({ recallTitle: `<script>alert("x")</script>`, itemTitle: "A & B <b>", reason: "it's \"so\"", outcome: "MATCH" }), ...rows.slice(1)] }));
    expect(html).not.toContain(`<script>alert`);
    expect(html).toContain("&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;");
    expect(html).toContain("A &amp; B &lt;b&gt;");
  });

  it("depends on nothing outside the page, so it works with the server down", () => {
    const html = render();
    expect(html).not.toMatch(/<script[^>]+src=|<link[^>]+href=|@import|url\(/);
  });

  it("has a language, a title and a viewport, and writes no em dashes", () => {
    const html = render();
    expect(html).toContain('<html lang="en">');
    expect(html).toContain("<title>Recall Replay, saved copy</title>");
    expect(html).toContain('name="viewport"');
    expect(html).not.toMatch(/[–—“”]/);
  });

  describe("what it won't save", () => {
    it.each([
      ["a run that couldn't read PayPal", replay({ search: { windows: 3, failedWindows: 1, complete: false } })],
      ["a run with years missing", replay({ recallYearsMissing: [2025] })],
      ["a run whose rows don't add up", replay({ counts: { ...replay().counts, checked: 5 } })],
      ["a run with no rows", replay({ rows: [], counts: { ...replay().counts, checked: 0, matched: 0, scopeGaps: 0, cleared: 0, notNear: 0 } })],
    ])("%s", (_name, r) => {
      expect(() => render(r)).toThrow(SavedRunRefused);
    });
  });
});
