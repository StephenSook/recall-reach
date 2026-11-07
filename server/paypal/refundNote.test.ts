import { describe, expect, it } from "vitest";
import { NOTE_LIMIT, refundNote } from "./refundNote";

describe("the note PayPal gets with a refund", () => {
  it("names the recall from CPSC's record and points to CPSC", () => {
    expect(refundNote("27027", "Papablic Bedside Sleepers with Play Yard Extensions")).toBe(
      "Refund for a recalled product. CPSC recall 27027: Papablic Bedside Sleepers with Play Yard Extensions. Follow the recall steps at cpsc.gov/Recalls.",
    );
  });

  it("keeps within PayPal's limit by cutting the product's name, at a word, and nothing else", () => {
    const long = Array.from({ length: 60 }, (_, i) => `Word${i}`).join(" ");
    const note = refundNote("27027", long);
    expect(note.length).toBeLessThanOrEqual(NOTE_LIMIT);
    expect(note.startsWith("Refund for a recalled product. CPSC recall 27027: Word0 Word1")).toBe(true);
    expect(note.endsWith(". Follow the recall steps at cpsc.gov/Recalls.")).toBe(true);
    expect(note).toMatch(/Word\d+\. Follow/);
  });

  it("doesn't double a full stop the product's name ends with, and tidies its spaces", () => {
    expect(refundNote("1", "  Sleepers   Inc.  ")).toBe("Refund for a recalled product. CPSC recall 1: Sleepers Inc. Follow the recall steps at cpsc.gov/Recalls.");
  });
});
