import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import nextConfig from "../../next.config";
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

describe("the shopper page's origin-trial header", () => {
  const trialRules = async () => (await nextConfig.headers!()).filter((rule) => rule.headers.some((header) => header.key === "Origin-Trial"));

  it("goes on /shopper and nowhere else, with the configured token", async () => {
    vi.stubEnv("WEBMCP_ORIGIN_TRIAL_TOKEN", "configured-trial-token");
    expect(await trialRules()).toEqual([{ source: "/shopper", headers: [{ key: "Origin-Trial", value: "configured-trial-token" }] }]);
  });

  it("isn't sent at all with no token, rather than sent empty", async () => {
    vi.stubEnv("WEBMCP_ORIGIN_TRIAL_TOKEN", "");
    expect(await trialRules()).toEqual([]);
  });
});
