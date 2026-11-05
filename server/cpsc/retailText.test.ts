import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { firstSaleMonth, saleWindow, statedPrices } from "./retailText";

// For all 934 recalls of 2025 and 2026 (to Nov 5): the Retailers text from the CPSC API and what the
// EDA script (research/eda/analysis.py) parsed from it. The TypeScript parser must agree exactly.
const fixture: {
  records: {
    recallNumber: string;
    retailers: string[];
    start: [number, number] | null;
    startMonthKnown: boolean;
    end: [number, number] | null;
    prices: number[];
  }[];
} = JSON.parse(readFileSync(new URL("../../test/fixtures/cpsc/eda_sale_windows.json", import.meta.url), "utf8"));

describe("saleWindow", () => {
  it("agrees with the EDA parse on all 934 recalls (890 with a first-sale month)", () => {
    const mismatches = fixture.records.filter((r) => {
      const w = saleWindow(r.retailers);
      const start = w.start ? [w.start.year, w.start.month] : null;
      const end = w.end ? [w.end.year, w.end.month] : null;
      return (
        JSON.stringify(start) !== JSON.stringify(r.start) ||
        JSON.stringify(end) !== JSON.stringify(r.end) ||
        (w.start !== null && w.startMonthKnown !== r.startMonthKnown)
      );
    });
    expect(mismatches.map((m) => m.recallNumber)).toEqual([]);
    expect(fixture.records.filter((r) => saleWindow(r.retailers).start !== null)).toHaveLength(890);
  });

  it("reads month and year from a typical CPSC sentence", () => {
    const w = saleWindow(["Sold Online At:\nAmazon.com from April 2023 through August 2026 for between $90 and $130."]);
    expect(w).toEqual({ start: { year: 2023, month: 4 }, startMonthKnown: true, end: { year: 2026, month: 8 }, endMonthKnown: true });
  });

  it("treats a year-only start as January and a year-only end as December", () => {
    const w = saleWindow(["Sold at stores nationwide from 2019 through 2021 for about $20."]);
    expect(w).toEqual({ start: { year: 2019, month: 1 }, startMonthKnown: false, end: { year: 2021, month: 12 }, endMonthKnown: false });
  });

  it("takes the earliest start and the latest end across several retailers", () => {
    const w = saleWindow(["Target from May 2022 through June 2023", "Walmart.com from March 2021 through January 2024"]);
    expect(w.start).toEqual({ year: 2021, month: 3 });
    expect(w.end).toEqual({ year: 2024, month: 1 });
  });

  it("returns nothing when the text states no dates", () => {
    expect(saleWindow(["Sold exclusively at Example Store for $30."])).toEqual({
      start: null,
      startMonthKnown: false,
      end: null,
      endMonthKnown: false,
    });
  });
});

describe("firstSaleMonth", () => {
  it("formats the first-sale month as YYYY-MM, or null", () => {
    expect(firstSaleMonth(["from April 2023 through August 2026"])).toBe("2023-04");
    expect(firstSaleMonth(["no dates here"])).toBeNull();
  });
});

describe("statedPrices", () => {
  it("agrees with the EDA price parse on all 934 recalls (924 state a price)", () => {
    const mismatches = fixture.records.filter((r) => JSON.stringify(statedPrices(r.retailers)) !== JSON.stringify(r.prices));
    expect(mismatches.map((m) => m.recallNumber)).toEqual([]);
    expect(fixture.records.filter((r) => statedPrices(r.retailers).length > 0)).toHaveLength(924);
  });

  it("reads dollar amounts with thousands separators and cents", () => {
    expect(statedPrices(["for between $1,299.99 and $ 40"])).toEqual([1299.99, 40]);
  });
});
