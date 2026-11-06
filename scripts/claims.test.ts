import { describe, expect, it } from "vitest";
import { builtWith, checkClaims, CLAIMS, type Claim } from "./claims";
import { readRepo } from "./claimsFiles";

const files = (contents: Record<string, string>, readable: string[] = []) => ({
  read: (file: string) => contents[file] ?? null,
  readable: () => readable,
});
const claimed = (find: string, file = "a.ts"): Claim[] => [{ name: "Thing", status: "claimed", evidence: [{ file, find }] }];
const cut: Claim[] = [{ name: "Gone", status: "cut", why: "not built", mentions: ["gone tool"] }];

describe("checkClaims", () => {
  it("passes when the call is there", () => {
    expect(checkClaims(claimed("call\\("), files({ "a.ts": "call();" }))).toEqual([]);
  });

  it("fails when the call is gone, and says which", () => {
    expect(checkClaims(claimed("call\\("), files({ "a.ts": "other();" }))).toEqual(["Thing: a.ts has nothing matching call\\("]);
  });

  it("fails when the file is gone", () => {
    expect(checkClaims(claimed("call\\("), files({}))).toEqual(["Thing: a.ts doesn't exist"]);
  });

  it.each(["// call();", "/* call(); */", "  // call() is what we would use"])("doesn't count a call that's only in a comment: %s", (code) => {
    expect(checkClaims(claimed("call\\("), files({ "a.ts": code }))).toHaveLength(1);
  });

  it("isn't fooled into losing a call by a URL on the same line", () => {
    expect(checkClaims(claimed("call\\("), files({ "a.ts": 'call("https://example.test/x");' }))).toEqual([]);
  });

  it("fails a claim with no evidence at all", () => {
    expect(checkClaims([{ name: "Empty", status: "claimed", evidence: [] }], files({}))).toEqual(["Empty: claimed with no evidence"]);
  });

  it("fails when a page mentions something cut, whatever its case", () => {
    expect(checkClaims(cut, files({ "README.md": "Built with Gone Tool." }, ["README.md"]))).toEqual(['Gone is cut, and README.md mentions "gone tool"']);
  });

  it("leaves a cut name alone in a file nobody reads", () => {
    expect(checkClaims(cut, files({ "server/x.ts": "gone tool" }, []))).toEqual([]);
  });
});

describe("this repo", () => {
  it("makes only claims its code backs, and mentions nothing it cut", () => {
    expect(checkClaims(CLAIMS, readRepo())).toEqual([]);
  });

  it("really looks at the pages", () => {
    const pages = readRepo().readable();
    expect(pages).toContain("README.md");
    expect(pages).toContain("openapi.yaml");
    expect(pages.filter((p) => p.startsWith("app/")).length).toBeGreaterThan(30);
  });

  it("gives the Built With list, with nothing cut in it", () => {
    const list = builtWith(CLAIMS);
    expect(list).toContain("PayPal Transaction Search");
    expect(list).not.toContain("Channel3");
  });
});
