import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import Home from "./page";

const render = async (demo?: string) => renderToStaticMarkup(await Home({ searchParams: Promise.resolve({ demo }) }));

describe("home page", () => {
  it("says so when the demo shop could not be set up", async () => {
    expect(await render("failed")).toContain("The demo shop could not be set up. Please try again.");
  });

  it("says so when this visitor has started too many demo shops", async () => {
    expect(await render("busy")).toContain("Too many demo shops from here. Try again in an hour.");
  });

  it("shows no message otherwise, and never repeats what the address says", async () => {
    const page = await render("<b>anything</b>");
    expect(page).not.toContain('role="alert"');
    expect(page).not.toContain("anything");
  });
});
