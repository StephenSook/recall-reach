// A real store's public listings, on a deployment: real recalls against real titles, and everything deleted after.
// The store's address comes from the environment, because no store is named in this repo or in its output.
//   STORE_ADDRESS=... pnpm exec playwright test --config playwright.measure.config.ts store-address
import { expect, test } from "@playwright/test";

const address = process.env.STORE_ADDRESS ?? "";

test("a store types its address, sees what needs a check with no claim about sales, and deletes it all", async ({ page }) => {
  test.skip(!address, "needs STORE_ADDRESS");
  test.setTimeout(420_000);
  await page.goto("/check");
  await page.getByLabel("Type your store's web address").fill(address);
  const started = Date.now();
  await page.getByRole("button", { name: "Check my listings" }).click();
  await expect(page.getByTestId("reading")).toBeVisible();
  await expect(page).toHaveURL(/\/queue/, { timeout: 300_000 });
  const seconds = Math.round((Date.now() - started) / 1000);

  await expect(page.getByTestId("listings-lead")).toHaveText("These are your public listings, not your sales. None is confirmed: only the item in hand can settle it.");
  await expect(page.getByTestId("coverage")).toContainText("No sales or PayPal history were read.");
  const tiles = (await page.getByTestId("stats").locator(".stat").allInnerTexts()).map((t) => t.replace(/\s+/g, " "));
  const counts = { seconds, tiles, cards: await page.locator(".cards > .window").count() };
  console.log(JSON.stringify(counts)); // counts only: no store's name and no title

  for (const word of ["Sold:", "Sandbox PayPal", "Refund eligible", "Sold after the recall", "Approve this"]) await expect(page.locator("main")).not.toContainText(word);
  await expect(page.getByRole("button", { name: /refund/i })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Buy this as a family" })).toHaveCount(0);

  await page.getByText("Delete my data").click();
  await page.getByRole("button", { name: "Delete everything" }).click();
  await expect(page.locator(".alert")).toHaveText("Your shop's data was deleted.");
  await page.goto("/queue");
  await expect(page).toHaveURL(/\/$/);
});
