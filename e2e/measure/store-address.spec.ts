// A real store's public listings, on a deployment: real recalls against real titles, and everything deleted after.
// The store's address comes from the environment, because no store is named in this repo or in its output.
//   STORE_ADDRESS=... pnpm exec playwright test --config playwright.measure.config.ts store-address
import { expect, test } from "@playwright/test";

const address = process.env.STORE_ADDRESS ?? "";

test("a store types its address, sees what needs a check with no claim about sales, and deletes it all", async ({ page }) => {
  test.skip(!address, "needs STORE_ADDRESS");
  test.setTimeout(420_000);
  await page.goto("/check", { waitUntil: "networkidle" }); // the form's "reading" line needs the page's script running
  await page.getByLabel("Type your store's web address").fill(address);
  const started = Date.now();
  // The click waits for the whole check, so what the page says meanwhile is saved as it appears.
  await page.evaluate(() => {
    new MutationObserver(() => {
      const shown = document.querySelector('[data-testid="reading"]');
      if (shown) sessionStorage.setItem("reading", shown.textContent ?? "");
    }).observe(document.body, { childList: true, subtree: true });
  });
  await page.getByRole("button", { name: "Check my listings" }).click({ timeout: 300_000 });
  await expect(page).toHaveURL(/\/queue/, { timeout: 300_000 });
  const seconds = Math.round((Date.now() - started) / 1000);
  // Once this page holds the shop's session, the shop gets deleted whatever else fails, so a bad run leaves nothing behind.
  try {
    expect(await page.evaluate(() => sessionStorage.getItem("reading"))).toContain("couple of minutes");

    await expect(page.getByTestId("listings-lead")).toHaveText("This compares listing titles with CPSC recalls. It doesn't say this store sold a recalled product. None is confirmed: only the item in hand can settle it.");
    await expect(page.getByTestId("coverage")).toContainText("No sales or PayPal history were read.");
    const tiles = (await page.getByTestId("stats").locator(".stat").allInnerTexts()).map((t) => t.replace(/\s+/g, " "));
    const counts = { seconds, tiles, cards: await page.locator(".cards > .window").count() };
    console.log(JSON.stringify(counts)); // counts only: no store's name and no title
    if (process.env.SHOT_DIR) {
      await page.waitForLoadState("networkidle");
      await page.screenshot({ path: `${process.env.SHOT_DIR}/store-wide.png` });
      await page.setViewportSize({ width: 390, height: 844 });
      await page.screenshot({ path: `${process.env.SHOT_DIR}/store-phone.png` });
    }

    for (const word of ["Sold:", "this sale", "Sandbox PayPal", "Refund eligible", "Sold after the recall", "Approve", "Export Tell CPSC", "Pull from the shelf"]) await expect(page.locator("main")).not.toContainText(word);
    await expect(page.getByRole("columnheader", { name: "Sold" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: /refund/i })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Buy this as a family" })).toHaveCount(0);
  } finally {
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.getByText("Delete my data").click();
    await page.getByRole("button", { name: "Delete everything" }).click();
  }
  await expect(page.locator(".alert")).toHaveText("Your shop's data was deleted.");
  await page.goto("/queue");
  await expect(page).toHaveURL(/\/\?demo=noqueue$/);
});
