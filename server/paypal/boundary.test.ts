import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
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
const FROM_PAYPAL_CODE = /from\s+["'](?:\.\.\/paypal|@\/server\/paypal)\b|import\(["'](?:\.\.\/paypal|@\/server\/paypal)\b/;

const outsidePayPal = (pattern: RegExp) => files.filter((f) => !f.startsWith("server/paypal/") && pattern.test(read(f)));

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

  it("gives Claude's code no way to PayPal's", () => {
    const agent = files.filter((f) => f.startsWith("server/agent/"));
    expect(agent.length).toBeGreaterThan(3);
    expect(agent.filter((f) => FROM_PAYPAL_CODE.test(read(f)))).toEqual([]);
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
    expect(FROM_PAYPAL_CODE.test('import { x } from "../paypal/client"')).toBe(true);
  });
});
