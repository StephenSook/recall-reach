// Measures the live catch on a deployment that receives PayPal's webhook: a family buys an item, and a card reaches
// the queue. Not part of the golden path until it holds over repeated runs. Each run records its seconds.
//   pnpm exec playwright test --config playwright.measure.config.ts
import { expect, test } from "@playwright/test";

test.use({ viewport: { width: 390, height: 844 } }); // every window shows, so the new card can be seen arriving

test("a sale reaches the queue with no one pressing anything", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Try it as a demo shop" }).click();
  await expect(page).toHaveURL(/\/queue$/, { timeout: 120_000 });

  const shelf = page.locator('article[data-recall="27018"]');
  await expect(shelf).toHaveCount(1);
  await shelf.getByRole("button", { name: "Buy this as a family" }).click();
  await expect(page.getByTestId("watching")).toBeVisible({ timeout: 30_000 });

  // The queue looks again by itself. Nothing on the page is pressed from here on.
  const caught = page.getByTestId("caught");
  await expect(caught).toBeVisible({ timeout: 120_000 });
  console.log(await caught.innerText());
  await expect(page.locator('article[data-recall="27018"]')).toHaveCount(2);
});
