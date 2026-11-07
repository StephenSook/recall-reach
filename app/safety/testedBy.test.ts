import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { TESTED_BY } from "./testedBy";

const attackIds = [...readFileSync("server/safety/attacks.ts", "utf8").matchAll(/\{ id: "([a-z0-9-]+)", title:/g)].map((m) => m[1]);

describe("the named test behind each safety check", () => {
  it("covers every check the page runs, and only those", () => {
    expect(attackIds.length).toBeGreaterThanOrEqual(5);
    expect(Object.keys(TESTED_BY).sort()).toEqual([...attackIds].sort());
  });

  it.each(Object.entries(TESTED_BY))("%s names a test that exists", (_id, { file, test }) => {
    expect(readFileSync(file, "utf8")).toContain(`it("${test}"`);
  });
});
