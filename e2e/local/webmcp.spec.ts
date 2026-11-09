import { expect, test } from "@playwright/test";
import type { ShopperTool } from "../../app/shopper/webmcp";

declare global { interface Window { shopperTools: ShopperTool[] } }
const recallTitle = "Stokke Recalls Clikk High Chairs Due to Fall and Injury Hazards";

test("the ordinary form works without site tools and the token belongs only to /shopper", async ({ page }) => {
  await page.addInitScript(() => Object.defineProperty(document, "modelContext", { value: undefined, configurable: true }));
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("/shopper");
  await expect(page.getByRole("button", { name: "Find one", exact: true })).toBeVisible();
  await expect(page.locator('meta[http-equiv="origin-trial"]')).toHaveAttribute("content", "test-origin-trial-token");
  await page.route("**/api/shopper/run", (route) => route.fulfill({ json: { outcome: "NO_PICK", steps: [], blocked: [], pick: null } }));
  await page.locator('input[name="ask"]').fill("folding tub");
  await page.getByRole("button", { name: "Find one", exact: true }).click();
  await expect(page.getByTestId("shopper-said")).toBeVisible();
  await page.goto("/privacy");
  await expect(page.locator('meta[http-equiv="origin-trial"]')).toHaveCount(0);
  expect(errors).toEqual([]);
});

test("mock document tools run, update the panel, refuse recall 22113 and open a private PayPal handoff", async ({ page, context }) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.addInitScript(() => {
    const tools: ShopperTool[] = [];
    window.shopperTools = tools;
    Object.defineProperty(document, "modelContext", { configurable: true, value: {
      async registerTool(tool: ShopperTool, { signal }: { signal: AbortSignal }) {
        tools.push(tool);
        signal.addEventListener("abort", () => { const index = tools.indexOf(tool); if (index !== -1) tools.splice(index, 1); }, { once: true });
      },
    } });
  });
  await page.goto("/shopper");
  await expect.poll(() => page.evaluate(() => window.shopperTools.length)).toBe(3);
  // Exercise the actual GET origin guard using browser-generated Referer and Sec-Fetch-Site.
  expect(await page.evaluate(async () => (await fetch("/api/shopper/listings?query=x")).status)).toBe(400);
  const origin = new URL(page.url()).origin;
  expect((await context.request.get(`${origin}/api/shopper/listings?query=x`)).status()).toBe(403);
  await page.route("**/api/shopper/listings?**", (route) => route.fulfill({ json: {
    offerable: [{ id: "tub", title: "Folding Tub", price: 24.99, retailer: "store.example", slipId: "private-slip" }],
    refused: [{ id: "clikk", title: "Stokke Clikk High Chair", recallNumber: "22113", recallTitle, why: "Its words name a recall." }],
  } }));
  const searched = await page.evaluate(() => window.shopperTools[0].execute({ query: "high chair", maxPrice: 50 }, { signal: new AbortController().signal }));
  expect(searched).toMatchObject({ refused: [{ recallNumber: "22113", recallTitle }] });
  await expect(page.getByTestId("agent-tools")).toContainText("1 offered; 1 refused under recall 22113");
  const refused = await page.evaluate(() => window.shopperTools[2].execute({ listingId: "clikk" }, { signal: new AbortController().signal }));
  expect(refused).toMatchObject({ refused: true, recalls: [{ recallNumber: "22113" }] });
  expect(context.pages()).toHaveLength(1);
  await page.route("**/api/shopper/buy", async (route) => {
    expect(route.request().postData()).toBe("slip=private-slip");
    await route.fulfill({ json: { approveUrl: "https://www.sandbox.paypal.com/checkoutnow?token=PLANTED-ORDER", orderId: "PLANTED-ORDER" } });
  });
  await context.route("https://www.sandbox.paypal.com/**", (route) => route.fulfill({ contentType: "text/html", body: "<h1>Mock PayPal buyer approval page</h1>" }));
  const popupPromise = page.waitForEvent("popup");
  const result = await page.evaluate(() => window.shopperTools[2].execute({ listingId: "tub" }, { signal: new AbortController().signal }));
  const popup = await popupPromise;
  expect(result).toBe("PayPal's page is open for the buyer to review and approve.");
  await expect(popup.getByRole("heading")).toHaveText("Mock PayPal buyer approval page");
  await expect(page.getByTestId("agent-tools")).toContainText("PayPal opened");
  await expect(page.getByTestId("agent-tools")).not.toContainText("PLANTED-ORDER");
  await popup.close();
  await page.screenshot({ path: `test-results/webmcp/${test.info().project.name}-desktop.png`, fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: `test-results/webmcp/${test.info().project.name}-phone.png`, fullPage: true });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.getByRole("link", { name: "How well it works", exact: true }).click();
  await expect(page).toHaveURL(/\/eval$/);
  expect(await page.evaluate(() => window.shopperTools.length)).toBe(0);
  expect(errors).toEqual([]);
});
