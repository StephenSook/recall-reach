import { describe, expect, it } from "vitest";
import { matchSplitLine, ranAt, replayGap, replayIntro } from "./labels";

const match = (saleSplit: "NOTICE_ONLY" | "REVIEW" | "REFUND_ELIGIBLE" | null) => ({ outcome: "MATCH" as const, saleSplit });

describe("ranAt", () => {
  it("says when, on the US calendar every other date here uses, in plain spaces", () => {
    expect(ranAt("2026-11-06T06:44:15Z")).toBe("Nov 6, 2026, 1:44 AM ET");
  });
});

describe("what a run says it covered", () => {
  it("says every recall only when every year loaded", () => {
    expect(replayIntro([])).toBe("Every real CPSC recall from 2025 on, checked against the demo shop in one run.");
    expect(replayGap([])).toBeNull();
  });

  it("names the years that didn't load, and doesn't say every", () => {
    expect(replayIntro([2025])).not.toContain("Every");
    expect(replayGap([2025])).toBe("Recalls from 2025 did not fully load, so this run may not cover them.");
    expect(replayGap([2025, 2026])).toBe("Recalls from 2025, 2026 did not fully load, so this run may not cover them.");
  });
});

describe("matchSplitLine", () => {
  it("accounts for every recall matched, in the same unit as the count beside it", () => {
    expect(matchSplitLine([match("NOTICE_ONLY"), match("REFUND_ELIGIBLE"), match(null)])).toBe(
      "Of the 3 recalls matched, 1 has a sale before the recall and needs a notice, 1 has a sale after it that can be refunded, and 1 has a listing with no sale.",
    );
  });

  it("uses the plural for more than one", () => {
    expect(matchSplitLine([match("NOTICE_ONLY"), match("NOTICE_ONLY"), match("REFUND_ELIGIBLE"), match("REFUND_ELIGIBLE"), match(null), match(null)])).toBe(
      "Of the 6 recalls matched, 2 have a sale before the recall and need a notice, 2 have a sale after it that can be refunded, and 2 have a listing with no sale.",
    );
  });

  it("names a sale on the recall date, which is neither side of it", () => {
    expect(matchSplitLine([match("REVIEW"), match("REFUND_ELIGIBLE")])).toBe("Of the 2 recalls matched, 1 has a sale after it that can be refunded, and 1 has a sale on the recall date and needs a look.");
  });

  it("reads plainly for one", () => {
    expect(matchSplitLine([match("NOTICE_ONLY")])).toBe("The 1 recall matched has a sale before the recall and needs a notice.");
  });

  it("ignores anything that isn't a match, and says so when nothing matched", () => {
    expect(matchSplitLine([{ outcome: "SCOPE_GAP", saleSplit: null }])).toBe("No recalls matched.");
  });
});
