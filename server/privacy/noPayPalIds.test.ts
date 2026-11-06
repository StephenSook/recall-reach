// PayPal ids are PayPal's data, so a real one can't sit in the repo, not even a sandbox one used as a test value.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/** Clearly invented. A test that needs an id uses this one. */
const INVENTED = new Set(["9AB12345CD6789012"]);
const ID_SHAPE = /\b(?=[0-9A-Z]*\d)(?=[0-9A-Z]*[A-Z])[0-9A-Z]{17}\b/g;

// Public CPSC records and product titles: model codes there can have this shape, and none of it came from PayPal.
const NOT_PAYPAL = /^(eval\/|test\/fixtures\/|research\/|pnpm-lock\.yaml$)/;
const BINARY = /\.(png|jpe?g|gif|webp|ico|woff2?|ttf|mp4|pdf)$/i;

// Untracked files too, so a new file is caught before it is committed, not by the first CI run after.
const files = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "-z"], { encoding: "utf8" })
  .split("\0")
  .filter((name) => name && !NOT_PAYPAL.test(name) && !BINARY.test(name) && existsSync(name));

describe("the repo", () => {
  it("walks the real tree", () => {
    expect(files.length).toBeGreaterThan(100);
  });

  it("holds no PayPal id except the invented one", () => {
    const found = files.flatMap((name) => (readFileSync(name, "utf8").match(ID_SHAPE) ?? []).filter((id) => !INVENTED.has(id)).map((id) => `${name}: ${id}`));
    expect(found).toEqual([]);
  });
});
