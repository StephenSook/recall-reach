import { readFileSync } from "node:fs";
import { createElement, Suspense, use } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { shopSubscriptionPanel, ShopSubscriptionSection, SubscriptionPanel, SUBSCRIPTION_READ_TIMEOUT_MS } from "./ShopSubscription";
import type { ShopSubscription } from "@/server/shop/subscription";
import { readShopSubscription } from "@/server/shop/subscription";
import { SHOP_PLAN } from "@/server/paypal/subscriptions";

vi.mock("@/server/db/pg", () => ({ getBillingDb: () => ({}) }));
vi.mock("@/server/shop/subscription", () => ({ readShopSubscription: vi.fn() }));

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.resetAllMocks();
});

const state: ShopSubscription = { status: "ACTIVE", startedAt: "2026-11-08T12:00:00Z", recorded: true, closed: false, needsId: false };
const draw = (value: ShopSubscription | null, configured = true) => renderToStaticMarkup(SubscriptionPanel({ state: value, configured }));

describe("the small shop subscription panel", () => {
  it.each([null, state, { ...state, status: "APPROVAL_PENDING" as const }, { ...state, status: "SUSPENDED" as const }, { ...state, status: "CANCELLED" as const, closed: true }, { ...state, status: null, needsId: true }])("labels every state as sandbox with safety free", (value) => {
    const html = draw(value);
    expect(html).toContain(SHOP_PLAN.name);
    expect(html).toContain("PayPal sandbox, no real charge");
    expect(html).toContain("Everything that keeps families safe stays free.");
    const deletion = "Deleting the shop, including its automatic deletion after 7 days with no linked PayPal login or a year with no sign-in, does not cancel the subscription at PayPal, so cancel it first.";
    expect(html).toContain(deletion);
    expect(readFileSync("README.md", "utf8")).toContain(deletion);
    expect(html).not.toMatch(/[\u2013\u2014]/);
  });
  it("shows the one configured price and Subscribe only before starting", () => {
    expect(draw(null)).toContain(`${SHOP_PLAN.value} ${SHOP_PLAN.currency} a month`);
    expect(draw(null)).toContain("Families never pay.");
    expect(draw(null)).toContain("Subscribe with PayPal");
    expect(draw(state)).toContain("Active since"); expect(draw(state)).toContain("Cancel</button>");
    expect(draw(state)).not.toContain("Subscribe with PayPal");
  });
  it("offers pending approval and honestly shows stale and closed records", () => {
    expect(draw({ ...state, status: "APPROVAL_PENDING" })).toContain("Continue on PayPal");
    expect(draw({ ...state, status: null, needsId: true })).toContain('name="subscriptionId"');
    expect(draw({ ...state, closed: true, status: "CANCELLED" })).not.toContain("Cancel</button>");
  });
  it("keeps a reserved attempt uncertain when PayPal's answer may have been lost", () => {
    const html = draw({ ...state, status: null, startedAt: null, recorded: false, needsId: true });
    expect(html).toContain("PayPal hasn&#x27;t confirmed a subscription for this shop yet. Check subscription attempt asks PayPal again.");
    expect(html).not.toContain("No subscription has been created yet.");
    expect(html).toContain("Check subscription attempt");
    expect(html).not.toContain("Pending approval on PayPal.");
    expect(html).not.toContain("Continue on PayPal");
    expect(html).not.toContain("Cancel</button>");
  });
  it.each([
    ["APPROVAL_PENDING", "Pending approval on PayPal."],
    ["APPROVED", "Approved on PayPal, not active yet."],
    ["ACTIVE", "Active."],
    ["SUSPENDED", "Suspended."],
    ["CANCELLED", "Cancelled."],
    ["EXPIRED", "Expired."],
    ["UNKNOWN_STATUS", "PayPal reports UNKNOWN_STATUS."],
  ])("reports PayPal status %s plainly", (status, sentence) => {
    const html = draw({ ...state, status: status as ShopSubscription["status"], startedAt: null, closed: status === "CANCELLED" || status === "EXPIRED" });
    expect(html).toContain(sentence);
    if (status !== "APPROVAL_PENDING") {
      expect(html).not.toContain("Pending approval on PayPal.");
      expect(html).not.toContain("Continue on PayPal");
    }
  });
  it.each(["APPROVAL_PENDING", "APPROVED"] as const)("directs %s to PayPal without offering an invalid cancel", (status) => {
    const html = draw({ ...state, status });
    expect(html).toContain("Finish or cancel this attempt in your PayPal sandbox account.");
    expect(html).not.toContain('action="/api/shop/subscription/cancel"');
    expect(html).not.toContain("Cancel</button>");
    const expiredId = draw({ ...state, status, needsId: true });
    expect(expiredId).toContain("Finish or cancel this attempt in your PayPal sandbox account.");
    expect(expiredId).not.toContain("Continue on PayPal");
    expect(expiredId).not.toContain('name="subscriptionId"');
    expect(expiredId).not.toContain("Cancel</button>");
  });
  it.each(["ACTIVE", "SUSPENDED", null] as const)("offers cancel for recorded status %s, including the pasted-id flow", (status) => {
    const html = draw({ ...state, status, needsId: true });
    expect(html).toContain("Cancel</button>");
    expect(html).toContain('name="subscriptionId"');
    expect(draw({ ...state, status, recorded: false })).not.toContain("Cancel</button>");
    expect(draw({ ...state, status, closed: true })).not.toContain("Cancel</button>");
  });
  it.each(["CANCELLED", "EXPIRED"] as const)("does not offer cancel for terminal status %s", (status) => {
    expect(draw({ ...state, status })).not.toContain("Cancel</button>");
  });
  it("shows a clear line without Subscribe or a price when no plan is set", () => {
    const html = draw(null, false);
    expect(html).toContain("PAYPAL_SUBSCRIPTION_PLAN_ID is missing");
    expect(html).toContain("PayPal sandbox, no real charge");
    expect(html).not.toContain("Subscribe with PayPal"); expect(html).not.toContain(SHOP_PLAN.value);
  });
  it("renders safety content while the billing section waits, then contains its timeout", async () => {
    vi.useFakeTimers();
    vi.stubEnv("PAYPAL_SUBSCRIPTION_PLAN_ID", "P-TEST");
    vi.mocked(readShopSubscription).mockReturnValue(new Promise(() => {}));
    const section = ShopSubscriptionSection({ shopId: "shop" });
    // The server component's pending result suspends only its own boundary.
    function PendingBilling() { return use(section); }
    const shell = renderToStaticMarkup(createElement("main", null,
      createElement(Suspense, { fallback: null }, createElement(PendingBilling)),
      createElement("section", { "data-testid": "needs" }, "Your queue"),
      createElement("a", { href: "/s/receipt" }, "Safety receipt"),
    ));
    expect(shell).toContain('data-testid="needs">Your queue');
    expect(shell).toContain('href="/s/receipt">Safety receipt');
    expect(shell).not.toContain("Subscription status is unavailable.");
    const rendered = vi.fn();
    const pending = section.then((panel) => rendered(renderToStaticMarkup(panel)));
    await vi.advanceTimersByTimeAsync(SUBSCRIPTION_READ_TIMEOUT_MS - 1);
    expect(rendered).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await pending;
    expect(rendered).toHaveBeenCalledWith(expect.stringContaining("Subscription status is unavailable."));
    expect(vi.getTimerCount()).toBe(0);
  });
  it("keeps the page's real-shop billing section inside its own boundary without awaiting it", () => {
    const page = readFileSync(new URL("./page.tsx", import.meta.url), "utf8");
    expect(page).not.toMatch(/await\s+(?:shopSubscriptionPanel|ShopSubscriptionSection)\s*\(/);
    expect(page).toContain('{shop.kind === "REAL" ? <Suspense fallback={null}><ShopSubscriptionSection shopId={session.shopId} /></Suspense> : null}');
  });
  it.each(["success", "error"])("clears the timeout after a billing read: %s", async (result) => {
    vi.useFakeTimers();
    vi.stubEnv("PAYPAL_SUBSCRIPTION_PLAN_ID", "P-TEST");
    if (result === "success") vi.mocked(readShopSubscription).mockResolvedValue(null);
    else vi.mocked(readShopSubscription).mockRejectedValue(new Error("DB unavailable"));
    const html = renderToStaticMarkup(await shopSubscriptionPanel("shop"));
    expect(html).toContain(result === "success" ? "Subscribe with PayPal" : "Subscription status is unavailable.");
    expect(vi.getTimerCount()).toBe(0);
  });
});
