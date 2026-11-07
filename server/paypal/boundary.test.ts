import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const files = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "server", "app", "scripts", "workflows", "instrumentation.ts", "next.config.ts"], { encoding: "utf8" })
  .split("\n")
  .filter((f) => /\.(ts|tsx|mjs|js)$/.test(f) && !/\.test\.tsx?$/.test(f));
const read = (f: string) => readFileSync(f, "utf8");

const PAYPAL_API = /api-m\.(sandbox\.)?paypal\.com/;
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

  it("would catch one", () => {
    expect(PAYPAL_API.test('fetch("https://api-m.sandbox.paypal.com/v1")')).toBe(true);
    expect(PAYPAL_PACKAGE.test('import { Client } from "@paypal/paypal-server-sdk"')).toBe(true);
    expect(FROM_PAYPAL_CODE.test('import { x } from "../paypal/client"')).toBe(true);
  });
});
