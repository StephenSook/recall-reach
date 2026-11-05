import { describe, expect, it } from "vitest";
import { createContactCipher } from "./contactCipher";

const SECRET = "k".repeat(32);
const SHOP_A = "00000000-0000-4000-8000-00000000000a";
const SHOP_B = "00000000-0000-4000-8000-00000000000b";
const EMAIL = "buyer-one@example.test";

describe("createContactCipher", () => {
  it("round-trips an email for its own shop", () => {
    const c = createContactCipher(SECRET, SHOP_A);
    expect(c.open(c.seal(EMAIL))).toBe(EMAIL);
  });

  it("never shows the plaintext, and seals the same email differently each time", () => {
    const c = createContactCipher(SECRET, SHOP_A);
    const sealed = c.seal(EMAIL);
    expect(sealed).not.toContain("buyer-one");
    expect(sealed).not.toContain(Buffer.from(EMAIL).toString("base64"));
    expect(c.seal(EMAIL)).not.toBe(sealed);
  });

  it("one shop's cipher cannot open another shop's value", () => {
    const sealed = createContactCipher(SECRET, SHOP_A).seal(EMAIL);
    expect(() => createContactCipher(SECRET, SHOP_B).open(sealed)).toThrow(/could not be opened/);
  });

  it("a different master secret cannot open it", () => {
    const sealed = createContactCipher(SECRET, SHOP_A).seal(EMAIL);
    expect(() => createContactCipher("z".repeat(32), SHOP_A).open(sealed)).toThrow(/could not be opened/);
  });

  it("detects tampering", () => {
    const c = createContactCipher(SECRET, SHOP_A);
    const parts = c.seal(EMAIL).split(".");
    const last = Buffer.from(parts[3], "base64");
    last[0] ^= 0xff;
    parts[3] = last.toString("base64");
    expect(() => c.open(parts.join("."))).toThrow(/could not be opened/);
  });

  it("the error never contains the value it was given", () => {
    const c = createContactCipher(SECRET, SHOP_A);
    expect(() => c.open("v1.not.a.secret-looking-value")).toThrow(/^contact value could not be opened$/);
  });

  it("refuses a master secret shorter than 32 characters", () => {
    expect(() => createContactCipher("short", SHOP_A)).toThrow(/32/);
  });
});
