import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseRecalls } from "./schema";

// Real CPSC API response for RecallDate 2026-10-01 to 2026-11-05 (55 recalls), saved 2026-11-05.
const fixture: unknown[] = JSON.parse(
  readFileSync(new URL("../../test/fixtures/cpsc/recalls_2026-10-01_to_2026-11-05.json", import.meta.url), "utf8"),
);

function copyOf<T>(value: T): T {
  return JSON.parse(JSON.stringify(value));
}

describe("parseRecalls", () => {
  it("accepts every record in the real CPSC fixture", () => {
    const result = parseRecalls(fixture);
    expect(result.invalid).toEqual([]);
    expect(result.valid).toHaveLength(55);
  });

  it("maps the fields we use from a real record", () => {
    const { valid } = parseRecalls(fixture);
    const arlopu = valid.find((v) => v.recall.recallId === 11045);
    expect(arlopu?.recall).toMatchObject({
      recallId: 11045,
      recallNumber: "27066",
      recallDate: "2026-11-05",
      lastPublishDate: "2026-11-05T00:00:00",
      title: "Arlopu Recalls Slide Playsets Due to Risk of Serious Injury and Death from Head and Neck Entrapment Hazards",
      url: "https://cpsc.gov/Recalls/2027/Arlopu-Recalls-Slide-Playsets-Due-to-Risk-of-Serious-Injury-and-Death-from-Head-and-Neck-Entrapment-Hazards",
      products: [{ name: "Arlopu Slide Playsets", model: "", type: "Slides or Sliding Boards", units: "About 10,318" }],
      remedyOptions: ["Repair"],
    });
    expect(arlopu?.recall.description).toMatch(/^This recall involves Arlopu Slide Playsets with model numbers KT-CS17 and LY-31\./);
    expect(arlopu?.recall.hazards).toHaveLength(1);
    expect(arlopu?.recall.remedies[0]).toMatch(/^Consumers should stop using the Arlopu Slide Playsets immediately/);
    expect(arlopu?.recall.retailers).toEqual([
      "Sold Online At:\nAmazon.com and Walmart.com from April 2023 through August 2026 for between $90 and $130.",
    ]);
    expect(arlopu?.recall.images.map((i) => i.caption)).toEqual([
      "Recalled Arlopu Slide Playset, Model KT-CS17",
      "Recalled Arlopu Slide Playset, Model LY-31",
    ]);
  });

  it("keeps the original record untouched as raw", () => {
    const { valid } = parseRecalls(fixture);
    expect(valid[0].raw).toEqual(fixture[0]);
  });

  it("reports a record with no RecallID as invalid and still returns the others", () => {
    const records = copyOf(fixture.slice(0, 3)) as Record<string, unknown>[];
    delete records[1].RecallID;
    const result = parseRecalls(records);
    expect(result.valid).toHaveLength(2);
    expect(result.invalid).toHaveLength(1);
    expect(result.invalid[0]).toMatchObject({ index: 1, recallId: null });
    expect(result.invalid[0].issues.join(" ")).toMatch(/RecallID/);
  });

  it("reports an impossible calendar date as invalid, with its RecallID", () => {
    const records = copyOf(fixture.slice(0, 1)) as Record<string, unknown>[];
    records[0].RecallDate = "2026-02-30T00:00:00";
    const result = parseRecalls(records);
    expect(result.valid).toHaveLength(0);
    expect(result.invalid[0]).toMatchObject({ index: 0, recallId: records[0].RecallID });
    expect(result.invalid[0].issues.join(" ")).toMatch(/RecallDate/);
  });

  it("reports a product with a non-string Model as invalid", () => {
    const records = copyOf(fixture.slice(0, 1)) as { Products: Record<string, unknown>[] }[];
    records[0].Products[0].Model = 42;
    const result = parseRecalls(records);
    expect(result.invalid[0].issues.join(" ")).toMatch(/Products\.0\.Model/);
  });

  it("throws when the payload is not a JSON array", () => {
    expect(() => parseRecalls({ error: "nope" })).toThrow(/array/);
    expect(() => parseRecalls("<html>challenge</html>")).toThrow(/array/);
  });
});
