// A seller's answer, on a deployment: it saves, it changes nothing on the card, and only a shop's own file counts.
// No refund is spent, and the shop this makes is deleted whatever else fails.
//   pnpm exec playwright test --config playwright.measure.config.ts seller-answers
import { expect, test, type Page } from "@playwright/test";

test.use({ viewport: { width: 390, height: 844 } });
test.setTimeout(300_000);

const MEMO_MS = 61_000; // the count page re-reads at most once a minute

async function counted(page: Page): Promise<number> {
  const res = await page.request.get("/eval/sellers");
  expect(res.ok()).toBe(true);
  return Number(/(\d+)\s*(?:<!-- -->\s*)*answers?/.exec(await res.text())?.[1] ?? 0);
}

const brezza = (page: Page) => page.locator('article[data-recall="27072"]').first();

async function answer(page: Page, button: string, said: string) {
  // It stays open after an answer, so a second answer doesn't need it opened.
  const press = brezza(page).getByRole("button", { name: button });
  if (!(await press.isVisible())) await brezza(page).getByText("Why this came up").click();
  await press.click();
  await expect(page).toHaveURL(/answered=/);
  // The card comes back with its answer showing, so the seller can see it took.
  await expect(brezza(page).getByTestId("seller-answer")).toBeVisible();
  await expect(brezza(page).getByTestId("seller-answer")).toContainText(`You said this is ${said}.`);
}

test("a demo shop's answer saves, leaves the card alone and is never counted", async ({ page }) => {
  const before = await counted(page);
  await page.goto("/");
  await page.getByRole("button", { name: "Try it as a demo shop" }).click();
  await expect(page).toHaveURL(/\/queue$/, { timeout: 120_000 });
  const verdict = await brezza(page).getAttribute("data-verdict");
  const actions = await brezza(page).getByRole("button").allTextContents();

  await answer(page, "No, it is different", "a different product");
  await expect(brezza(page).getByTestId("seller-answer")).toContainText("A demo shop's answer is never counted.");
  await expect(brezza(page)).toHaveAttribute("data-verdict", verdict ?? "");
  const shown = await brezza(page).getByRole("button").allTextContents();
  expect(shown.filter((b) => !/it is/.test(b))).toEqual(actions.filter((b) => !/it is/.test(b)));

  await answer(page, "No, it is the recalled product", "the recalled product");
  await page.waitForTimeout(MEMO_MS);
  expect(await counted(page)).toBe(before);
});

test("a shop's own file counts, and stops counting when the shop is deleted", async ({ page }) => {
  const before = await counted(page);
  await page.goto("/check");
  const sample = await page.request.get("/sample-order-file.csv");
  await page.getByLabel("Your shop's name").fill("Sample Test Shop");
  await page.getByLabel("Your order file").setInputFiles({ name: "orders.csv", mimeType: "text/csv", buffer: await sample.body() });
  await page.getByRole("button", { name: "Check my file" }).click();
  await expect(page).toHaveURL(/\/queue/, { timeout: 120_000 });
  try {
    await answer(page, "Yes, it is", "the recalled product");
    await expect(brezza(page).getByTestId("seller-answer")).toContainText("Kept with your shop");
    await expect.poll(() => counted(page), { timeout: 2 * MEMO_MS, intervals: [10_000] }).toBe(before + 1);
  } finally {
    await page.goto("/queue");
    await page.getByText("Delete my data").click();
    await page.getByRole("button", { name: "Delete everything" }).click();
    await expect(page.locator(".alert")).toHaveText("Your shop's data was deleted.");
  }
  await expect.poll(() => counted(page), { timeout: 2 * MEMO_MS, intervals: [10_000] }).toBe(before);
});
