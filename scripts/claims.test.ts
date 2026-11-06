import { describe, expect, it } from "vitest";
import { builtWith, checkClaims, CLAIMS, type Claim } from "./claims";
import { readRepo } from "./claimsFiles";

const files = (contents: Record<string, string>, readable: string[] = []) => ({
  read: (file: string) => contents[file] ?? null,
  readable: () => readable,
});
const claimed = (find: string, file = "a.ts"): Claim[] => [{ name: "Thing", status: "claimed", evidence: [{ file, find }] }];
const calls = (call: string, file = "a.ts"): Claim[] => [{ name: "Thing", status: "claimed", evidence: [{ file, call }] }];
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

  describe("a call", () => {
    it.each([
      ["a plain call", "search();"],
      ["a method call", "client.search(1);"],
      ["an awaited call", "const a = await search();"],
      ["new", "const a = new search();"],
      ["a JSX element", "const a = <search rows={1} />;"],
    ])("counts %s", (_name, code) => {
      expect(checkClaims(calls("search", "a.tsx"), files({ "a.tsx": code }))).toEqual([]);
    });

    it.each([
      ["a line comment", "// search();"],
      ["a comment hiding after a quote", 'const removed = ""// search();'],
      ["a block comment", "/* search(); */"],
      ["a string", 'const a = "search()";'],
      ["a template", "const a = `search()`;"],
      ["only its definition", "export function search() {}"],
      ["only its import", 'import { search } from "./x";'],
    ])("doesn't count %s", (_name, code) => {
      expect(checkClaims(calls("search", "a.tsx"), files({ "a.tsx": code }))).toEqual(["Thing: a.tsx never calls search"]);
    });
  });

  it("doesn't count words that are only in a comment, even hiding after a quote", () => {
    expect(checkClaims(claimed("word"), files({ "a.ts": 'const a = ""// word' }))).toHaveLength(1);
  });

  it("still finds words in a string, like a URL or a package name", () => {
    expect(checkClaims(claimed("/v2/orders"), files({ "a.ts": 'get("https://x.test/v2/orders");' }))).toEqual([]);
  });

  it("reads other files as they are", () => {
    expect(checkClaims(claimed("type: web", "render.yaml"), files({ "render.yaml": "type: web # a note" }))).toEqual([]);
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

  it("finds a cut name in text a server file hands to a page", () => {
    expect(checkClaims(cut, files({ "server/x.ts": 'const title = "Gone tool check";' }, ["server/x.ts"]))).toHaveLength(1);
    expect(checkClaims(cut, files({ "app/p.tsx": "const a = <p>Gone tool</p>;" }, ["app/p.tsx"]))).toHaveLength(1);
  });

  it("leaves a cut name alone in a code comment or an identifier, which no reader sees", () => {
    expect(checkClaims(cut, files({ "server/x.ts": "// gone tool, not built\nconst goneTool = 1;" }, ["server/x.ts"]))).toEqual([]);
  });

  it("lets the code that is being built name itself while the claim stays cut", () => {
    const building: Claim[] = [{ name: "Gone", status: "cut", why: "being built", mentions: ["gone tool"], allowedIn: ["server/gone/"] }];
    expect(checkClaims(building, files({ "server/gone/x.ts": 'const a = "gone tool";' }, ["server/gone/x.ts"]))).toEqual([]);
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
    expect(pages).toContain("server/safety/attacks.ts"); // its titles show on /safety
    expect(pages).toContain("server/match/verdict.ts"); // its reasons show on the queue
    expect(pages.filter((p) => p.startsWith("app/")).length).toBeGreaterThan(30);
  });

  it("gives the Built With list, with nothing cut in it", () => {
    const list = builtWith(CLAIMS);
    expect(list).toContain("PayPal Transaction Search");
    expect(list).not.toContain("Bryntum");
  });
});
