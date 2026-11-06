import { describe, expect, it } from "vitest";
import type { MarketListing } from "./channel3";
import { sweepView } from "./view";

const brezza = {
  title: "Baby Brezza Enterprises Recalls SuperFast Sterilizer Dryers Due to Overheating and Burn Hazards",
  description: "This recall involves Baby Brezza SuperFast Sterilizer Dryers, model BRZ0083. Only units manufactured from January 2024 through June 2025 are included in this recall.",
  products: [{ name: "SuperFast Sterilizer Dryers" }],
  retailers: [],
} as never;

const listing = (title: string, brand: string | null, id = title): MarketListing => ({ id, title, brand });

describe("sweepView", () => {
  it("lists a same-brand, same-product result, and what would settle it", () => {
    const view = sweepView(brezza, [listing("Superfast Sterilizer Dryer", "Baby Brezza")]);
    expect(view.candidates).toHaveLength(1);
    expect(view.candidates[0].title).toBe("Superfast Sterilizer Dryer");
    expect(view.candidates[0].settle.length).toBeGreaterThan(0);
    expect(view).toMatchObject({ returned: 1, notListed: 0 });
  });

  it("doesn't name another company's product under a recall: that would read as it being recalled", () => {
    const view = sweepView(brezza, [listing("Sterilizer Dryer for Bottles", "Other Brand"), listing("SuperFast Sterilizer Dryer", null)]);
    expect(view.candidates).toEqual([]);
    expect(view.notListed).toBe(2);
  });

  it.each([
    ["a seller whose name contains the brand", "Superfast Sterilizer Dryer", "Baby Brezza Outlet"],
    ["another brand with the recalled model in its title", "Dryer BRZ0083", "Other Brand"],
    ["no brand at all, with the recalled model in its title", "Dryer BRZ0083", null],
  ])("doesn't list %s", (_name, title, brand) => {
    const view = sweepView(brezza, [listing(title, brand)]);
    expect(view.candidates).toEqual([]);
    expect(view.notListed).toBe(1);
  });

  it("lists nothing for a recall whose brand it can't read", () => {
    const noBrand = { title: "Sterilizer Dryers Recalled Due to Burn Hazards", description: "Sterilizer dryers, model BRZ0083.", products: [], retailers: [] } as never;
    expect(sweepView(noBrand, [listing("Sterilizer Dryer BRZ0083", "Baby Brezza")]).candidates).toEqual([]);
  });

  it("matches the brand exactly, whatever its case and spacing", () => {
    expect(sweepView(brezza, [listing("Superfast Sterilizer Dryer", "  BABY  brezza ")]).candidates).toHaveLength(1);
  });

  it.each([
    ["names a seller", "Baby Brezza SuperFast Sterilizer Dryer sold by Retailer X"],
    ["has a word CPSC never used", "Superfast Sterilizer Dryer Machine"],
  ])("doesn't print a title that %s, only counts it", (_name, title) => {
    const view = sweepView(brezza, [listing(title, "Baby Brezza")]);
    expect(view.candidates).toEqual([]);
    expect(view.otherWording).toBe(1);
    expect(view.notListed).toBe(0);
    expect(JSON.stringify(view)).not.toContain("Retailer X");
    expect(JSON.stringify(view)).not.toContain("Machine");
  });

  it("doesn't print a title with a seller CPSC itself names, since that would read as selling it now", () => {
    const sold = { title: "Baby Brezza Enterprises Recalls SuperFast Sterilizer Dryers", description: "Sold at Bigstore. Baby Brezza SuperFast Sterilizer Dryers.", products: [{ name: "SuperFast Sterilizer Dryers" }], retailers: ["Bigstore"] } as never;
    expect(sweepView(sold, [listing("Bigstore Superfast Sterilizer Dryer", "Baby Brezza")]).candidates).toEqual([]);
  });

  it("doesn't name a seller that came back in the brand field", () => {
    const view = sweepView(brezza, [listing("Superfast Sterilizer Dryer", "A Department Store")]);
    expect(JSON.stringify(view)).not.toContain("Department Store");
    expect(view.notListed).toBe(1);
  });

  it("keeps no brand on what it lists, so a seller's name can't ride along", () => {
    const view = sweepView(brezza, [listing("Superfast Sterilizer Dryer", "Baby Brezza")]);
    expect(Object.keys(view.candidates[0]).sort()).toEqual(["id", "namesListedModel", "settle", "title"]);
  });

  it("lists one line per title, since a product can come back once per seller", () => {
    const view = sweepView(brezza, [listing("Superfast Sterilizer Dryer", "Baby Brezza", "a"), listing("Superfast Sterilizer Dryer", "Baby Brezza", "b"), listing("Superfast sterilizer dryer", "Baby Brezza", "c")]);
    expect(view.candidates).toHaveLength(1);
    expect(view).toMatchObject({ returned: 3, notListed: 0, otherWording: 0 });
  });

  it("says when a title names a model CPSC lists, and still only as something to review", () => {
    const view = sweepView(brezza, [listing("Superfast Sterilizer Dryer BRZ0083", "Baby Brezza")]);
    expect(view.candidates[0].namesListedModel).toBe(true);
  });

  it("says nothing was found, not that nothing exists, when no result comes near", () => {
    expect(sweepView(brezza, [])).toEqual({ returned: 0, candidates: [], otherWording: 0, notListed: 0 });
  });
});
