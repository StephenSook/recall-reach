import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { StandingNotices } from "./StandingNotices";

const html = (on: boolean) => renderToStaticMarkup(createElement(StandingNotices, { recallNumber: "27072", on, here: "#sale-1" }));

describe("preparing every notice for one recall", () => {
  it("starts closed", () => {
    expect(html(false)).toMatch(/^<details/);
    expect(html(false)).not.toMatch(/^<details[^>]* open/);
  });

  it("says it's only matches, that nothing sends by itself, and that refunds still need the owner", () => {
    const page = html(false);
    expect(page).toContain("New sales the check reads as a match");
    expect(page).toContain("A sale it can&#x27;t tell about still asks you.");
    expect(page).toContain("Nothing sends by itself: each one still opens in your mail, and you send it.");
    expect(page).toContain("Refunds still need you every time.");
  });

  it("needs the number typed, and can be turned off", () => {
    expect(html(false)).toContain('name="typed"');
    expect(html(false)).toContain("Turn on for recall 27072");
    expect(html(true)).toContain("On for recall 27072: notices are prepared for you, and you still send each one.");
    expect(html(true)).toContain('value="off"');
  });
});
