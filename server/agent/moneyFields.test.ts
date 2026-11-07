import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { AGENT_TOOLS } from "./recallAgent";
import { QUESTION_TOOLS } from "./recallQuestion";

/** Claude can't ask for what it has no field for. Words that would let a model name, move or size money. */
const MONEY = /amount|currency|capture|refund|payee/i;

/** Every tool any model is offered, listed here. A new file defining a tool fails below until it's added. */
const TOOL_FILES = ["server/agent/recallAgent.ts", "server/agent/recallQuestion.ts"];

describe("what Claude's tools can say about money", () => {
  it.each([
    ["the check", AGENT_TOOLS],
    ["the question writer", QUESTION_TOOLS],
  ])("%s has no money field, name or description", (_name, tools) => {
    expect(tools.length).toBeGreaterThan(0);
    expect(JSON.stringify(tools)).not.toMatch(MONEY);
  });

  it("knows every file that defines a tool", () => {
    const files = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "server", "app", "scripts", "workflows"], { encoding: "utf8" })
      .split("\n")
      .filter((f) => /\.tsx?$/.test(f) && !/\.test\.tsx?$/.test(f));
    expect(files.length).toBeGreaterThan(100); // a scan of nothing would pass
    const defining = files.filter((f) => /\binput_schema\s*:/.test(readFileSync(f, "utf8")));
    expect(defining.sort()).toEqual(TOOL_FILES);
  });

  it("would catch one", () => {
    expect(JSON.stringify({ name: "send_refund", input_schema: { properties: { value: {} } } })).toMatch(MONEY);
    expect(JSON.stringify({ input_schema: { properties: { amount: {} } } })).toMatch(MONEY);
  });
});
