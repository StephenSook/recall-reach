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

  const listAt = (testId: string) => {
    const start = html.indexOf(`data-testid="${testId}"`);
    return html.slice(start, html.indexOf("</ol>", start)).split("<li>").slice(1);
  };

  it("keeps five steps in view, the rest under More to try, and says what to look for at every one", () => {
    expect(listAt("itinerary")).toHaveLength(5);
    expect(listAt("itinerary-more").length).toBeGreaterThanOrEqual(4);
    expect(html).toContain("<summary>More to try</summary>");
    for (const step of [...listAt("itinerary"), ...listAt("itinerary-more")]) expect(step).toContain("Look for");
  });

  it("numbers the steps under More to try on from the first five", () => {
    expect(html).toMatch(/data-testid="itinerary-more"[^>]*start="6"|start="6"[^>]*data-testid="itinerary-more"/);
  });

  it("gives thirty seconds to a money moment that needs no demo shop", () => {
    const row = html.slice(html.indexOf("<td>30 seconds</td>"), html.indexOf("</tr>", html.indexOf("<td>30 seconds</td>")));
    expect(row).toContain('href="#late-refund"');
    expect(row).toContain("See PayPal refuse a late refund");
    expect(html).toContain('id="late-refund"');
  });

  it("says the 10-minute route covers what's under More to try", () => {
    expect(html).toContain("All the steps, including More to try.");
  });

  it("gives the measured time for a sale to reach the queue, not a guess", () => {
    expect(html).toContain("In five sandbox runs on Nov 8 and 9 it took 13 to 99 seconds; four of the five took 20 seconds or less.");
    expect(html).not.toContain("a minute or two");
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
