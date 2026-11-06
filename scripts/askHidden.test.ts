import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { askHidden } from "./askHidden";

describe("askHidden", () => {
  it("returns what was typed, and never writes it where it can be seen", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const shown: string[] = [];
    output.on("data", (chunk) => shown.push(String(chunk)));
    const answer = askHidden("Database URL: ", input, output);
    input.write("postgresql://user:secret-value@host/db\n");
    expect(await answer).toBe("postgresql://user:secret-value@host/db");
    expect(shown.join("")).toContain("Database URL: ");
    expect(shown.join("")).not.toContain("secret-value");
  });
});
