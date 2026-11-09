import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, normalize } from "node:path";
import { describe, expect, it } from "vitest";
import { PAYPAL_SANDBOX_BASE } from "./token";

const files = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "server", "app", "scripts", "workflows", "instrumentation.ts", "next.config.ts"], { encoding: "utf8" })
  .split("\n")
  .filter((f) => /\.(ts|tsx|mjs|js)$/.test(f) && !/\.test\.tsx?$/.test(f));
const read = (f: string) => readFileSync(f, "utf8");

const PAYPAL_API = /api-m\.(sandbox\.)?paypal\.com/;
const LIVE_HOST = /\bapi(-m|-3t)?\.paypal\.com/i;
const LIVE_SWITCH = /sandbox:\s*false|Environment\.Production/;
const PAYPAL_PACKAGE = /from\s+["']@paypal\/|import\(["']@paypal\/|require\(["']@paypal\//;

const outsidePayPal = (pattern: RegExp) => files.filter((f) => !f.startsWith("server/paypal/") && pattern.test(read(f)));

// Every module a file names: from "...", import "...", import("..."), require("..."). Comments are kept out, since one can name a path.
const SPECIFIER = /(?:\bfrom\s+|\bimport\s+|\bimport\(\s*|\brequire\(\s*)["']([^"']+)["']/g;
const specifiersOf = (source: string) => [...source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1").matchAll(SPECIFIER)].map((m) => m[1]);
/** The repo file a specifier names, or null for a package or something not here. */
function resolveIn(known: Set<string>, from: string, spec: string): string | null {
  const base = spec.startsWith("@/") ? spec.slice(2) : spec.startsWith(".") ? normalize(join(dirname(from), spec)) : null;
  if (base === null) return null;
  return [base, `${base}.ts`, `${base}.tsx`, `${base}.mjs`, `${base}.js`, `${base}/index.ts`, `${base}/index.tsx`].find((c) => known.has(c)) ?? null;
}
/** The PayPal modules a file reaches, through any chain of imports. */
function payPalReachedFrom(entry: string, sourceOf: (f: string) => string, known: Set<string>): string[] {
  const seen = new Set([entry]);
  const stack = [entry];
  while (stack.length > 0) {
    const file = stack.pop()!;
    for (const spec of specifiersOf(sourceOf(file))) {
      const next = resolveIn(known, file, spec);
      if (next && !seen.has(next)) {
        seen.add(next);
        stack.push(next);
      }
    }
  }
  return [...seen].filter((f) => f.startsWith("server/paypal/")).sort();
}

/**
 * The files that build what Claude reads, Claude's client, and each agent's loop. None may reach PayPal's code by any import.
 * This checks imports, not data: what Claude is sent is proved by the payload tests (server/agent/recallAgent.test.ts "sends
 * nothing PayPal returned", checkRecord.test.ts and recallQuestion.test.ts likewise, server/studio/dataset.test.ts and
 * e2e/local/studio-payload.spec.ts), and by the tool-result types in server/agent/boundary.ts, minted only in sources.ts.
 */
const BUILDS_WHAT_CLAUDE_READS = [
  "server/agent/claude.ts",
  "server/agent/boundary.ts",
  "server/agent/sources.ts",
  "server/agent/recallAgent.ts",
  "server/agent/recallQuestion.ts",
  "server/agent/checkRecord.ts",
  "server/studio/turn.ts",
  "server/studio/dataset.ts",
  "app/api/studio/turn/route.ts",
];
/** Each other file that imports Claude's client and reaches PayPal's code, with why that's safe. */
const REACHES_PAYPAL_FOR_ITS_OWN_JOB: Record<string, string> = {
  "app/api/queue/recalls/[recallNumber]/follow-ups/route.ts": "reads the shop's own sales so code can place each date; the model is asked by recall number alone (its route.test.ts and followUpAdvice.test.ts)",
  "app/api/shopper/run/route.ts": "starts the shopping agent; it gets the client, and the agent is below",
  "instrumentation.ts": "starts the scheduled jobs; its only model call is the daily \"Say ok.\" check, which carries no PayPal data",
  "server/agent/shopper.ts": "makes the buyer's sandbox order after a person picks; the model reads only typed listing words and CPSC text (shopper.test.ts)",
  "server/health.ts": "reads when Claude last answered; it calls no model",
  "server/queue/queue.ts": "takes the model's name to say which model answered; it calls no model",
  "server/safety/attacks.ts": "its model and its PayPal are both stand-ins; nothing real is called",
};

describe("where PayPal can be reached from", () => {
  it("walks the real code", () => {
    expect(files.length).toBeGreaterThan(100);
  });

  it("names PayPal's API hosts only in server/paypal", () => {
    expect(outsidePayPal(PAYPAL_API)).toEqual([]);
  });

  it("imports the Toolkit and the Server SDK only in server/paypal", () => {
    expect(outsidePayPal(PAYPAL_PACKAGE)).toEqual([]);
  });

  it("keeps PayPal's code out of what builds Claude's requests, through any chain of imports", () => {
    const known = new Set(files);
    for (const file of BUILDS_WHAT_CLAUDE_READS) expect(known.has(file), file).toBe(true);
    for (const file of BUILDS_WHAT_CLAUDE_READS) expect(payPalReachedFrom(file, read, known), file).toEqual([]);
  });

  it("names each other file that imports Claude's client and reaches PayPal's code, with why", () => {
    const known = new Set(files);
    const importsClaude = files.filter((f) => !f.startsWith("server/paypal/") && !f.startsWith("scripts/") && specifiersOf(read(f)).some((s) => s === "@anthropic-ai/sdk" || resolveIn(known, f, s) === "server/agent/claude.ts"));
    expect(importsClaude.length).toBeGreaterThan(5);
    const reaching = importsClaude.filter((f) => !BUILDS_WHAT_CLAUDE_READS.includes(f) && payPalReachedFrom(f, read, known).length > 0).sort();
    expect(reaching).toEqual(Object.keys(REACHES_PAYPAL_FOR_ITS_OWN_JOB).sort());
  });

  it("names no live PayPal host, in code or in what configures it", () => {
    const everything = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard"], { encoding: "utf8" })
      .split("\n")
      .filter((f) => f && !/\.test\.tsx?$/.test(f) && (/\.(ts|tsx|mts|cts|mjs|cjs|js|json|ya?ml|sh|toml|example)$/.test(f) || /(^|\/)(Dockerfile|\.env[^/]*)$/.test(f)) && !/(^|\/)pnpm-lock\.yaml$/.test(f) && !f.startsWith("eval/") && !f.startsWith("test/") && !f.startsWith("docs/"));
    expect(everything.length).toBeGreaterThan(100);
    expect(everything.filter((f) => existsSync(f) && LIVE_HOST.test(read(f)))).toEqual([]);
  });

  it("points the Toolkit and the Server SDK at the sandbox", () => {
    expect(PAYPAL_SANDBOX_BASE).toBe("https://api-m.sandbox.paypal.com");
    const paypal = files.filter((f) => f.startsWith("server/paypal/"));
    expect(paypal.filter((f) => LIVE_SWITCH.test(read(f)))).toEqual([]);
    expect(read("server/paypal/toolkitRefund.ts")).toMatch(/context: \{ sandbox: true\b/);
    expect(read("server/paypal/sdkRefundRead.ts")).toMatch(/Environment\.Sandbox/);
  });

  it("would catch one", () => {
    expect(LIVE_HOST.test('fetch("https://api-m.paypal.com/v2")')).toBe(true);
    expect(LIVE_HOST.test("https://api.paypal.com")).toBe(true);
    expect(LIVE_HOST.test("https://api-m.sandbox.paypal.com")).toBe(false);
    expect(LIVE_SWITCH.test("context: { sandbox: false }")).toBe(true);
    expect(LIVE_SWITCH.test("environment: Environment.Production")).toBe(true);
    expect(PAYPAL_API.test('fetch("https://api-m.sandbox.paypal.com/v1")')).toBe(true);
    expect(PAYPAL_PACKAGE.test('import { Client } from "@paypal/paypal-server-sdk"')).toBe(true);
    // Imports of PayPal's code: require(), a deep path, an alias, and one reached through another module.
    const known = new Set(["server/agent/a.ts", "server/match/b.ts", "server/paypal/client.ts"]);
    const at = (file: string) => (f: string) => (f === "server/agent/a.ts" ? file : f === "server/match/b.ts" ? 'import { c } from "../paypal/client";' : "");
    expect(payPalReachedFrom("server/agent/a.ts", at('const c = require("../paypal/client");'), known)).toEqual(["server/paypal/client.ts"]);
    expect(payPalReachedFrom("server/agent/a.ts", at('import { c } from "../../server/paypal/client";'), known)).toEqual(["server/paypal/client.ts"]);
    expect(payPalReachedFrom("server/agent/a.ts", at('const m = await import("@/server/paypal/client");'), known)).toEqual(["server/paypal/client.ts"]);
    expect(payPalReachedFrom("server/agent/a.ts", at('import { b } from "../match/b";'), known)).toEqual(["server/paypal/client.ts"]);
    expect(payPalReachedFrom("server/agent/a.ts", at('import "../match/b";'), known)).toEqual(["server/paypal/client.ts"]);
    expect(payPalReachedFrom("server/agent/a.ts", at('// from "../paypal/client"\nconst x = 1;'), known)).toEqual([]);
  });
});
