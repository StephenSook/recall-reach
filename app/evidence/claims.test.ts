import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { AG_GRID_CLAIMS, AG_STUDIO_CLAIMS, API_CLAIMS, CHANNEL3_CLAIMS, PAYPAL_CLAIMS, PAYPAL_SCREENS } from "./claims";

describe("the evidence pages", () => {
  it.each([...PAYPAL_CLAIMS, ...PAYPAL_SCREENS, ...AG_GRID_CLAIMS, ...AG_STUDIO_CLAIMS, ...API_CLAIMS, ...CHANNEL3_CLAIMS])("$file really has what it is credited with: $what", ({ file, find }) => {
    expect(readFileSync(file, "utf8")).toContain(find);
  });

  it("uses AG Grid's free edition only, so a page can't show a license watermark", () => {
    const pkg = JSON.parse(readFileSync("package.json", "utf8")) as { dependencies: Record<string, string> };
    expect(Object.keys(pkg.dependencies).filter((d) => d.startsWith("ag-grid")).sort()).toEqual(["ag-grid-community", "ag-grid-react"]);
  });
});
