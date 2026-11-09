import { describe, expect, it } from "vitest";
import { copiedCell, excelColumns, grouped, refundTotal, saleCellWords, saleForExport, saleLabel, saleSum, usd } from "./gridFeatures";

describe("grouping the table", () => {
  const cols = [{ field: "recallNumber", enableRowGroup: true }, { field: "state", enableRowGroup: true }, { field: "product" }];

  it("groups by the chosen column and hides it, because the group row already says it", () => {
    expect(grouped(cols, "state")[1]).toEqual({ field: "state", enableRowGroup: true, rowGroup: true, hide: true });
  });

  it("clears the others in so many words, because the grid keeps a group the new columns don't mention", () => {
    expect(grouped(cols, "state")[0]).toEqual({ field: "recallNumber", enableRowGroup: true, rowGroup: false, hide: false });
  });

  it("clears every group for no group", () => {
    expect(grouped(cols, null).filter((c) => (c as { rowGroup?: boolean }).rowGroup)).toEqual([]);
    expect(grouped(cols, null)[1]).toMatchObject({ rowGroup: false, hide: false });
  });

  it("leaves a column that can't be grouped alone", () => {
    expect(grouped(cols, "state")[2]).toEqual({ field: "product" });
  });

  it("doesn't change the columns it was given", () => {
    grouped(cols, "state");
    expect(cols[1]).toEqual({ field: "state", enableRowGroup: true });
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

  it("says when a group left a sale out", () => {
    expect(saleLabel({ usd: 18.5, unpriced: 1 })).toBe("$18.50 + 1 not in USD");
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
    expect(saleCellWords(total(20, 1), undefined)).toBe("$20.00 + 1 not in USD");
  });

  it("shows dollars on a sale", () => {
    expect(saleCellWords(18.5, sold)).toBe("$18.50");
  });

  it("says when a sale isn't priced in dollars, rather than leaving it blank", () => {
    expect(saleCellWords(null, sold)).toBe("Not in USD");
  });

  it("leaves a listing nobody bought blank", () => {
    expect(saleCellWords(null, { soldOn: null })).toBe("");
  });

  it("exports a complete group total as a number", () => {
    expect(saleForExport(total(20, 0), undefined)).toBe(20);
  });

  it("keeps the warning on a group total that left a sale out", () => {
    expect(saleForExport(total(20, 1), undefined)).toBe("$20.00 + 1 not in USD");
  });

  it("keeps the warning on a group with nothing in dollars", () => {
    expect(saleForExport(total(0, 2), undefined)).toBe("$0.00 + 2 not in USD");
  });

  it("exports a sale in dollars as a number", () => {
    expect(saleForExport(18.5, sold)).toBe(18.5);
  });

  it("marks a sale not in dollars in the file too", () => {
    expect(saleForExport(null, sold)).toBe("Not in USD");
  });

  it("passes other cells through", () => {
    expect(saleForExport("Matched", sold)).toBe("Matched");
  });
});

describe("copying from the table", () => {
  it("copies an ordinary cell", () => {
    expect(copiedCell("27072", { verdict: "MATCH" })).toBe("27072");
  });

  it("copies nothing from a payment nobody could identify", () => {
    expect(copiedCell("A PayPal payment of 18.00 USD", { verdict: "UNIDENTIFIED" })).toBe("");
  });

  it("copies a group row's value", () => {
    expect(copiedCell("Matched", undefined)).toBe("Matched");
  });
});
