import { describe, expect, it } from "vitest";
import { receiptTokenFor, receiptKeyFromToken } from "./token";

const SECRET = "s".repeat(32);
const KEY = "12345678-1234-4234-8234-123456789abc";

describe("safety receipt shop links", () => {
  it("verifies a signed opaque key, with no shop id or payment data", () => {
    const token = receiptTokenFor(SECRET, KEY);
    expect(token).toHaveLength(66);
    expect(token).not.toContain(KEY);
    expect(receiptKeyFromToken(SECRET, token)).toBe(KEY);
  });

  it("refuses a changed key, signature, secret, or malformed encoding", () => {
    const token = receiptTokenFor(SECRET, KEY);
    for (const bad of ["A" + token.slice(1), token.slice(0, -1) + "!", token + "extra", "", KEY]) {
      expect(receiptKeyFromToken(SECRET, bad)).toBeNull();
    }
    expect(receiptKeyFromToken("z".repeat(32), token)).toBeNull();
  });
});
