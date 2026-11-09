import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import ShopperPage from "./page";
import { ShopperForm } from "./ShopperForm";

afterEach(() => vi.unstubAllEnvs());

describe("the shopper page's origin-trial metadata", () => {
  it("renders the existing form without browser capabilities or a trial token", async () => {
    vi.stubEnv("WEBMCP_ORIGIN_TRIAL_TOKEN", "");
    const html = renderToStaticMarkup(await ShopperPage({ searchParams: Promise.resolve({}) }));
    expect(html).not.toContain('http-equiv="origin-trial"');
    expect(html).toContain('data-testid="shopper-form"');
    expect(html).toContain("Find one");
    expect(renderToStaticMarkup(createElement(ShopperForm))).toContain("Agent tools");
  });

  it("emits the configured token only in the shopper page", async () => {
    vi.stubEnv("WEBMCP_ORIGIN_TRIAL_TOKEN", "configured-trial-token");
    const html = renderToStaticMarkup(await ShopperPage({ searchParams: Promise.resolve({}) }));
    expect(html).toContain('<meta http-equiv="origin-trial" content="configured-trial-token"/>');
  });
});
