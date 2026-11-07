import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

const path = vi.hoisted(() => ({ current: "/queue" }));
vi.mock("next/navigation", () => ({ usePathname: () => path.current }));

import { SiteHeader } from "./SiteHeader";

const html = () => renderToStaticMarkup(createElement(SiteHeader));

describe("the site header", () => {
  afterEach(() => {
    path.current = "/queue";
  });

  it("names the product and links home", () => {
    expect(html()).toMatch(/<a [^>]*href="\/"[^>]*>Recall Reach<\/a>/);
  });

  it("links the pages that make up the product, in plain words", () => {
    const links = [...html().matchAll(/<a [^>]*href="([^"]+)"[^>]*>([^<]+)<\/a>/g)].map((m) => [m[1], m[2]]);
    expect(links).toEqual([
      ["/", "Recall Reach"],
      ["/queue", "Queue"],
      ["/replay", "Replay"],
      ["/eval", "How well it works"],
      ["/safety", "Safety"],
      ["/check", "Check"],
    ]);
  });

  it("marks where you are, including on a page under it", () => {
    path.current = "/replay/00000000-0000-4000-8000-000000000001";
    expect(html()).toMatch(/<a [^>]*href="\/replay"[^>]*aria-current="page"|<a [^>]*aria-current="page"[^>]*href="\/replay"/);
    expect(html().match(/aria-current/g)).toHaveLength(1);
  });

  it("doesn't take /checkout-like paths for /check", () => {
    path.current = "/checkout";
    expect(html()).not.toContain("aria-current");
  });

  it.each(["/r/abc", "/r/abc/stopped"])("shows nothing on a family's page, %s, so it has no way into the seller's side", (family) => {
    path.current = family;
    expect(html()).toBe("");
  });

  it("names its navigation for a screen reader", () => {
    expect(html()).toContain('<nav aria-label="Main"');
  });
});
