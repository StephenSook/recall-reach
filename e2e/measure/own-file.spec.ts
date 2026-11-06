// A shop's own file, on a deployment: real recalls against the sample sales, no PayPal, and everything deleted after.
//   pnpm exec playwright test --config playwright.measure.config.ts own-file
import { expect, test } from "@playwright/test";

test.use({ viewport: { width: 390, height: 844 } });

test("a shop checks its own file, sees real matches with refunds off, and deletes it all", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("link", { name: "Check your own order file" }).click();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Check your own order file");

  const sample = await page.request.get("/sample-order-file.csv");
  expect(sample.ok()).toBe(true);
  await page.getByLabel("Your shop's name").fill("Sample Test Shop");
  await page.getByLabel("Your order file").setInputFiles({ name: "orders.csv", mimeType: "text/csv", buffer: await sample.body() });
  await page.getByRole("button", { name: "Check my file" }).click();
  await expect(page).toHaveURL(/\/queue/, { timeout: 120_000 });

  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Sample Test Shop");
  await expect(page.getByTestId("coverage")).toContainText("PayPal's history was not searched.");
  const brezza = page.locator('article[data-recall="27072"]').first();
  await expect(brezza).toContainText("Real shop");
  await expect(brezza).not.toContainText("Sandbox PayPal");
  await expect(brezza.getByRole("button", { name: "Approve this notice" })).toBeVisible();
  await expect(page.getByRole("button", { name: /refund/i })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Buy this as a family" })).toHaveCount(0);

  const bath = page.locator('article[data-recall="27018"]').first();
  await expect(bath).toContainText("Sold after the recall");
  await expect(bath).toContainText("A refund needs your PayPal connected.");

  await page.getByText("Delete my data").click();
  await page.getByRole("button", { name: "Delete everything" }).click();
  await expect(page.locator(".alert")).toHaveText("Your shop's data was deleted.");
  await page.goto("/queue");
  await expect(page).toHaveURL(/\/$/); // the session is gone with the shop
});
