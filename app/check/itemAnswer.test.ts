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
  sharesWords: false,
  reason: "r",
  missing: ["model number (CPSC lists BRZ0083)"],
  ...over,
});
const match = (over: Partial<TextCheckResult> = {}) => result({ verdict: "MATCH", strength: "CONFIRMED", missing: [], ...over });
const kindOnly = (recallNumber: string, sharesWords = true) => result({ recallNumber, strength: "PRODUCT_WORDS", tiedToRecall: false, sharesWords });
const answer = (over: Partial<TextCheckAnswer> = {}): TextCheckAnswer => ({
  results: [],
  more: 0,
  cleared: 0,
  notJudged: 0,
  mentioned: { recalls: [], total: 0 },
  checked: { recalls: 1855, from: "2022-01-03", to: "2026-11-05", yearsMissing: [] },
  note: "n",
  ...over,
});

const said = (given: TextCheckAnswer) => readItemAnswer(given, "Graco high chair");

describe("what one typed item's check says", () => {
  describe("when a recall names it", () => {
    it("says it matches, and that this doesn't say this one is recalled", () => {
      const answered = said(answer({ results: [match()] }));
      expect(answered.kind).toBe("MATCH");
      expect(answered.says).toBe("This matches a recall. That doesn't say this one is recalled: read it and compare the model.");
      expect(answered.matches.map((r) => r.recallNumber)).toEqual(["27072"]);
    });

    it("counts them when there's more than one", () => {
      expect(said(answer({ results: [match(), match({ recallNumber: "27073" })] })).says).toBe("This matches 2 recalls. That doesn't say this one is recalled: read them and compare the model.");
    });

    it("keeps a can't-tell recall apart from the match, and doesn't list the ones that only share a kind of product", () => {
      const answered = said(answer({ results: [match(), result({ recallNumber: "27040" }), kindOnly("1"), kindOnly("2")], more: 3 }));
      expect(answered.matches.map((r) => r.recallNumber)).toEqual(["27072"]);
      expect(answered.toRead.map((r) => r.recallNumber)).toEqual(["27040"]);
      expect(answered.further).toBe("5 more came up. Add the maker or model to narrow it.");
    });
  });

  describe("when it can't tell", () => {
    it("says so, names the recall to read, and what's missing", () => {
      const answered = said(answer({ results: [result()] }));
      expect(answered.kind).toBe("CANT_TELL");
      expect(answered.says).toBe("Can't tell yet. Read this recall and compare what you have.");
      expect(answered.matches).toEqual([]);
      expect(answered.toRead).toEqual([{ recallNumber: "27072", title: "Baby Brezza Recalls Dryers", missing: "model number (CPSC lists BRZ0083)" }]);
    });

    it("says these for more than one", () => {
      expect(said(answer({ results: [result(), result({ recallNumber: "27040" })] })).says).toBe("Can't tell yet. Read these recalls and compare what you have.");
    });

    it("cuts a long list of models short, between two of them", () => {
      const models = Array.from({ length: 40 }, (_, i) => `MODEL${i}`).join(", ");
      const { missing } = said(answer({ results: [result({ missing: [`model number (CPSC lists ${models})`] })] })).toRead[0];
      expect(missing?.length).toBeLessThan(170);
      expect(missing).toMatch(/MODEL\d+, and more\)$/);
    });

    it("counts the recalls that only have what was typed, and shows only the first few", () => {
      const answered = said(answer({ results: ["1", "2", "3", "4", "5", "6", "7"].map((n) => kindOnly(n)), more: 3, mentioned: { recalls: [{ recallNumber: "8", title: "t" }], total: 7 } }));
      expect(answered.kind).toBe("CANT_TELL");
      expect(answered.says).toBe("Can't tell yet. 17 recalls share words with this. Read them and compare what you have.");
      expect(answered.toRead).toHaveLength(5);
      expect(answered.further).toBe("12 more came up. Add the maker or model to narrow it.");
    });

    it("reads a single one in the singular", () => {
      expect(said(answer({ results: [kindOnly("1")] })).says).toBe("Can't tell yet. 1 recall shares words with this. Read it and compare what you have.");
    });

    it("never calls it nothing when CPSC's text has what was typed, whatever the rules ruled out", () => {
      const answered = said(answer({ cleared: 1, mentioned: { recalls: [{ recallNumber: "27072", title: "Baby Brezza Recalls Dryers" }], total: 1 } }));
      expect(answered.kind).toBe("CANT_TELL");
      expect(answered.says).toBe("Can't tell yet. 1 recall shares words with this. Read it and compare what you have.");
      expect(answered.toRead[0]).toEqual({ recallNumber: "27072", title: "Baby Brezza Recalls Dryers", missing: null });
    });

    it("lists the recalls the rules kept before the ones that only have the words", () => {
      const answered = said(answer({ results: [kindOnly("1")], mentioned: { recalls: [{ recallNumber: "2", title: "t" }], total: 1 } }));
      expect(answered.toRead.map((r) => r.recallNumber)).toEqual(["1", "2"]);
    });
  });

  describe("when recalls only share the kind of product, and don't have what else was typed", () => {
    const sameKind = (count: number) => Array.from({ length: count }, (_, i) => kindOnly(String(i + 1), false));

    it("leads with what it does know, and folds the recalls away", () => {
      const answered = said(answer({ results: sameKind(16) }));
      expect(answered.kind).toBe("NOT_NAMED");
      expect(answered.says).toBe('We didn\'t find a recall naming "Graco high chair" in 1,855 CPSC recalls since 2022. That doesn\'t mean it\'s safe.');
      expect(answered.sameKind).toBe("16 recalls of the same kind don't name it. If your label says one of their makers, read that recall.");
      expect(answered.toRead).toEqual([]);
      expect(answered.folded).toHaveLength(16);
    });

    it("doesn't ask what the recall's maker is, since the owner has said theirs", () => {
      for (const row of said(answer({ results: sameKind(2) })).folded) expect(row.missing).toBeNull();
    });

    it("counts the ones past the list", () => {
      const answered = said(answer({ results: sameKind(10), more: 6 }));
      expect(answered.sameKind).toContain("16 recalls of the same kind");
      expect(answered.folded).toHaveLength(10);
    });

    it("reads one in the singular", () => {
      expect(said(answer({ results: sameKind(1) })).sameKind).toBe("1 recall of the same kind doesn't name it. If your label says its maker, read that recall.");
    });

    it("counts a recall from the same maker as could be, whatever else the typing got wrong", () => {
      const answered = said(answer({ results: [...sameKind(3), result({ recallNumber: "25009", tiedToRecall: false, strength: "BRAND", missing: ["model number"] })] }));
      expect(answered.kind).toBe("CANT_TELL");
      expect(answered.toRead[0].recallNumber).toBe("25009");
    });

    it("goes back to can't tell as soon as one recall could be this item", () => {
      const answered = said(answer({ results: [...sameKind(3), kindOnly("9")] }));
      expect(answered.kind).toBe("CANT_TELL");
      expect(answered.says).toBe("Can't tell yet. 4 recalls share words with this. Read them and compare what you have.");
      expect(answered.toRead[0].recallNumber).toBe("9");
      expect(answered.folded).toEqual([]);
    });

    it("won't say no recall names it with a year of recalls missing, or some unread", () => {
      for (const given of [answer({ results: sameKind(3), notJudged: 2 }), answer({ results: sameKind(3), checked: { recalls: 1500, from: "2022-01-03", to: "2026-11-05", yearsMissing: [2023] } })]) {
        const answered = said(given);
        expect(answered.kind).toBe("CANT_TELL");
        expect(answered.says).not.toContain("We didn't find");
        expect(answered.gap).toBeTruthy();
      }
    });
  });

  describe("when nothing comes near", () => {
    it("says how many it read, from what year, and that this doesn't mean it's safe", () => {
      const answered = said(answer());
      expect(answered.kind).toBe("NOTHING");
      expect(answered.says).toBe('We didn\'t find a recall naming "Graco high chair" in 1,855 CPSC recalls since 2022. That doesn\'t mean it\'s safe.');
      expect(answered.sameKind).toBeNull();
    });

    it("takes the count and year from what was read, not from a fixed number", () => {
      expect(said(answer({ checked: { recalls: 55, from: "2026-10-01", to: "2026-11-05", yearsMissing: [] } })).says).toContain("in 55 CPSC recalls since 2026.");
    });

    it("isn't changed by recalls that only came near on a word", () => {
      expect(said(answer({ cleared: 4 })).kind).toBe("NOTHING");
    });
  });

  describe("when it couldn't finish, it never reads as nothing found", () => {
    it.each([
      ["no recalls are held", answer({ checked: { recalls: 0, from: null, to: null, yearsMissing: [] } }), "No recalls are held here right now."],
      ["a year of recalls is missing", answer({ checked: { recalls: 1500, from: "2022-01-03", to: "2026-11-05", yearsMissing: [2023, 2024] } }), "We don't hold CPSC's 2023 and 2024 recalls right now."],
      ["too many came near to read", answer({ notJudged: 40 }), "Too many recalls came near to read them all. Add the maker or model."],
    ])("%s", (_name, given, why) => {
      const answered = said(given);
      expect(answered.kind).toBe("UNFINISHED");
      expect(answered.says).toBe(`Can't say yet. ${why}`);
      expect(answered.says).not.toContain("We didn't find");
    });
  });

  describe("when it found something but read only part", () => {
    it("says a year is missing beside the results", () => {
      const answered = said(answer({ results: [match()], checked: { recalls: 1500, from: "2022-01-03", to: "2026-11-05", yearsMissing: [2023] } }));
      expect(answered.kind).toBe("MATCH");
      expect(answered.gap).toBe("We don't hold CPSC's 2023 recalls right now, so there may be more.");
    });

    it("says some weren't read", () => {
      expect(said(answer({ results: [result()], notJudged: 3 })).gap).toBe("More came near than we could read. Add the maker or model.");
    });
  });
});
