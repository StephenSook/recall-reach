import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { PROVENANCE, tidy, withProvenance } from "./apimatic-tidy";

const BANNED = /[\u2013\u2014\u2018\u2019\u201c\u201d]/;

describe("tidying what APIMatic generates", () => {
  it("turns a dash between words into a comma, in prose", () => {
    expect(tidy("before it can be referenced \u2014 run its build", ".md")).toBe("before it can be referenced, run its build");
    expect(tidy("is required \u2014 `new X()` compiles \u2014 and each", ".md")).toBe("is required, `new X()` compiles, and each");
    expect(tidy("| a | \u2014 |", ".md")).toBe("| a | - |");
    expect(tidy("pages 1\u20132", ".md")).toBe("pages 1-2");
    expect(tidy("\u201cquoted\u201d and it\u2019s", ".md")).toBe('"quoted" and it\'s');
  });

  it("keeps code the same in a script: a character in a table becomes its escape, and a string's delimiter can't change", () => {
    expect(tidy("mdash:`\u2014`,lsquo:`\u2018`", ".js")).toBe("mdash:`\\u2014`,lsquo:`\\u2018`");
    expect(tidy("'it\u2019s not open'", ".js")).toBe("'it\\u2019s not open'");
    expect(tidy("children:'can be referenced \u2014 run its build'", ".js")).toBe("children:'can be referenced, run its build'");
    expect(tidy('quotes:"\u201c""\u201d"', ".css")).toBe('quotes:"\\201C""\\201D"');
  });

  it("reads the same in a page and in the script that draws it, so the page doesn't redraw itself", () => {
    const words = " is required \u2014 ";
    expect(tidy(`<p>Nothing${words}<code>x</code></p>`, ".html")).toBe("<p>Nothing is required, <code>x</code></p>");
    expect(tidy(`children:["Nothing${words}",code]`, ".js")).toBe('children:["Nothing is required, ",code]');
    expect(tidy("<td>\u2014</td>", ".html")).toBe("<td>-</td>");
    expect(tidy('children:"\u2014"', ".js")).toBe('children:"-"');
  });

  it("keeps JSON valid", () => {
    const out = tidy('{"content":"is required \u2014 and \u201cthis\u201d"}', ".json");
    expect(JSON.parse(out)).toEqual({ content: 'is required, and "this"' });
  });

  it("leaves nothing banned in what's committed from APIMatic", () => {
    const files = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "--", "sdk", "public/api-docs"], { encoding: "utf8" }).split("\n").filter(Boolean);
    expect(files.length).toBeGreaterThan(100);
    const found = files.filter((f) => !/\.(woff2?|png|jpe?g|ico|zip|gif|webp)$/.test(f) && BANNED.test(readFileSync(f, "utf8")));
    expect(found).toEqual([]);
  });
});

describe("saying where the SDK came from", () => {
  const readme = "# Recall Reach public API\n\nThe Recall Reach public API SDK for TypeScript.\n";

  it("adds one line under the title, saying APIMatic's CLI generated it from this repo's openapi.yaml", () => {
    expect(withProvenance(readme)).toBe(`# Recall Reach public API\n\n${PROVENANCE}\n\nThe Recall Reach public API SDK for TypeScript.\n`);
    expect(PROVENANCE).toContain("APIMatic's CLI");
    expect(PROVENANCE).toContain("openapi.yaml");
  });

  it("adds it only once, so running the tidy again changes nothing", () => {
    expect(withProvenance(withProvenance(readme))).toBe(withProvenance(readme));
  });

  it("is in the committed SDK README, so a regenerated SDK can't arrive without it", () => {
    expect(readFileSync("sdk/typescript/README.md", "utf8")).toContain(PROVENANCE);
  });
});
