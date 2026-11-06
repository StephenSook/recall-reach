// How long a full-size order file takes on a deployment, and what it leaves behind: nothing, it deletes itself.
//   TIMING_FILE=/path/to/orders.csv pnpm exec playwright test --config playwright.measure.config.ts own-file-timing
// The file stays outside the repo. It should hold no buyer data.
import { readFileSync } from "node:fs";
import { expect, test } from "@playwright/test";

test.setTimeout(10 * 60_000);

test("times a demo shop's start: PayPal search, two sandbox sales and the check", async ({ page }) => {
  await page.goto("/");
  const started = Date.now();
  await page.getByRole("button", { name: "Try it as a demo shop" }).click();
  await expect(page).toHaveURL(/\/queue$/, { timeout: 2 * 60_000 });
  console.log(`demo seconds to the queue: ${((Date.now() - started) / 1000).toFixed(1)}`);
  console.log(await page.getByTestId("coverage").innerText());
  console.log(`demo cards: ${await page.getByTestId("needs").locator("article").count()}`);
});

test("times a full-size order file through the real upload, then deletes it", async ({ page }) => {
  const path = process.env.TIMING_FILE;
  test.skip(!path, "set TIMING_FILE");
  await page.goto("/check");
  await page.getByLabel("Your shop's name").fill("Timing Test Shop");
  await page.getByLabel("Your order file").setInputFiles({ name: "orders.csv", mimeType: "text/csv", buffer: readFileSync(path!) });

  const started = Date.now();
  await page.getByRole("button", { name: "Check my file" }).click();
  await expect(page.getByTestId("checking")).toContainText("couple of minutes");
  await expect(page).toHaveURL(/\/queue/, { timeout: 8 * 60_000 });
  const uploaded = Date.now() - started;
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Timing Test Shop");
  console.log(`seconds to the queue: ${(uploaded / 1000).toFixed(1)}`);
  console.log(await page.getByTestId("coverage").innerText());
  console.log(await page.getByTestId("stats").innerText());
  console.log(`cards: ${await page.getByTestId("needs").locator("article").count()}`);

  await page.getByText("Delete my data").click();
  await page.getByRole("button", { name: "Delete everything" }).click();
  await expect(page.locator(".alert")).toHaveText("Your shop's data was deleted.");
});
