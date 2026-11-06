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
  await expect(page.getByTestId("watching")).toContainText("That can take a minute or two.");
  // A second press can't make a second sale, from the page or straight at the server.
  await expect(shelf.getByRole("button", { name: "Buy this as a family" })).toBeDisabled();
  await expect(shelf.getByRole("button", { name: "Buy with a PayPal sandbox login" })).toBeDisabled();
  await expect(shelf.getByTestId("sale-on-its-way")).toHaveText("That sale is on its way. PayPal can take a minute or two to tell us.");
  const item = await page.locator('form[action="/api/demo/buy"] input[name="shopItemId"]').first().inputValue();
  const again = await page.request.post("/api/demo/buy", { form: { shopItemId: item }, headers: { origin: new URL(page.url()).origin }, maxRedirects: 0 });
  expect(new URL(again.headers().location).searchParams.get("message")).toBe("That sale is on its way. PayPal can take a minute or two to tell us.");
  if (process.env.SHOT_DIR) await page.screenshot({ path: `${process.env.SHOT_DIR}/buy-waiting.png`, fullPage: false });

  // The queue looks again by itself. Nothing on the page is pressed from here on.
  const caught = page.getByTestId("caught");
  await expect(caught).toBeVisible({ timeout: 120_000 });
  console.log(await caught.innerText());
  await expect(page.locator('article[data-recall="27018"]')).toHaveCount(2);
  await expect(shelf.first().getByRole("button", { name: "Buy this as a family" })).toBeEnabled();
});
