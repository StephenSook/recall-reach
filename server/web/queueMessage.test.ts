import { describe, expect, it } from "vitest";
import { messageQuery, trustedMessage } from "./queueMessage";

const SECRET = "s".repeat(32);
const params = (query: string) => Object.fromEntries(new URLSearchParams(query));

describe("messages on the queue page", () => {
  it("shows a message this server wrote", () => {
    const { message, sig } = params(messageQuery(SECRET, "This payment has 12.00 USD left to refund."));
    expect(trustedMessage(SECRET, message, sig)).toBe("This payment has 12.00 USD left to refund.");
  });

  it("carries any characters safely in the address", () => {
    const text = "Line one & two = 3? Yes: 100%.";
    const { message, sig } = params(messageQuery(SECRET, text));
    expect(trustedMessage(SECRET, message, sig)).toBe(text);
  });

  it("shows nothing for text someone put in a link", () => {
    expect(trustedMessage(SECRET, "Your account is locked. Call this number.", undefined)).toBeNull();
    expect(trustedMessage(SECRET, "Your account is locked. Call this number.", "forged")).toBeNull();
  });

  it("shows nothing when a real signature is moved onto other words", () => {
    const { sig } = params(messageQuery(SECRET, "A real message."));
    expect(trustedMessage(SECRET, "A different message.", sig)).toBeNull();
  });

  it("shows nothing signed with another secret", () => {
    const { message, sig } = params(messageQuery("t".repeat(32), "A real message."));
    expect(trustedMessage(SECRET, message, sig)).toBeNull();
  });

  it.each([[undefined], [["two", "values"]]])("shows nothing for a message of %o", (message) => {
    expect(trustedMessage(SECRET, message as never, "sig")).toBeNull();
  });
});
