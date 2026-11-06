import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { sessionCookie } from "../session/session";
import { createContactCipher } from "./contactCipher";
import { createRecordKey } from "./recordKey";

// Read from the file itself, so this can't drift from what a new install would copy.
const example = readFileSync(new URL("../../.env.example", import.meta.url), "utf8");
const placeholder = (name: string) => new RegExp(`^${name}=(.*)$`, "m").exec(example)?.[1] ?? "";

describe("the placeholders in .env.example", () => {
  it.each(["RECORD_HMAC_SECRET", "SESSION_SECRET", "SHOP_DATA_KEY"])("%s is long enough to pass a length check, which is why this matters", (name) => {
    expect(placeholder(name).length).toBeGreaterThan(0);
  });

  it("can't key anything: anyone can read them", () => {
    expect(() => createRecordKey(placeholder("RECORD_HMAC_SECRET"))).toThrow("placeholder");
    expect(() => sessionCookie(placeholder("SESSION_SECRET"), "shop-1")).toThrow("placeholder");
    expect(() => createContactCipher(placeholder("SHOP_DATA_KEY"), "shop-1")).toThrow("placeholder");
  });

  it("real secrets still work", () => {
    const real = "a1b2".repeat(16);
    expect(createRecordKey(real)("paypal-event", "x")).toMatch(/^[0-9a-f]{64}$/);
    expect(sessionCookie(real, "shop-1").value).toContain("shop-1");
    expect(createContactCipher(real, "shop-1").open(createContactCipher(real, "shop-1").seal("x"))).toBe("x");
  });
});
