import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import JudgeDoor from "./page";

const html = renderToStaticMarkup(createElement(JudgeDoor));

describe("the judge's door", () => {
  it("offers the labelled sandbox late-refund test without a payment id", () => {
    expect(html).toContain('data-testid="late-refund-test"');
    expect(html).toContain("Sandbox test: PayPal refuses a late refund");
    expect(html).toContain("See PayPal refuse a late refund");
    expect(html).toContain("on a sale already refunded, so no money can move");
    expect(html).not.toContain("JUDGE_REFUSAL_CAPTURE_ID");
  });

  it("says what to do for the time you have", () => {
    for (const row of ["30 seconds", "3 minutes", "10 minutes"]) expect(html).toContain(`<td>${row}</td>`);
  });

  it("says what to look for at every step", () => {
    const steps = html.slice(html.indexOf('data-testid="itinerary"'), html.indexOf("</ol>")).split("<li>").slice(1);
    expect(steps.length).toBeGreaterThanOrEqual(8);
    for (const step of steps) expect(step).toContain("Look for");
  });

  it("numbers the steps the table refers to", () => {
    expect(html).toContain('class="window cleared-list numbered-steps"');
    expect(html).toContain("steps 1 to 3");
  });

  it("shows both phone codes, each labelled", () => {
    const codes = html.slice(html.indexOf('data-testid="phone-codes"'));
    expect(codes).toContain('src="/ios-qr.svg"');
    expect(codes).toContain("iPhone (TestFlight)");
    expect(codes).toContain('src="/android-apk-qr.svg"');
    expect(codes).toContain("Android (APK)");
  });

  it("says what the demo changes, and that it emails nobody", () => {
    expect(html).toContain("deleted after 48 hours");
    expect(html).toContain("It emails nobody.");
    expect(html).toContain("No real money moves.");
  });

  it("doesn't promise the shopping agent will stop a listing", () => {
    expect(html).toContain("it may not stop any");
  });
});
