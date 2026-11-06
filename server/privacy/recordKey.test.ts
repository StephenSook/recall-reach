import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createRecordKey } from "./recordKey";

const SECRET = "a".repeat(32);

describe("createRecordKey", () => {
  it("takes only the listed kinds, so a kind can't carry a separator into another's key", () => {
    // @ts-expect-error a kind outside the list doesn't compile
    expect(createRecordKey(SECRET)("anything else", "x")).toMatch(/^[0-9a-f]{64}$/);
  });

  it("gives the same key for the same kind and value", () => {
    const key = createRecordKey(SECRET);
    expect(key("paypal-event", "WH-1")).toBe(key("paypal-event", "WH-1"));
    expect(key("paypal-event", "WH-1")).toMatch(/^[0-9a-f]{64}$/);
  });

  it("is not a plain hash of the value", () => {
    const key = createRecordKey(SECRET);
    expect(key("paypal-event", "WH-1")).not.toBe(createHash("sha256").update("WH-1").digest("hex"));
  });

  it("changes with the secret, so keys from one shop mean nothing for another", () => {
    expect(createRecordKey(SECRET)("paypal-event", "WH-1")).not.toBe(createRecordKey("b".repeat(32))("paypal-event", "WH-1"));
  });

  it("separates kinds, so the same id under two kinds gives two keys", () => {
    const key = createRecordKey(SECRET);
    expect(key("paypal-event", "X")).not.toBe(key("paypal-resource", "X"));
  });

  it("refuses a secret shorter than 32 characters", () => {
    expect(() => createRecordKey("short")).toThrow(/32/);
  });
});
