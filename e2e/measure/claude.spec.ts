// Proves Claude on a deployment with a key: the button runs the real agent and question writer, and the queue shows
// what they found. Not in the golden path, because it spends real money and the answer is a model's.
//   pnpm exec playwright test --config playwright.measure.config.ts claude
import { expect, test } from "@playwright/test";

test.use({ viewport: { width: 390, height: 844 } });

test("the seller's button runs Claude, and the queue shows the question and the finding", async ({ page }) => {
  const errors: string[] = [];
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(m.text());
  });
  await page.goto("/");
  await page.getByRole("button", { name: "Try it as a demo shop" }).click();
  await expect(page).toHaveURL(/\/queue$/, { timeout: 120_000 });
  await expect(page.getByTestId("agent-unavailable")).toHaveCount(0);

  const card = page.locator('article[data-recall="27040"]');
  console.log("before:", await card.getByTestId("family-question").innerText());
  const button = card.getByRole("button", { name: "Check with Claude" });
  if ((await button.count()) > 0) {
    await button.click();
    await expect(page).toHaveURL(/\/queue/, { timeout: 180_000 });
  }

  await expect(page.locator(".alert")).toHaveCount(0);
  const found = card.getByTestId("how-it-checked");
  await expect(found).toBeVisible({ timeout: 60_000 });
  await found.locator("summary").click();
  console.log("question:", await card.getByTestId("family-question").innerText());
  await expect(card.getByTestId("question-source")).toBeVisible();
  await card.getByTestId("question-source").locator("summary").click();
  console.log("from:", await card.getByTestId("question-source").innerText());
  console.log("finding:", await found.innerText());
  await page.screenshot({ path: "test-results/claude-on-deployed.png", fullPage: true });
  expect(errors).toEqual([]);
});
