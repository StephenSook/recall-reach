import { describe, expect, it } from "vitest";
import { agentHeadline, chipClass, chipsFor, counted, coverageLine, listingCounts, listingCoverageLine, needsApproval, pathNow, paymentLine, queueCounts, refundOnOffer, saleWaits, splitCounts, stateChip, traceLine, waitsOnSeller } from "./labels";

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
  const card = (verdict: "MATCH" | "SCOPE_GAP") => ({ lead: row({ verdict, salePath: "NOTICE_ONLY" }), also: [] });

  it("counts what the check found in the tiles, and only what still waits in the wait count", () => {
    const cards = [card("MATCH"), card("SCOPE_GAP"), { lead: row({ salePath: "NOTICE_ONLY", notice: told("MARKED_SENT") }), also: [] }];
    expect(queueCounts({ cards, cleared: [], unrelated: 0, recallsChecked: 934 })).toEqual({ recallsChecked: 934, matched: 2, scopeGaps: 1, cleared: 0, waiting: 2 });
  });

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

  it.each([
    ["two possible orders", { joinState: "AMBIGUOUS_JOIN" }],
    ["no record at PayPal", { joinState: "NO_PAYPAL_RECORD" }],
    ["no search of PayPal", { joinState: null }],
    ["a match the check didn't confirm", { strength: "BRAND" as const }],
  ])("does not say so with %s, since no refund is on offer", (_why, over) => {
    const chips = chipsFor(row(over));
    expect(chips).toContain("Sold after the recall");
    expect(chips).not.toContain("Refund eligible");
  });

  it("says the same in the grid's Path column", () => {
    expect(pathNow(row({ joinState: "AMBIGUOUS_JOIN" }))).toBe("Sold after the recall");
    expect(pathNow(row())).toBe("Refund eligible");
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

describe("waitsOnSeller: there is still something only the seller can do", () => {
  const notice = { salePath: "NOTICE_ONLY" as const };
  it.each<[string, Parameters<typeof waitsOnSeller>[0], boolean]>([
    ["a new match", row(notice), true],
    ["a message prepared, not sent", row({ ...notice, notice: told("PREPARED") }), true],
    ["a message opened, not sent", row({ ...notice, notice: told("OPENED_IN_MAIL") }), true],
    ["a message sent", row({ ...notice, notice: told("MARKED_SENT") }), false],
    ["a family that answered", row({ ...notice, notice: told("FAMILY_RESPONDED") }), false],
    ["a question sent, with the recall since confirmed: the family still has to be told", row({ ...notice, notice: told("MARKED_SENT", "CHECK_REQUEST") }), true],
    ["a refund on offer, with the family told", row({ notice: told("MARKED_SENT") }), true],
    ["a refund made, with the family not told: it is still a recall", row({ refund: refund("refunded") }), true],
    ["a refund made and the family told", row({ refund: refund("refunded"), notice: told("MARKED_SENT") }), false],
    ["a refund at PayPal, with the family told: not finished until it's refunded", row({ refund: refund("pending"), notice: told("MARKED_SENT") }), true],
    ["a refund reserved, with the family told: it may never have gone", row({ refund: refund("reserved"), notice: told("MARKED_SENT") }), true],
    ["a refund with no clear answer, after the evidence changed: the seller still has to check", row({ verdict: "SCOPE_GAP", strength: "BRAND", refund: refund("unconfirmed"), notice: told("MARKED_SENT") }), true],
    ["sold on the recall date, with the family told: a person still has to decide about the money", row({ salePath: "REVIEW", notice: told("MARKED_SENT") }), true],
    ["a refund with no clear answer: only the seller can check", row({ refund: refund("unconfirmed"), notice: told("MARKED_SENT") }), true],
    ["a refund that failed: it can be tried again", row({ refund: refund("failed"), notice: told("MARKED_SENT") }), true],
    ["no payment to refund, with the family told", row({ joinState: "HISTORY_UNAVAILABLE", notice: told("MARKED_SENT") }), false],
    ["a scope gap with no question yet", row({ verdict: "SCOPE_GAP", strength: "BRAND", salePath: "NOTICE_ONLY" }), true],
    ["a scope gap's question sent", row({ verdict: "SCOPE_GAP", strength: "BRAND", notice: told("MARKED_SENT", "CHECK_REQUEST") }), false],
    ["a scope gap's question answered yes", row({ verdict: "SCOPE_GAP", strength: "BRAND", notice: told("FAMILY_RESPONDED", "CHECK_REQUEST", "MATCHES") }), false],
    ["a scope gap's question answered no", row({ verdict: "SCOPE_GAP", strength: "BRAND", notice: told("FAMILY_RESPONDED", "CHECK_REQUEST", "DOESNT_MATCH") }), false],
    ["a family that couldn't settle it: nothing else will", row({ verdict: "SCOPE_GAP", strength: "BRAND", notice: told("FAMILY_RESPONDED", "CHECK_REQUEST", "CANT_TELL") }), true],
    ["product words only: nothing can go out, so it's the seller's to check", row({ verdict: "SCOPE_GAP", strength: "PRODUCT_WORDS" }), true],
    ["two possible orders: nothing can go out, so it's the seller's to check", row({ joinState: "AMBIGUOUS_JOIN" }), true],
    ["an item still on the shelf", row({ isListing: true, stillListed: true, salePath: null, joinState: null }), true],
    ["an item off the shelf", row({ isListing: true, stillListed: false, salePath: null, joinState: null }), false],
    ["cleared", row({ verdict: "CLEARED" }), false],
  ])("%s", (_about, r, waits) => {
    expect(waitsOnSeller(r)).toBe(waits);
  });
});

describe("refundOnOffer", () => {
  it("offers a refund on a confirmed sale after the recall, with its payment linked", () => expect(refundOnOffer(row())).toBe(true));
  it("offers it again after one failed: PayPal refused it, so nothing went out", () => expect(refundOnOffer(row({ refund: refund("failed") }))).toBe(true));
  it.each(["refunded", "pending", "reserved", "unconfirmed"])("doesn't while one is %s: that could pay twice", (status) => {
    expect(refundOnOffer(row({ refund: refund(status) }))).toBe(false);
  });
  it.each<[string, Partial<ReturnType<typeof row>>]>([
    ["no payment linked", { joinState: "HISTORY_UNAVAILABLE" }],
    ["a sale before the recall", { salePath: "NOTICE_ONLY" }],
    ["a sale on the recall date", { salePath: "REVIEW" }],
  ])("doesn't with %s", (_about, over) => {
    expect(refundOnOffer(row(over))).toBe(false);
  });
  it("doesn't on a scope gap", () => expect(refundOnOffer(row({ verdict: "SCOPE_GAP" as never }))).toBe(false));
  it("doesn't on a match resting on the brand alone: the server would refuse it", () => expect(refundOnOffer(row({ strength: "BRAND" as never }))).toBe(false));
});

describe("saleWaits: a card is a sale, not only its lead", () => {
  const answered = (result: string) => row({ verdict: "SCOPE_GAP", strength: "BRAND", notice: told("FAMILY_RESPONDED", "CHECK_REQUEST", result) });
  const other = row({ verdict: "SCOPE_GAP", strength: "BRAND" });

  it("a family's no on one recall doesn't settle the others that came near this sale", () => {
    expect(saleWaits({ lead: answered("DOESNT_MATCH"), also: [other] })).toBe(true);
  });
  it("a no with nothing else near it does", () => {
    expect(saleWaits({ lead: answered("DOESNT_MATCH"), also: [] })).toBe(false);
  });
  it("a yes does: this is the product, and the family knows", () => {
    expect(saleWaits({ lead: answered("MATCHES"), also: [other] })).toBe(false);
  });
  it("a question still out waits on the family, whatever else is near", () => {
    expect(saleWaits({ lead: row({ verdict: "SCOPE_GAP", strength: "BRAND", notice: told("MARKED_SENT", "CHECK_REQUEST") }), also: [other] })).toBe(false);
  });
  it("follows the lead otherwise", () => {
    expect(saleWaits({ lead: other, also: [] })).toBe(true);
  });
});

describe("stateChip: what has happened on this row, not only what the check found", () => {
  it("says what the check found until anything has", () => {
    expect(stateChip(row())).toBe("Needs review");
    expect(stateChip(row({ verdict: "SCOPE_GAP" }))).toBe("Can't tell yet");
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
    expect(chipsFor(row({ verdict: "SCOPE_GAP", strength: "BRAND" }))).toEqual(["Can't tell yet"]);
  });

  it("marks a match that rests on product words alone as that", () => {
    expect(chipsFor(row({ verdict: "SCOPE_GAP", strength: "PRODUCT_WORDS" }))).toEqual(["Can't tell yet", "Product words only"]);
  });

  it("carries the join state, and the shelf for a listing", () => {
    expect(chipsFor(row({ joinState: "AMBIGUOUS_JOIN" }))).toEqual(["Needs review", "Sold after the recall", "Two possible orders"]);
    expect(chipsFor(row({ verdict: "SCOPE_GAP", strength: "BRAND", joinState: null, salePath: null, isListing: true, stillListed: true }))).toEqual(["Can't tell yet", "Check the shelf"]);
  });

  it("shows only that it is cleared on a cleared row", () => {
    expect(chipsFor(row({ verdict: "CLEARED", strength: "BRAND" }))).toEqual(["Cleared"]);
  });

  it("never says pull something from the shelf over a shared word", () => {
    const listing = { joinState: null, salePath: null, isListing: true, stillListed: true };
    expect(chipsFor(row({ ...listing, verdict: "SCOPE_GAP", strength: "PRODUCT_WORDS" }))).toEqual(["Can't tell yet", "Product words only"]);
    expect(chipsFor(row({ ...listing, verdict: "SCOPE_GAP", strength: "NO_SHARED_WORDS" }))).toEqual(["Can't tell yet"]);
    expect(chipsFor(row({ ...listing, verdict: "MATCH", strength: "CONFIRMED" }))).toEqual(["Needs review", "Pull from the shelf"]);
  });

  it("says a sold-out listing isn't for sale, and nothing about who bought it", () => {
    const chips = chipsFor(row({ verdict: "SCOPE_GAP", strength: "BRAND", joinState: null, salePath: null, isListing: true, stillListed: false }));
    expect(chips).toEqual(["Can't tell yet", "Not for sale now"]);
  });
});

describe("a store read from its listings", () => {
  const card = (recordId: string, strength: "CONFIRMED" | "BRAND" | "PRODUCT_WORDS" | "NO_SHARED_WORDS") => ({ lead: { recordId, strength } });

  it("counts each listing once, under the strongest thing it came near", () => {
    const cards = [card("a", "CONFIRMED"), card("a", "CONFIRMED"), card("b", "BRAND"), card("c", "PRODUCT_WORDS"), card("d", "NO_SHARED_WORDS")];
    expect(listingCounts(cards, 219)).toEqual({ total: 219, needCheck: 2, sharedWord: 2, notFlagged: 215 });
  });

  it("counts a real shop's sales the same way, with no total", () => {
    expect(splitCounts([card("a", "BRAND"), card("a", "CONFIRMED"), card("b", "PRODUCT_WORDS"), card("c", "NO_SHARED_WORDS")])).toEqual({ needCheck: 1, sharedWord: 2 });
    expect(splitCounts([])).toEqual({ needCheck: 0, sharedWord: 0 });
  });

  it("adds up to the listings read", () => {
    const { needCheck, sharedWord, notFlagged } = listingCounts([card("a", "BRAND"), card("b", "PRODUCT_WORDS")], 2);
    expect(needCheck + sharedWord + notFlagged).toBe(2);
    expect(notFlagged).toBe(0);
  });

  it("says what was read, and that no sale was", () => {
    const c = { recallsChecked: 1855, searchedFrom: null, searchedTo: "2026-11-06", recallsFrom: "2022-01-03", recallsTo: "2026-11-05", recallYearsMissing: [], unidentifiedPayments: 0, paypalSearched: false, candidatesNotChecked: 3, searchWindows: 0, failedWindows: 0 };
    expect(listingCoverageLine(c, { total: 1000, forSale: 950 })).toBe("Read 1,000 listings, 950 for sale now. No sales or PayPal history were read. Checked 1,855 recalls, 2022-01-03 to 2026-11-05. 3 candidates were not checked.");
    expect(listingCoverageLine(c, { total: 1, forSale: 1 })).toContain("Read 1 listing,");
  });
});
