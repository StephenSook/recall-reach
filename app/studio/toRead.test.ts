import { describe, expect, it } from "vitest";
import { recallPage, recallsToRead } from "./toRead";

const row = (recallNumber: string, outcome: string) => ({ recallNumber, title: `Recall ${recallNumber}`, outcome });

describe("the recalls an owner should read first", () => {
  it("leaves out what the rules cleared and what came nowhere near", () => {
    expect(recallsToRead([row("1", "Cleared"), row("2", "Nothing near"), row("3", "Matched")]).map((r) => r.recallNumber)).toEqual(["3"]);
  });

  it("puts matches before the ones it can't tell yet, even when those are newer", () => {
    expect(recallsToRead([row("27050", "Can't tell yet"), row("27001", "Matched")]).map((r) => r.outcome)).toEqual(["Matched", "Can't tell yet"]);
  });

  it("reads recall numbers as numbers, so the newest comes first", () => {
    expect(recallsToRead([row("9999", "Matched"), row("27072", "Matched"), row("26500", "Matched")]).map((r) => r.recallNumber)).toEqual(["27072", "26500", "9999"]);
  });

  it("doesn't take an outcome named like something every object has", () => {
    expect(recallsToRead([row("1", "constructor"), row("2", "toString")])).toEqual([]);
  });

  it("leaves the rows it was given alone", () => {
    const rows = [row("1", "Can't tell yet"), row("2", "Matched")];
    recallsToRead(rows);
    expect(rows.map((r) => r.recallNumber)).toEqual(["1", "2"]);
  });
});

describe("the link to a recall", () => {
  it("is this site's page for it", () => {
    expect(recallPage("27072")).toBe("/recall/27072");
  });

  it("can't be turned into another address by what's in the data", () => {
    expect(recallPage("../../admin")).toBe("/recall/..%2F..%2Fadmin");
  });
});
