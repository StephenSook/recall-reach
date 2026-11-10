import { describe, expect, it } from "vitest";
import { salePath } from "@/server/match/verdict";
import { dayBefore, whatIfPaths } from "./whatIfRule";

const RECALL = "2026-11-05";
const SOLD = "2026-11-10";

describe("one changed fact: the sale date", () => {
  it("flips a sale after the recall from refund eligible to notice only when it moves before the recall", () => {
    expect(whatIfPaths(SOLD, "2026-11-04", RECALL)).toEqual({ original: "REFUND_ELIGIBLE", moved: "NOTICE_ONLY" });
  });

  it("leaves the original sale's verdict as it was, whatever date is tried", () => {
    for (const movedTo of ["2026-01-01", RECALL, "2026-12-31"]) expect(whatIfPaths(SOLD, movedTo, RECALL).original).toBe("REFUND_ELIGIBLE");
  });

  it("asks for a person when the sale lands on the recall's own date", () => {
    expect(whatIfPaths(SOLD, RECALL, RECALL).moved).toBe("REVIEW");
  });

  it("is the queue's own rule, not a copy of it", () => {
    for (const day of ["2026-11-04", RECALL, "2026-11-06"]) expect(whatIfPaths(SOLD, day, RECALL).moved).toBe(salePath(day, RECALL));
  });

  it("gives no verdict for a date that isn't a whole calendar date, as while the field is cleared or half typed", () => {
    for (const movedTo of ["", "2026-1", "2026-11-0", "2026-02-30", "2026-13-01", "not a date"]) expect(whatIfPaths(SOLD, movedTo, RECALL).moved).toBeNull();
    expect(whatIfPaths("2028-03-01", "2028-02-29", RECALL).moved).toBe("REFUND_ELIGIBLE");
  });

  it("gives no verdict for a date after today, even typed past the picker's limit", () => {
    expect(whatIfPaths(SOLD, "2026-11-11", RECALL).moved).toBeNull();
    expect(whatIfPaths(SOLD, "2030-01-01", RECALL).moved).toBeNull();
    expect(whatIfPaths(SOLD, SOLD, RECALL).moved).toBe("REFUND_ELIGIBLE");
  });

  it("starts the tried date on the day before the recall, across a month and a year", () => {
    expect(dayBefore(RECALL)).toBe("2026-11-04");
    expect(dayBefore("2026-03-01")).toBe("2026-02-28");
    expect(dayBefore("2026-01-01")).toBe("2025-12-31");
  });
});
