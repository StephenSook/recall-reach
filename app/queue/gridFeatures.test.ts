import { describe, expect, it } from "vitest";
import { chartRole, copiedCell, excelColumns, grouped, hasSaleWithNoUsdPrice, onlyUnidentified, refundTotal, saleCellWords, saleForExport, saleLabel, saleSum, usd } from "./gridFeatures";

describe("grouping the table", () => {
  const cols = [{ field: "recallNumber" }, { field: "state" }, { field: "product" }];
  const groupable = ["recallNumber", "state"];

  it("groups by the chosen column and hides it, because the group row already says it", () => {
    expect(grouped(cols, "state", groupable)[1]).toEqual({ field: "state", rowGroup: true, hide: true });
  });

  it("clears the others in so many words, because the grid keeps a group the new columns don't mention", () => {
    expect(grouped(cols, "state", groupable)[0]).toEqual({ field: "recallNumber", rowGroup: false, hide: false });
  });

  it("clears every group for no group", () => {
    expect(grouped(cols, null, groupable).filter((c) => (c as { rowGroup?: boolean }).rowGroup)).toEqual([]);
    expect(grouped(cols, null, groupable)[1]).toMatchObject({ rowGroup: false, hide: false });
  });

  it("leaves a column that can't be grouped alone", () => {
    expect(grouped(cols, "state", groupable)[2]).toEqual({ field: "product" });
  });

  it("doesn't change the columns it was given", () => {
    grouped(cols, "state", groupable);
    expect(cols[1]).toEqual({ field: "state" });
  });
});

describe("the refund-eligible total", () => {
  it("adds the sales that can still be refunded", () => {
    expect(refundTotal([{ saleId: "a", refundEligible: true, saleUsd: 18 }, { saleId: "b", refundEligible: true, saleUsd: 42.5 }])).toEqual({ count: 2, usd: 60.5, unpriced: 0 });
  });

  it("leaves out the rest", () => {
    expect(refundTotal([{ saleId: "a", refundEligible: false, saleUsd: 18 }])).toEqual({ count: 0, usd: 0, unpriced: 0 });
  });

  it("counts a sale once when it matches two recalls, because a sale can only be refunded once", () => {
    expect(refundTotal([{ saleId: "a", refundEligible: true, saleUsd: 18.5 }, { saleId: "a", refundEligible: true, saleUsd: 18.5 }])).toEqual({ count: 1, usd: 18.5, unpriced: 0 });
  });

  it("counts a sale with no price in dollars apart, so the total can't quietly read low", () => {
    expect(refundTotal([{ saleId: "a", refundEligible: true, saleUsd: null }, { saleId: "b", refundEligible: true, saleUsd: 10 }])).toEqual({ count: 2, usd: 10, unpriced: 1 });
  });

  it("doesn't drift on cents", () => {
    expect(refundTotal([{ saleId: "a", refundEligible: true, saleUsd: 0.1 }, { saleId: "b", refundEligible: true, saleUsd: 0.2 }]).usd).toBe(0.3);
  });
});

describe("a group's sale total", () => {
  it("adds each sale once", () => {
    expect(saleSum([{ saleId: "a", saleUsd: 18.5, soldOn: "2026-11-01" }, { saleId: "a", saleUsd: 18.5, soldOn: "2026-11-01" }, { saleId: "b", saleUsd: 1.5, soldOn: "2026-11-02" }])).toEqual({ usd: 20, unpriced: 0 });
  });

  it("counts a sale not in dollars apart", () => {
    expect(saleSum([{ saleId: "a", saleUsd: null, soldOn: "2026-11-01" }, { saleId: "b", saleUsd: 2, soldOn: "2026-11-02" }])).toEqual({ usd: 2, unpriced: 1 });
  });

  it("doesn't count a listing nobody bought", () => {
    expect(saleSum([{ saleId: "a", saleUsd: null, soldOn: null }])).toEqual({ usd: 0, unpriced: 0 });
  });

  it("leaves a payment nobody could identify out, because it isn't one of the shop's sales", () => {
    expect(saleSum([{ saleId: null, saleUsd: null, soldOn: "2026-11-01", verdict: "UNIDENTIFIED" }])).toEqual({ usd: 0, unpriced: 0 });
  });

  it("says when a group left a sale out", () => {
    expect(saleLabel({ usd: 18.5, unpriced: 1 })).toBe("$18.50 + 1 with no USD price");
  });

  it("is plain dollars otherwise", () => {
    expect(saleLabel({ usd: 18.5, unpriced: 0 })).toBe("$18.50");
  });
});

describe("dollars", () => {
  it("writes them the way an owner reads them", () => {
    expect(usd(1234.5)).toBe("$1,234.50");
  });

  it("shows nothing for no value", () => {
    expect(usd(null)).toBe("");
  });
});

describe("what the Excel file holds", () => {
  it("is what's on screen for the owner's own sales, with no link column", () => {
    expect(excelColumns(["recallNumber", "open", "ag-Grid-SelectionColumn", "saleUsd"])).toEqual(["recallNumber", "saleUsd"]);
  });
});

describe("the sale column", () => {
  const total = (usdValue: number, unpriced: number) => ({ value: usdValue, unpriced, toString: () => saleLabel({ usd: usdValue, unpriced }), toNumber: () => usdValue });
  const sold = { soldOn: "2026-11-01" };

  it("shows a group's total in words", () => {
    expect(saleCellWords(total(20, 1), undefined)).toBe("$20.00 + 1 with no USD price");
  });

  it("shows dollars on a sale", () => {
    expect(saleCellWords(18.5, sold)).toBe("$18.50");
  });

  it("says when a sale isn't priced in dollars, rather than leaving it blank", () => {
    expect(saleCellWords(null, sold)).toBe("No USD price");
  });

  it("leaves a payment nobody could identify blank too", () => {
    expect(saleCellWords(null, { soldOn: "2026-11-01", verdict: "UNIDENTIFIED" })).toBe("");
  });

  it("leaves a listing nobody bought blank", () => {
    expect(saleCellWords(null, { soldOn: null })).toBe("");
  });

  it("exports a complete group total as a number", () => {
    expect(saleForExport(total(20, 0), undefined)).toBe(20);
  });

  it("keeps the warning on a group total that left a sale out", () => {
    expect(saleForExport(total(20, 1), undefined)).toBe("$20.00 + 1 with no USD price");
  });

  it("keeps the warning on a group with nothing in dollars", () => {
    expect(saleForExport(total(0, 2), undefined)).toBe("$0.00 + 2 with no USD price");
  });

  it("exports a sale in dollars as a number", () => {
    expect(saleForExport(18.5, sold)).toBe(18.5);
  });

  it("marks a sale not in dollars in the file too", () => {
    expect(saleForExport(null, sold)).toBe("No USD price");
  });

  it("passes other cells through", () => {
    expect(saleForExport("Matched", sold)).toBe("Matched");
  });
});

describe("copying from the table", () => {
  it("copies an ordinary cell", () => {
    expect(copiedCell("recallNumber", "27072", { verdict: "MATCH" })).toBe("27072");
  });

  it("copies nothing from a payment nobody could identify", () => {
    expect(copiedCell("itemTitle", "A PayPal payment of 18.00 USD", { verdict: "UNIDENTIFIED" })).toBe("");
  });

  it("copies a group row's value", () => {
    expect(copiedCell("state", "Matched", undefined)).toBe("Matched");
  });

  it("copies what the Sale column says, so a sale not in dollars isn't a blank in the spreadsheet", () => {
    expect(copiedCell("saleUsd", null, { verdict: "MATCH", soldOn: "2026-11-01" })).toBe("No USD price");
  });

  it("copies a sale in dollars", () => {
    expect(copiedCell("saleUsd", 18.5, { verdict: "MATCH", soldOn: "2026-11-01" })).toBe("$18.50");
  });
});

describe("what the chart can use", () => {
  it("charts sales by recall, where a sale counts once", () => {
    expect(chartRole("recallNumber")).toBe("category");
    expect(chartRole("saleUsd")).toBe("series");
  });

  it.each(["state", "path", "noticeState", "product", "soldOn"])("keeps %s out, because a sale matching two recalls would count twice there", (field) => {
    expect(chartRole(field)).toBe("excluded");
  });
});

describe("a row made only of payments nobody could identify", () => {
  it("is one when every sale under it is", () => {
    expect(onlyUnidentified([{ verdict: "UNIDENTIFIED" }, { verdict: "UNIDENTIFIED" }])).toBe(true);
  });

  it("isn't one when any sale is the shop's own", () => {
    expect(onlyUnidentified([{ verdict: "UNIDENTIFIED" }, { verdict: "MATCH" }])).toBe(false);
  });

  it("isn't one with nothing under it", () => {
    expect(onlyUnidentified([])).toBe(false);
  });
});

describe("whether any sale has no USD price", () => {
  it("is true for a sale in another currency", () => {
    expect(hasSaleWithNoUsdPrice([{ soldOn: "2026-11-01", saleUsd: null, verdict: "MATCH" }])).toBe(true);
  });

  it("isn't set off by a payment nobody could identify", () => {
    expect(hasSaleWithNoUsdPrice([{ soldOn: "2026-11-01", saleUsd: null, verdict: "UNIDENTIFIED" }])).toBe(false);
  });

  it("isn't set off by a listing", () => {
    expect(hasSaleWithNoUsdPrice([{ soldOn: null, saleUsd: null, verdict: "MATCH" }])).toBe(false);
  });
});
