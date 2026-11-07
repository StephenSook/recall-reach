// The sandbox disclosure, kept where a judge reads it first. A later edit that drops one of these fails here.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const read = (file: string) => readFileSync(file, "utf8");

describe("the sandbox disclosure", () => {
  it("is in the README: real sandbox payments, and sandbox-only money", () => {
    const readme = read("README.md");
    expect(readme).toContain("its payments are real PayPal sandbox payments");
    expect(readme).toContain("All money: sandbox only, nothing real moves");
  });

  it("is on the home page, beside the demo button", () => {
    expect(read("app/page.tsx")).toContain("Real CPSC recalls. Sandbox PayPal. Demo shop data is labelled.");
  });

  it("labels every demo shop's queue as sandbox and demo", () => {
    const queue = read("app/queue/page.tsx");
    expect(queue).toContain('shopKind === "DEMO" ? <span className="chip chip-sandbox">Sandbox PayPal</span>');
    expect(queue).toContain('{shopKind === "DEMO" ? "Demo shop" : "Real shop"}');
  });
});
