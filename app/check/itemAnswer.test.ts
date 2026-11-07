import { describe, expect, it } from "vitest";
import type { TextCheckAnswer, TextCheckResult } from "@/server/match/textCheck";
import { readItemAnswer } from "./itemAnswer";

const result = (over: Partial<TextCheckResult> = {}): TextCheckResult => ({
  recallNumber: "27072",
  title: "Baby Brezza Recalls Dryers",
  recallDate: "2026-11-05",
  url: null,
  verdict: "SCOPE_GAP",
  strength: "BRAND",
  tiedToRecall: true,
  reason: "r",
  missing: ["model number (CPSC lists BRZ0083)"],
  ...over,
});
const match = (over: Partial<TextCheckResult> = {}) => result({ verdict: "MATCH", strength: "CONFIRMED", missing: [], ...over });
const kindOnly = (recallNumber: string) => result({ recallNumber, strength: "PRODUCT_WORDS", tiedToRecall: false });
const answer = (over: Partial<TextCheckAnswer> = {}): TextCheckAnswer => ({
  results: [],
  more: 0,
  cleared: 0,
  notJudged: 0,
  sameMaker: [],
  checked: { recalls: 1855, from: "2022-01-03", to: "2026-11-05", yearsMissing: [] },
  note: "n",
  ...over,
});

describe("what one typed item's check says", () => {
  describe("when a recall names it", () => {
    it("says it matches, and that this doesn't say this one is recalled", () => {
      const said = readItemAnswer(answer({ results: [match()] }));
      expect(said.kind).toBe("MATCH");
      expect(said.says).toBe("This matches a recall. That doesn't say this one is recalled: read it and compare the model.");
      expect(said.matches.map((r) => r.recallNumber)).toEqual(["27072"]);
    });

    it("counts them when there's more than one", () => {
      expect(readItemAnswer(answer({ results: [match(), match({ recallNumber: "27073" })] })).says).toBe("This matches 2 recalls. That doesn't say this one is recalled: read them and compare the model.");
    });

    it("keeps a can't-tell recall apart from the match, and doesn't list the ones that only share a kind of product", () => {
      const said = readItemAnswer(answer({ results: [match(), result({ recallNumber: "27040" }), kindOnly("1"), kindOnly("2")], more: 3 }));
      expect(said.matches.map((r) => r.recallNumber)).toEqual(["27072"]);
      expect(said.toRead.map((r) => r.recallNumber)).toEqual(["27040"]);
      expect(said.further).toBe("5 more came up. Add the maker or model to narrow it.");
    });
  });

  describe("when it can't tell", () => {
    it("says so, names the recall to read, and what's missing", () => {
      const said = readItemAnswer(answer({ results: [result()] }));
      expect(said.kind).toBe("CANT_TELL");
      expect(said.says).toBe("Can't tell yet. Read this recall and compare what you have.");
      expect(said.matches).toEqual([]);
      expect(said.toRead).toEqual([{ recallNumber: "27072", title: "Baby Brezza Recalls Dryers", missing: "model number (CPSC lists BRZ0083)" }]);
    });

    it("says these for more than one", () => {
      expect(readItemAnswer(answer({ results: [result(), result({ recallNumber: "27040" })] })).says).toBe("Can't tell yet. Read these recalls and compare what you have.");
    });

    it("cuts a long list of models short, between two of them", () => {
      const models = Array.from({ length: 40 }, (_, i) => `MODEL${i}`).join(", ");
      const { missing } = readItemAnswer(answer({ results: [result({ missing: [`model number (CPSC lists ${models})`] })] })).toRead[0];
      expect(missing?.length).toBeLessThan(170);
      expect(missing).toMatch(/MODEL\d+, and more\)$/);
    });

    it("counts a whole kind of product, and shows only the first few", () => {
      const said = readItemAnswer(answer({ results: ["1", "2", "3", "4", "5", "6", "7"].map(kindOnly), more: 10 }));
      expect(said.kind).toBe("CANT_TELL");
      expect(said.says).toBe("Can't tell yet. 17 recalls cover this kind of product. Add the maker and model, or read them.");
      expect(said.toRead).toHaveLength(5);
      expect(said.further).toBe("12 more came up. Add the maker or model to narrow it.");
    });

    it("reads a single recall of that kind in the singular", () => {
      expect(readItemAnswer(answer({ results: [kindOnly("1")] })).says).toBe("Can't tell yet. 1 recall covers this kind of product. Add the maker and model, or read it.");
    });

    it("never calls a recall from the same maker nothing, whatever the rules ruled out", () => {
      const said = readItemAnswer(answer({ cleared: 1, sameMaker: [{ recallNumber: "27072", title: "Baby Brezza Recalls Dryers" }] }));
      expect(said.kind).toBe("CANT_TELL");
      expect(said.says).toBe("Can't tell yet. The maker matches, and nothing else does. Read this recall and compare what you have.");
      expect(said.toRead[0].recallNumber).toBe("27072");
      expect(said.says).not.toContain("No recall");
    });
  });

  describe("when nothing comes near", () => {
    it("says how many it read, from what year, and that this doesn't mean it's safe", () => {
      const said = readItemAnswer(answer());
      expect(said.kind).toBe("NOTHING");
      expect(said.says).toBe("No recall in 1,855 CPSC recalls since 2022 names this. That doesn't mean it's safe.");
    });

    it("takes the count and year from what was read, not from a fixed number", () => {
      expect(readItemAnswer(answer({ checked: { recalls: 55, from: "2026-10-01", to: "2026-11-05", yearsMissing: [] } })).says).toContain("No recall in 55 CPSC recalls since 2026 names this.");
    });

    it("isn't changed by recalls that only came near on a word", () => {
      expect(readItemAnswer(answer({ cleared: 4 })).kind).toBe("NOTHING");
    });
  });

  describe("when it couldn't finish, it never reads as nothing found", () => {
    it.each([
      ["no recalls are held", answer({ checked: { recalls: 0, from: null, to: null, yearsMissing: [] } }), "No recalls are held here right now."],
      ["a year of recalls is missing", answer({ checked: { recalls: 1500, from: "2022-01-03", to: "2026-11-05", yearsMissing: [2023, 2024] } }), "We don't hold CPSC's 2023 and 2024 recalls right now."],
      ["too many came near to read", answer({ notJudged: 40 }), "Too many recalls came near to read them all. Add the maker or model."],
    ])("%s", (_name, given, why) => {
      const said = readItemAnswer(given);
      expect(said.kind).toBe("UNFINISHED");
      expect(said.says).toBe(`Can't say yet. ${why}`);
      expect(said.says).not.toContain("No recall in");
    });
  });

  describe("when it found something but read only part", () => {
    it("says a year is missing beside the results", () => {
      const said = readItemAnswer(answer({ results: [match()], checked: { recalls: 1500, from: "2022-01-03", to: "2026-11-05", yearsMissing: [2023] } }));
      expect(said.kind).toBe("MATCH");
      expect(said.gap).toBe("We don't hold CPSC's 2023 recalls right now, so there may be more.");
    });

    it("says some weren't read", () => {
      expect(readItemAnswer(answer({ results: [result()], notJudged: 3 })).gap).toBe("More came near than we could read. Add the maker or model.");
    });
  });
});
