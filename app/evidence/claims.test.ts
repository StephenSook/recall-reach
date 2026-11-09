import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { AG_GRID_CLAIMS, AG_STUDIO_CLAIMS, API_CLAIMS, CHANNEL3_CLAIMS, PAYPAL_CLAIMS, PAYPAL_SCREENS } from "./claims";

describe("the evidence pages", () => {
  it.each([...PAYPAL_CLAIMS, ...PAYPAL_SCREENS, ...AG_GRID_CLAIMS, ...AG_STUDIO_CLAIMS, ...API_CLAIMS, ...CHANNEL3_CLAIMS])("$file really has what it is credited with: $what", ({ file, find }) => {
    expect(readFileSync(file, "utf8")).toContain(find);
  });

  it("keeps AG Grid Enterprise to the queue and Recall Replay, and licensed there", () => {
    const pkg = JSON.parse(readFileSync("package.json", "utf8")) as { dependencies: Record<string, string> };
    expect(Object.keys(pkg.dependencies).filter((d) => d.startsWith("ag-grid")).sort()).toEqual(["ag-grid-community", "ag-grid-enterprise", "ag-grid-react"]);
    for (const file of ["app/queue/MatchGrid.tsx", "app/replay/ReplayGrid.tsx"]) expect(readFileSync(file, "utf8")).toContain("licenseGrid(licenseKey)");
    for (const file of ["app/eval/WrongPairsGrid.tsx", "app/gridSetup.ts"]) expect(readFileSync(file, "utf8")).not.toMatch(/ag-grid-enterprise|gridEnterprise/);
    // Registered on each grid, not globally: a global one would turn the eval page's grid into Enterprise after a client-side visit.
    expect(readFileSync("app/gridEnterprise.ts", "utf8")).not.toContain("registerModules");
    for (const file of ["app/queue/MatchGrid.tsx", "app/replay/ReplayGrid.tsx"]) expect(readFileSync(file, "utf8")).toContain("modules={ENTERPRISE_MODULES}");
  });
});
