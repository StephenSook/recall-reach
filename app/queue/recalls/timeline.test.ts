import { describe, expect, it } from "vitest";
import type { QueueRow } from "@/server/queue/queue";
import { REFUND_WINDOW_DAYS, timelineFor } from "./timeline";

const row = (over: Partial<QueueRow>) =>
  ({ matchId: "m1", recallNumber: "27027", recallTitle: "A recall", recallDate: "2026-10-15", itemTitle: "An item", orderedOn: "2026-11-06", salePath: "REFUND_ELIGIBLE", ...over }) as QueueRow;
const TODAY = "2026-11-06";

describe("timelineFor", () => {
  it("draws a sale's window as 180 days from the shop's own order date", () => {
    const t = timelineFor([row({})], "27027", TODAY);
    expect(REFUND_WINDOW_DAYS).toBe(180);
    expect(t?.sales[0]).toMatchObject({ orderedOn: "2026-11-06", windowEnds: "2027-05-05" });
  });

  it("carries the recall date and today, and leaves room for a date line's label on both ends of the axis", () => {
    const t = timelineFor([row({ orderedOn: "2026-09-15", salePath: "NOTICE_ONLY" })], "27027", TODAY);
    expect(t).toMatchObject({ recallDate: "2026-10-15", today: TODAY, from: "2026-08-11", to: "2027-04-18" });
  });

  it("makes room when the recall is the first date and today is the last", () => {
    const t = timelineFor([row({ recallDate: "2025-11-01", orderedOn: "2025-11-20" })], "27027", TODAY);
    expect(t).toMatchObject({ from: "2025-09-27", to: "2026-12-11" });
  });

  it("fits the axis to the width up to about a year, and past that lets it scroll, so its month labels still fit", () => {
    expect(timelineFor([row({})], "27027", TODAY)?.fits).toBe(true);
    expect(timelineFor([row({ recallDate: "2025-11-01", orderedOn: "2025-11-20" })], "27027", TODAY)?.fits).toBe(false);
  });

  it("only takes this recall's sales, oldest first", () => {
    const t = timelineFor(
      [row({ matchId: "new", orderedOn: "2026-11-01" }), row({ matchId: "other", recallNumber: "27072" }), row({ matchId: "old", orderedOn: "2026-10-20" })],
      "27027",
      TODAY,
    );
    expect(t?.sales.map((s) => s.id)).toEqual(["old", "new"]);
  });

  it("leaves a listing with no sale off the line", () => {
    const t = timelineFor([row({ matchId: "shelf", orderedOn: null, salePath: null }), row({ matchId: "sold" })], "27027", TODAY);
    expect(t?.sales.map((s) => s.id)).toEqual(["sold"]);
  });

  it("has nothing to draw when the shop has no sale of this recall", () => {
    expect(timelineFor([row({ orderedOn: null, salePath: null })], "27027", TODAY)).toBeNull();
    expect(timelineFor([row({})], "99999", TODAY)).toBeNull();
  });

  it.each([
    ["NOTICE_ONLY", "2026-09-15", "Sold before the recall: a notice, not a refund"],
    ["REVIEW", "2026-10-15", "Sold on the recall date: a person checks the date"],
    ["REFUND_ELIGIBLE", "2026-11-01", "Sold after the recall, and inside its 180 days"],
  ] as const)("says what %s means", (salePath, orderedOn, meaning) => {
    expect(timelineFor([row({ salePath, orderedOn })], "27027", TODAY)?.sales[0].meaning).toBe(meaning);
  });

  it("says so when a sale's 180 days are over", () => {
    expect(timelineFor([row({ orderedOn: "2026-01-01" })], "27027", TODAY)?.sales[0].meaning).toBe("Sold after the recall, and its 180 days are over");
  });
});
