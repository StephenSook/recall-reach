import { describe, expect, it } from "vitest";
import { agentHeadline, chipClass, chipsFor, counted, coverageLine, needsApproval, paymentLine, queueCounts, stateChip, traceLine } from "./labels";

const row = (over: Partial<Parameters<typeof chipsFor>[0]> = {}) => ({
  verdict: "MATCH" as const,
  strength: "CONFIRMED" as const,
  salePath: "REFUND_ELIGIBLE" as const,
  joinState: "IDENTIFIED",
  isListing: false,
  stillListed: false,
  notice: null,
  refund: null,
  ...over,
});
const told = (state: "PREPARED" | "OPENED_IN_MAIL" | "MARKED_SENT" | "FAMILY_RESPONDED", kind = "SAFETY_NOTICE", result: string | null = null) => ({ id: "n", kind, state, stopped: false, result });
const refund = (status: string) => ({ id: "r", status, amountCents: 100, currency: "USD", failure: null });

describe("paymentLine", () => {
  it("says PayPal shows a payment when exactly one is linked to the sale", () => {
    expect(paymentLine(row())).toBe("PayPal's records show a payment for this sale.");
  });

  it.each(["AMBIGUOUS_JOIN", "HISTORY_UNAVAILABLE", "NO_PAYPAL_RECORD", null])("says nothing when the join is %s", (joinState) => {
    expect(paymentLine(row({ joinState }))).toBeNull();
  });

  it("says nothing about a listing or a cleared sale", () => {
    expect(paymentLine(row({ isListing: true }))).toBeNull();
    expect(paymentLine(row({ verdict: "CLEARED" }))).toBeNull();
  });
});

describe("counted", () => {
  it("says one thing for one", () => expect(counted(1, "Scope gap", "Scope gaps")).toBe("Scope gap"));
  it.each([0, 2])("says many for %d", (n) => expect(counted(n, "Scope gap", "Scope gaps")).toBe("Scope gaps"));
});

describe("queueCounts", () => {
  const card = (verdict: "MATCH" | "SCOPE_GAP") => ({ lead: { verdict } });

  it("counts what waits on the seller, and only what is on the page", () => {
    expect(queueCounts({ cards: [card("MATCH"), card("MATCH"), card("SCOPE_GAP")], cleared: [{}], unrelated: 6, recallsChecked: 934 })).toEqual({ recallsChecked: 934, matched: 2, scopeGaps: 1, cleared: 7, waiting: 3 });
  });

  it("shows no recall count when no check has run", () => {
    expect(queueCounts({ cards: [], cleared: [], unrelated: 0, recallsChecked: null })).toEqual({ recallsChecked: null, matched: 0, scopeGaps: 0, cleared: 0, waiting: 0 });
  });
});

describe("a sale after the recall, when the payment isn't known", () => {
  it("does not say a refund is possible", () => {
    const chips = chipsFor(row({ salePath: "REFUND_ELIGIBLE", joinState: "HISTORY_UNAVAILABLE" }));
    expect(chips).toContain("Sold after the recall");
    expect(chips).not.toContain("Refund eligible");
  });

  it("does say so once the payment is known", () => {
    expect(chipsFor(row({ salePath: "REFUND_ELIGIBLE", joinState: "IDENTIFIED" }))).toContain("Refund eligible");
  });
});

describe("chipClass", () => {
  it("gives refund eligible its own red, and every other chip the plain one", () => {
    expect(chipClass("Refund eligible")).toBe("chip chip-refund");
    expect(chipClass("Notice only")).toBe("chip");
    expect(chipClass("History unavailable")).toBe("chip");
  });
});

describe("how Claude checked it, in words", () => {
  it.each([
    [{ outcome: "FINDING", finding: "SAME_PRODUCT" }, "Claude: the words point to this product"],
    [{ outcome: "FINDING", finding: "CANT_TELL" }, "Claude: can't tell from the words"],
    [{ outcome: "FINDING", finding: "DIFFERENT_PRODUCT" }, "Claude: the words point to a different product"],
    [{ outcome: "NO_FINDING", finding: null }, "Claude gave no finding"],
    [{ outcome: "REFUSED", finding: null }, "Claude declined to answer"],
    [{ outcome: "STEP_LIMIT", finding: null }, "Claude stopped before a finding"],
  ])("%o reads as a plain headline", (run, text) => {
    expect(agentHeadline(run)).toBe(text);
  });

  it("never calls a product safe or not recalled", () => {
    for (const finding of ["SAME_PRODUCT", "CANT_TELL", "DIFFERENT_PRODUCT"]) expect(agentHeadline({ outcome: "FINDING", finding })).not.toMatch(/safe|not recalled|cleared/i);
  });

  it.each([
    [{ tool: "read_recall", ok: true }, "Read the recall"],
    [{ tool: "read_shop_item", ok: true, item: "Costway high chair" }, "Read Costway high chair"],
    [{ tool: "search_shop_items", ok: true, query: "high chair", found: 2 }, 'Searched your shop for "high chair": 2 found'],
    [{ tool: "record_finding", ok: true }, "Recorded its finding"],
    [{ tool: "record_finding", ok: false, note: "Include a quote from the item." }, "Sent back: Include a quote from the item."],
  ])("%o reads as one step", (step, text) => {
    expect(traceLine(step)).toBe(text);
  });
});

describe("coverageLine", () => {
  const coverage = { recallsChecked: 934, recallsFrom: null, recallsTo: null, recallYearsMissing: [] as number[], searchedFrom: "2026-09-01", searchedTo: "2026-11-06", unidentifiedPayments: 2, paypalSearched: true, candidatesNotChecked: 0, searchWindows: 3, failedWindows: 0 };

  it("says what was searched when PayPal's history was really read", () => {
    expect(coverageLine(coverage)).toBe("Searched 2026-09-01 to 2026-11-06. 2 payments couldn't be identified. Checked 934 recalls.");
  });

  it("says the real number and dates of the recalls it checked", () => {
    expect(coverageLine({ ...coverage, recallsChecked: 1855, recallsFrom: "2022-01-06", recallsTo: "2026-11-05", paypalSearched: false })).toBe(
      "PayPal's history was not searched. Checked 1,855 recalls, 2022-01-06 to 2026-11-05.",
    );
  });

  it("names a year that didn't load, so the dates can't hide a gap", () => {
    expect(coverageLine({ ...coverage, recallsChecked: 1531, recallsFrom: "2022-01-06", recallsTo: "2026-11-05", recallYearsMissing: [2023], paypalSearched: false })).toBe(
      "PayPal's history was not searched. Checked 1,531 recalls, 2022-01-06 to 2026-11-05. Recalls from 2023 did not fully load.",
    );
  });

  it("claims no search, dates or payment count when it was not", () => {
    const line = coverageLine({ ...coverage, paypalSearched: false });
    expect(line).toBe("PayPal's history was not searched. Checked 934 recalls.");
    expect(line).not.toMatch(/Searched|2026|identified/);
  });

  it("says one payment for one", () => {
    expect(coverageLine({ ...coverage, unidentifiedPayments: 1 })).toContain("1 payment couldn't be identified.");
  });

  it("says when only part of PayPal's history was read, and which part failed", () => {
    const line = coverageLine({ ...coverage, paypalSearched: false, failedWindows: 1 });
    expect(line).toBe("PayPal's history was only partly read: 1 of 3 searches failed. Checked 934 recalls.");
    expect(line).not.toMatch(/^Searched/);
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

describe("stateChip: what has happened on this row, not only what the check found", () => {
  it("says what the check found until anything has", () => {
    expect(stateChip(row())).toBe("Needs review");
    expect(stateChip(row({ verdict: "SCOPE_GAP" }))).toBe("Scope gap");
    expect(stateChip(row({ verdict: "CLEARED" }))).toBe("Cleared");
  });

  it.each([
    ["PREPARED", "Prepared"],
    ["OPENED_IN_MAIL", "Opened in mail"],
    ["MARKED_SENT", "You marked sent"],
    ["FAMILY_RESPONDED", "Family responded"],
  ] as const)("reads a notice's state: %s", (state, chip) => {
    expect(stateChip(row({ notice: told(state) }))).toBe(chip);
  });

  it.each([
    ["refunded", "Refunded"],
    ["pending", "Refund pending at PayPal"],
    ["unconfirmed", "Refund not confirmed"],
    ["reserved", "Refund not sent yet"],
    ["failed", "Refund failed"],
  ])("reads a refund's state ahead of a notice's: %s", (status, chip) => {
    expect(stateChip(row({ refund: refund(status), notice: told("MARKED_SENT") }))).toBe(chip);
  });

  it.each([
    ["MATCHES", "Family's answer matches"],
    ["DOESNT_MATCH", "Family's answer doesn't match"],
    ["CANT_TELL", "Family's answer didn't settle it"],
  ])("reads a family's answer to a question, and never calls it confirmed: %s", (result, chip) => {
    const said = stateChip(row({ verdict: "SCOPE_GAP", strength: "BRAND", notice: told("FAMILY_RESPONDED", "CHECK_REQUEST", result) }));
    expect(said).toBe(chip);
    expect(said).not.toMatch(/confirm/i);
  });

  it("goes back to needs review when a question has gone out and the recall has since been confirmed", () => {
    expect(stateChip(row({ notice: told("MARKED_SENT", "CHECK_REQUEST") }))).toBe("Needs review");
  });

  it("stays cleared whatever else it holds", () => {
    expect(stateChip(row({ verdict: "CLEARED", notice: told("MARKED_SENT") }))).toBe("Cleared");
  });
});

describe("chipsFor", () => {
  it("stops offering a refund once one is made or under way, and offers it again after one fails", () => {
    expect(chipsFor(row({ refund: refund("refunded") }))).toEqual(["Refunded"]);
    expect(chipsFor(row({ refund: refund("pending") }))).toEqual(["Refund pending at PayPal"]);
    expect(chipsFor(row({ refund: refund("failed") }))).toEqual(["Refund failed", "Refund eligible"]);
  });

  it("keeps saying a notice is all this sale gets, once it has gone", () => {
    expect(chipsFor(row({ salePath: "NOTICE_ONLY", notice: told("MARKED_SENT") }))).toEqual(["You marked sent", "Notice only"]);
  });

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
