// The optional shop plan's panel, on a deployment with the plan configured. It reads the panel and never presses Subscribe:
// approving a subscription is the owner's own act. Uses the sample order file, deleted after.
//   pnpm exec playwright test --config playwright.measure.config.ts subscription-panel
import { expect, test } from "@playwright/test";

test.use({ viewport: { width: 390, height: 844 } });

test.afterEach(async ({ page }) => {
  await page.goto("/queue");
  if ((await page.getByText("Delete my data").count()) === 0) return;
  await page.getByText("Delete my data").click();
  await page.getByRole("button", { name: "Delete everything" }).click();
  await expect(page.locator(".alert")).toHaveText("Your shop's data was deleted.");
});

test("a real shop is offered the optional plan, and families never pay", async ({ page }) => {
  await page.goto("/check");
  const sample = await page.request.get("/sample-order-file.csv");
  expect(sample.ok()).toBe(true);
  await page.getByLabel("Your shop's name").fill("Plan Panel Test Shop");
  await page.getByLabel("Your order file").setInputFiles({ name: "orders.csv", mimeType: "text/csv", buffer: await sample.body() });
  await page.getByRole("button", { name: "Check my file" }).click();
  await expect(page).toHaveURL(/\/queue/, { timeout: 120_000 });

  const panel = page.locator('section[aria-labelledby="shop-plan-title"]');
  await expect(panel).toContainText("PayPal sandbox, no real charge.");
  await expect(panel).toContainText("Families never pay.");
  await expect(panel).toContainText("5.00 USD a month");
  await expect(panel.getByRole("button", { name: "Subscribe with PayPal" })).toBeVisible();
  await expect(panel).not.toContainText("not set up");
});
