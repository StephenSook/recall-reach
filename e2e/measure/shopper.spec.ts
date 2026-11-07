// The shopping agent on a running deployment, as a visitor would use it. Real Claude and real Channel3 listings, and it spends
// from the site's Claude budget. It stops at the button that goes to PayPal: approving needs a sandbox login.
import { expect, test } from "@playwright/test";

test("it searches, checks a listing against recalls, and shows what it did", async ({ page }) => {
  test.setTimeout(240_000);
  await page.goto("/shopper");
  await page.getByRole("button", { name: "A high chair, 200 USD" }).click();
  await expect(page.getByTestId("shopper-running")).toBeVisible();
  await expect(page.getByTestId("shopper-steps")).toBeVisible({ timeout: 180_000 });
  await page.getByTestId("shopper-steps").locator("summary").click();
  await expect(page.getByTestId("shopper-steps")).toContainText("Searched for");
  await expect(page.getByTestId("shopper-steps")).toContainText("Checked");
  const main = await page.locator("main").innerText();
  expect(main).not.toMatch(/\bsafe to buy\b|\bis safe\b|isn't recalled/i);
  for (const blocked of await page.getByTestId("shopper-blocked").all()) {
    await expect(blocked).toContainText("words match a recall");
    await expect(blocked).toContainText("doesn't say this item is recalled");
    await expect(blocked.getByRole("link").first()).toHaveAttribute("href", /cpsc\.gov/);
  }
  const pick = page.getByTestId("shopper-pick");
  if (await pick.count()) {
    await expect(pick).toContainText("No recall match found in");
    await expect(pick).toContainText("That doesn't mean it's safe.");
    await expect(pick.getByRole("button", { name: "Approve on PayPal (sandbox)" })).toBeVisible();
  } else {
    await expect(page.getByTestId("shopper-said")).toBeVisible();
  }
  console.log(main.replace(/\s+/g, " ").slice(0, 1200));
});
