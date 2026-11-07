import { describe, expect, it } from "vitest";
import type { StudioRow } from "@/server/studio/dataset";
import { NONE_NEAR, toStudioRows } from "./rows";

const row = (itemTitle: string | null): StudioRow => ({
  recallNumber: "27076",
  recallTitle: "Magnetopia Recalls Magnetic Building Cubes",
  recallDate: "2026-11-05",
  recallYear: 2026,
  outcome: itemTitle ? "Matched" : "Nothing near",
  product: "Magnetic Building Cubes",
  itemTitle,
});

describe("the rows /studio shows", () => {
  it("says no shop item came near, instead of AG Studio's (Blanks)", () => {
    expect(toStudioRows([row(null)])[0].itemTitle).toBe(NONE_NEAR);
    expect(NONE_NEAR).toBe("None came near");
  });

  it("keeps everything else as it was", () => {
    const matched = row("Magnetopia building cubes, 64 pieces");
    expect(toStudioRows([matched])).toEqual([matched]);
  });
});
