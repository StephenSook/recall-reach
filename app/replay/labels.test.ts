import { describe, expect, it } from "vitest";
import { matchSplitLine } from "./labels";

const match = (saleSplit: "NOTICE_ONLY" | "REVIEW" | "REFUND_ELIGIBLE" | null) => ({ outcome: "MATCH" as const, saleSplit });

describe("matchSplitLine", () => {
  it("accounts for every match, so the split adds up to the count beside it", () => {
    expect(matchSplitLine([match("NOTICE_ONLY"), match("REFUND_ELIGIBLE"), match(null)])).toBe(
      "Of the 3 matches, 1 sold before the recall and needs a notice, 1 sold after it and can be refunded, and 1 is still listed and has not been sold.",
    );
  });

  it("uses the plural for more than one", () => {
    expect(matchSplitLine([match("NOTICE_ONLY"), match("NOTICE_ONLY"), match(null), match(null)])).toBe(
      "Of the 4 matches, 2 sold before the recall and need a notice, and 2 are still listed and have not been sold.",
    );
  });

  it("names a sale on the recall date, which is neither side of it", () => {
    expect(matchSplitLine([match("REVIEW"), match("REFUND_ELIGIBLE")])).toBe("Of the 2 matches, 1 sold after it and can be refunded, and 1 sold on the recall date and needs a look.");
  });

  it("says it plainly for one match, with no list", () => {
    expect(matchSplitLine([match("NOTICE_ONLY")])).toBe("Of the 1 match, 1 sold before the recall and needs a notice.");
  });

  it("ignores anything that isn't a match, and says so when nothing matched", () => {
    expect(matchSplitLine([{ outcome: "SCOPE_GAP", saleSplit: null }])).toBe("Nothing matched.");
  });
});
