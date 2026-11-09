import { describe, expect, it } from "vitest";
import { excelColumns, grouped, refundTotal, usd } from "./gridFeatures";

const col = (field: string) => ({ field });

describe("grouping the table", () => {
  const cols = [col("recallNumber"), col("state"), col("product")];

  it("leaves the columns alone with no group chosen", () => {
    expect(grouped(cols, null)).toEqual(cols);
  });

  it("groups by the chosen column and hides it, because the group row already says it", () => {
    expect(grouped(cols, "state")).toEqual([col("recallNumber"), { field: "state", rowGroup: true, hide: true }, col("product")]);
  });

  it("doesn't change the columns it was given", () => {
    grouped(cols, "state");
    expect(cols[1]).toEqual(col("state"));
  });

  it("ignores a column that isn't there", () => {
    expect(grouped(cols, "nope")).toEqual(cols);
  });
});

describe("the refund-eligible total", () => {
  it("adds the sales that can still be refunded", () => {
    expect(refundTotal([{ refundEligible: true, saleUsd: 18 }, { refundEligible: true, saleUsd: 42.5 }])).toEqual({ count: 2, usd: 60.5, unpriced: 0 });
  });

  it("leaves out the rest", () => {
    expect(refundTotal([{ refundEligible: false, saleUsd: 18 }])).toEqual({ count: 0, usd: 0, unpriced: 0 });
  });

  it("counts a sale with no price in dollars apart, so the total can't quietly read low", () => {
    expect(refundTotal([{ refundEligible: true, saleUsd: null }, { refundEligible: true, saleUsd: 10 }])).toEqual({ count: 2, usd: 10, unpriced: 1 });
  });

  it("doesn't drift on cents", () => {
    expect(refundTotal([{ refundEligible: true, saleUsd: 0.1 }, { refundEligible: true, saleUsd: 0.2 }]).usd).toBe(0.3);
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
