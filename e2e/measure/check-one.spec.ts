// One item typed at a phone's width, on a deployment: real recalls, nothing stored, no login.
//   pnpm exec playwright test --config playwright.measure.config.ts check-one
import { expect, test } from "@playwright/test";

test.use({ viewport: { width: 390, height: 844 } });

const overflow = (page: import("@playwright/test").Page) => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);

test("an owner types what's on a label, and reads each kind of answer", async ({ page }) => {
  await page.goto("/check");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Check one item");
  expect(await overflow(page)).toBeLessThanOrEqual(0);

  // A recalled model.
  await page.getByLabel("What's on the label").fill("Baby Brezza sterilizer");
  await page.getByLabel("Model number, if you can see it").fill("BRZ0083");
  await page.getByRole("button", { name: "Check it" }).click();
  const answer = page.getByTestId("item-answer");
  await expect(answer).toContainText("This matches a recall. That doesn't say this one is recalled: read it and compare the model.");
  await expect(answer.getByRole("link", { name: /27072/ })).toBeVisible();
  expect(await overflow(page)).toBeLessThanOrEqual(0);
  if (process.env.SHOT) await page.screenshot({ path: process.env.SHOT, fullPage: false });

  // Its link reads CPSC's words, with the photo and the model to compare.
  await answer.getByRole("link", { name: /27072/ }).click();
  await expect(page.getByRole("heading", { level: 1 })).toContainText("Baby Brezza");
  await expect(page.locator("figure.photo img")).toBeVisible();
  await expect(page.locator("figure.photo figcaption")).toContainText("BRZ0083");
  expect(await overflow(page)).toBeLessThanOrEqual(0);
  await page.goBack();

  // The maker alone.
  await page.getByLabel("What's on the label").fill("Baby Brezza");
  await page.getByLabel("Model number, if you can see it").fill("");
  await page.getByRole("button", { name: "Check it" }).click();
  await expect(page.getByTestId("item-answer")).toHaveAttribute("data-kind", "CANT_TELL");

  // Nothing near, and the count comes from what was read.
  await page.getByLabel("What's on the label").fill("zzqx vvbn plmk");
  await page.getByRole("button", { name: "Check it" }).click();
  await expect(page.getByTestId("item-answer")).toContainText(/No recall in [\d,]+ CPSC recalls since 2022 names this\. That doesn't mean it's safe\./);
  await expect(page.getByRole("link", { name: "nhtsa.gov/recalls" })).toBeVisible();

  // What it keeps and checks is folded, and opens.
  const fold = page.locator("details.check-details");
  await expect(fold.locator("p").first()).toBeHidden();
  await fold.locator("summary").click();
  await expect(fold.locator("p").first()).toBeVisible();
});
