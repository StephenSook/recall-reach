import { describe, expect, it } from "vitest";
import { chipsFor, coverageLine, needsApproval } from "./labels";

const row = (over: Partial<Parameters<typeof chipsFor>[0]> = {}) => ({
  verdict: "MATCH" as const,
  strength: "CONFIRMED" as const,
  salePath: "REFUND_ELIGIBLE" as const,
  joinState: "IDENTIFIED",
  isListing: false,
  stillListed: false,
  ...over,
});

describe("coverageLine", () => {
  const coverage = { recallsChecked: 934, searchedFrom: "2026-09-01", searchedTo: "2026-11-06", unidentifiedPayments: 2, paypalSearched: true, candidatesNotChecked: 0 };

  it("says what was searched when PayPal's history was really read", () => {
    expect(coverageLine(coverage)).toBe("Searched 2026-09-01 to 2026-11-06. 2 payments couldn't be identified. Checked 934 recalls.");
  });

  it("claims no search, dates or payment count when it was not", () => {
    const line = coverageLine({ ...coverage, paypalSearched: false });
    expect(line).toBe("PayPal's history was not searched. Checked 934 recalls.");
    expect(line).not.toMatch(/Searched|2026|identified/);
  });

  it("says when candidates were left unchecked, either way", () => {
    expect(coverageLine({ ...coverage, candidatesNotChecked: 3 })).toContain("3 candidates were not checked.");
    expect(coverageLine({ ...coverage, paypalSearched: false, candidatesNotChecked: 3 })).toContain("3 candidates were not checked.");
  });
});

describe("needsApproval", () => {
  const notice = (kind: string, state: "PREPARED" | "OPENED_IN_MAIL" | "MARKED_SENT" | "FAMILY_RESPONDED") => ({ id: "n", kind, state, stopped: false, result: null });

  it("asks for approval when nothing has been prepared", () => {
    expect(needsApproval({ verdict: "MATCH", notice: null })).toBe(true);
    expect(needsApproval({ verdict: "SCOPE_GAP", notice: null })).toBe(true);
  });

  it.each([
    ["MATCH", "SAFETY_NOTICE", "PREPARED", false],
    ["SCOPE_GAP", "CHECK_REQUEST", "OPENED_IN_MAIL", false],
    ["MATCH", "CHECK_REQUEST", "PREPARED", true],
    ["SCOPE_GAP", "SAFETY_NOTICE", "OPENED_IN_MAIL", true],
    ["MATCH", "CHECK_REQUEST", "MARKED_SENT", true],
    ["MATCH", "CHECK_REQUEST", "FAMILY_RESPONDED", true],
    ["SCOPE_GAP", "CHECK_REQUEST", "MARKED_SENT", false],
    ["MATCH", "SAFETY_NOTICE", "MARKED_SENT", false],
    ["SCOPE_GAP", "SAFETY_NOTICE", "MARKED_SENT", false],
  ] as const)("%s with a %s in state %s: %s", (verdict, kind, state, expected) => {
    expect(needsApproval({ verdict, notice: notice(kind, state) })).toBe(expected);
  });
});

describe("chipsFor", () => {
  it("shows the sale path on a confirmed match", () => {
    expect(chipsFor(row())).toEqual(["Needs review", "Refund eligible"]);
    expect(chipsFor(row({ salePath: "NOTICE_ONLY" }))).toEqual(["Needs review", "Notice only"]);
  });

  it("never claims a refund path on a scope gap: nothing is confirmed yet", () => {
    expect(chipsFor(row({ verdict: "SCOPE_GAP", strength: "BRAND" }))).toEqual(["Scope gap"]);
  });

  it("marks a match that rests on product words alone as that", () => {
    expect(chipsFor(row({ verdict: "SCOPE_GAP", strength: "PRODUCT_WORDS" }))).toEqual(["Scope gap", "Product words only"]);
  });

  it("carries the join state, and the shelf for a listing", () => {
    expect(chipsFor(row({ joinState: "AMBIGUOUS_JOIN" }))).toEqual(["Needs review", "Refund eligible", "Two possible orders"]);
    expect(chipsFor(row({ verdict: "SCOPE_GAP", strength: "BRAND", joinState: null, salePath: null, isListing: true, stillListed: true }))).toEqual(["Scope gap", "Pull from the shelf"]);
  });

  it("shows only that it is cleared on a cleared row", () => {
    expect(chipsFor(row({ verdict: "CLEARED", strength: "BRAND" }))).toEqual(["Cleared"]);
  });
});
