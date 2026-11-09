import { describe, expect, it } from "vitest";
import type { QueueRow } from "@/server/queue/queue";
import { isStillToReach, REFUND_WINDOW_DAYS, timelineFor } from "./timeline";

const row = (over: Partial<QueueRow>) =>
  ({ matchId: "m1", recallNumber: "27027", recallTitle: "A recall", recallDate: "2026-10-15", itemTitle: "An item", orderedOn: "2026-11-06", salePath: "REFUND_ELIGIBLE", verdict: "MATCH", strength: "CONFIRMED", isListing: false, joinState: "IDENTIFIED", refund: null, ...over }) as QueueRow;
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
    expect(timelineFor([row({ orderedOn: "2026-05-11" })], "27027", TODAY)?.fits).toBe(true);
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

  it("answers for a queue card the same way as for the timeline", () => {
    expect(isStillToReach(row({}))).toBe(true);
    expect(isStillToReach(row({ refund: { id: "r", status: "refunded", amountCents: 1, currency: "USD", failure: null } }))).toBe(false);
  });

  describe("whether a sale still needs its family reached", () => {
    const reach = (over: Partial<QueueRow>) => timelineFor([row(over)], "27027", TODAY)?.sales[0].needsReaching;
    const notice = (state: string, stopped = false) => ({ id: "n", kind: "SAFETY", state, stopped, passedOn: false, result: null, daysSinceSent: null, secondDue: false }) as unknown as QueueRow["notice"];

    it("does when no notice has been written", () => {
      expect(reach({})).toBe(true);
    });

    it.each(["PREPARED", "OPENED_IN_MAIL", "MARKED_SENT"])("does when the notice is at %s, with no answer yet", (state) => {
      expect(reach({ notice: notice(state) })).toBe(true);
    });

    it("doesn't once the family has answered", () => {
      expect(reach({ notice: notice("FAMILY_RESPONDED") })).toBe(false);
    });

    it("doesn't once the family has asked for no more", () => {
      expect(reach({ notice: notice("MARKED_SENT", true) })).toBe(false);
    });

    it("doesn't while a refund is under way or done", () => {
      expect(reach({ refund: { id: "r", status: "refunded", amountCents: 100, currency: "USD", failure: null } })).toBe(false);
    });

    it("does after a refund failed, because the family still hasn't been helped", () => {
      expect(reach({ refund: { id: "r", status: "failed", amountCents: 100, currency: "USD", failure: "no" } })).toBe(true);
    });

    it.each([
      ["a match nobody has confirmed", { verdict: "SCOPE_GAP" as const }],
      ["a sale made on the recall date", { salePath: "REVIEW" as const }],
      ["a sale that could be either of two payments", { joinState: "AMBIGUOUS_JOIN" }],
    ])("doesn't for %s, which a person looks at first", (_name, over) => {
      expect(reach(over)).toBe(false);
    });
  });

  it("leaves a listing with no sale off the line", () => {
    const t = timelineFor([row({ matchId: "shelf", orderedOn: null, salePath: null }), row({ matchId: "sold" })], "27027", TODAY);
    expect(t?.sales.map((s) => s.id)).toEqual(["sold"]);
  });

  it("takes a cleared sale off the line: it gets no notice and no refund", () => {
    const t = timelineFor([row({ matchId: "near-miss", verdict: "CLEARED", salePath: "NOTICE_ONLY" }), row({ matchId: "real" })], "27027", TODAY);
    expect(t?.sales.map((s) => s.id)).toEqual(["real"]);
    expect(timelineFor([row({ verdict: "CLEARED" })], "27027", TODAY)).toBeNull();
  });

  it("takes a listing off the line, even with a date", () => {
    expect(timelineFor([row({ isListing: true, salePath: null })], "27027", TODAY)).toBeNull();
    expect(timelineFor([row({ isListing: true })], "27027", TODAY)).toBeNull();
  });

  it("has nothing to draw when the shop has no sale of this recall", () => {
    expect(timelineFor([row({ orderedOn: null, salePath: null })], "27027", TODAY)).toBeNull();
    expect(timelineFor([row({})], "99999", TODAY)).toBeNull();
  });

  it.each([
    ["NOTICE_ONLY", "2026-09-15", "Sold before the recall: a notice, not a refund"],
    ["REVIEW", "2026-10-15", "Sold on the recall date: a person checks the date"],
    ["REFUND_ELIGIBLE", "2026-11-01", "Sold after the recall, within 180 days of its order date"],
  ] as const)("says what %s means", (salePath, orderedOn, meaning) => {
    expect(timelineFor([row({ salePath, orderedOn })], "27027", TODAY)?.sales[0].meaning).toBe(meaning);
  });

  it("says which date it counted from, and reads as a refund only inside it", () => {
    const inside = timelineFor([row({ orderedOn: "2026-05-11" })], "27027", TODAY)?.sales[0];
    expect(inside).toMatchObject({ tone: "refund", meaning: "Sold after the recall, within 180 days of its order date" });
  });

  it("on its last day by order date, leaves the answer to PayPal's date, because the gate counts by the hour", () => {
    expect(timelineFor([row({ orderedOn: "2026-05-10" })], "27027", TODAY)?.sales[0]).toMatchObject({
      tone: "refund",
      meaning: "Sold after the recall, on day 180 from its order date: PayPal's date decides",
    });
  });

  it("doesn't read as a refund after that", () => {
    expect(timelineFor([row({ orderedOn: "2026-05-09" })], "27027", TODAY)?.sales[0]).toMatchObject({
      tone: "notice",
      meaning: "Sold after the recall, and 180 days from its order date have passed",
    });
  });

  it.each([
    ["a scope gap", { verdict: "SCOPE_GAP" }],
    ["a match on product words", { strength: "PRODUCT_WORDS" }],
    ["a match on the brand alone", { strength: "BRAND" }],
  ] as const)("says %s isn't a confirmed match, whatever its dates say, and stays true once a family has answered", (_about, over) => {
    for (const salePath of ["NOTICE_ONLY", "REVIEW", "REFUND_ELIGIBLE"] as const) {
      expect(timelineFor([row({ salePath, ...over })], "27027", TODAY)?.sales[0]).toMatchObject({ tone: "check", meaning: "Not a confirmed match: see its card" });
    }
  });

  it("uses the card's own words for a payment that could be either of two sales", () => {
    for (const salePath of ["NOTICE_ONLY", "REVIEW", "REFUND_ELIGIBLE"] as const) {
      expect(timelineFor([row({ salePath, joinState: "AMBIGUOUS_JOIN" })], "27027", TODAY)?.sales[0]).toMatchObject({ tone: "check", meaning: "Two possible orders: see its card" });
    }
  });

  it.each(["HISTORY_UNAVAILABLE", "NO_PAYPAL_RECORD", null])("doesn't read as a refund with no payment to refund: %s", (joinState) => {
    expect(timelineFor([row({ joinState })], "27027", TODAY)?.sales[0]).toMatchObject({ tone: "notice", meaning: "Sold after the recall, with no PayPal payment linked" });
  });

  it("still says sold before the recall with no payment linked: that needs none", () => {
    expect(timelineFor([row({ salePath: "NOTICE_ONLY", joinState: "NO_PAYPAL_RECORD" })], "27027", TODAY)?.sales[0].meaning).toBe("Sold before the recall: a notice, not a refund");
  });

  describe("a sale that already has a refund", () => {
    const refund = (status: string) => ({ id: "r1", status, amountCents: 100, currency: "USD", failure: null });

    it("says it was refunded, and isn't offered again", () => {
      expect(timelineFor([row({ refund: refund("refunded") })], "27027", TODAY)?.sales[0]).toMatchObject({ tone: "notice", meaning: "Refunded: see its card" });
    });

    it.each([
      ["reserved", "Refund not sent yet: see its card"],
      ["pending", "Refund pending at PayPal: see its card"],
      ["unconfirmed", "Refund not confirmed: see its card"],
    ])("says so in the card's words while it is %s", (status, meaning) => {
      expect(timelineFor([row({ refund: refund(status) })], "27027", TODAY)?.sales[0]).toMatchObject({ tone: "check", meaning });
    });

    it("goes back to its dates after a failed one, which can be tried again", () => {
      expect(timelineFor([row({ refund: refund("failed") })], "27027", TODAY)?.sales[0].tone).toBe("refund");
    });

    it("says so even if the recall has since changed what its match says", () => {
      expect(timelineFor([row({ verdict: "SCOPE_GAP", refund: refund("refunded") })], "27027", TODAY)?.sales[0].meaning).toBe("Refunded: see its card");
    });
  });

  it.each([
    ["NOTICE_ONLY", "notice"],
    ["REVIEW", "check"],
    ["REFUND_ELIGIBLE", "refund"],
  ] as const)("colors a confirmed %s sale as %s", (salePath, tone) => {
    expect(timelineFor([row({ salePath })], "27027", TODAY)?.sales[0].tone).toBe(tone);
  });
});
