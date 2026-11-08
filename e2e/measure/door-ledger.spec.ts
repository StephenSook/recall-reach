// Door notices and the Refunds sent page, on a deployment: the sample order file (it has no buyer emails), one notice
// approved by the person running this, a real print layout, and everything deleted after.
//   pnpm exec playwright test --config playwright.measure.config.ts door-ledger
import { expect, test } from "@playwright/test";

// The queue shows cards at this width. On a wide screen it is a grid.
test.use({ viewport: { width: 390, height: 844 } });

// Runs even when a step fails, so a failed run doesn't leave the test shop behind.
test.afterEach(async ({ page }) => {
  await page.goto("/queue");
  if ((await page.getByText("Delete my data").count()) === 0) return;
  await page.getByText("Delete my data").click();
  await page.getByRole("button", { name: "Delete everything" }).click();
  await expect(page.locator(".alert")).toHaveText("Your shop's data was deleted.");
});

test("a sale with no email gets a printable door notice, and the ledger opens and downloads", async ({ page }) => {
  await page.goto("/check");
  const sample = await page.request.get("/sample-order-file.csv");
  expect(sample.ok()).toBe(true);
  await page.getByLabel("Your shop's name").fill("Door Notice Test Shop");
  await page.getByLabel("Your order file").setInputFiles({ name: "orders.csv", mimeType: "text/csv", buffer: await sample.body() });
  await page.getByRole("button", { name: "Check my file" }).click();
  await expect(page).toHaveURL(/\/queue/, { timeout: 120_000 });

  const brezza = page.locator('article[data-recall="27072"]').first();
  await brezza.getByRole("button", { name: "Approve this notice" }).click();
  const link = brezza.getByRole("link", { name: "Print a door notice" });
  await expect(link).toBeVisible({ timeout: 60_000 });
  const href = await link.getAttribute("href");
  expect(href).toMatch(/^\/queue\/door\/[0-9a-f-]+$/);

  await page.goto(href!);
  await expect(page.locator(".door-notice")).toContainText("CPSC recall 27072");
  await expect(page.locator(".door-notice")).toContainText("The hazard, in CPSC's words");
  await expect(page.locator(".door-notice")).toContainText("What to do, in CPSC's words");
  await expect(page.locator(".door-url")).toHaveAttribute("href", /\/recall\/27072$/);
  await expect(page.locator(".door-qr")).toBeVisible();
  const words = await page.locator(".door-notice").innerText();
  for (const privateText of ["SAMPLE-1001", "60.00", "Door Notice Test Shop"]) expect(words).not.toContain(privateText);
  await expect(page.locator(".door-notice")).not.toContainText("We sold this item between");

  // What goes on paper: the notice alone, with the site's header and the buttons gone. Letter width, at 96 dpi.
  await page.setViewportSize({ width: 816, height: 1056 });
  await page.emulateMedia({ media: "print" });
  await expect(page.locator(".site-header")).toBeHidden();
  await expect(page.locator(".door-controls")).toBeHidden();
  await expect(page.locator(".door-notice")).toBeVisible();
  await expect(page.locator(".door-qr")).toBeVisible();
  await page.screenshot({ path: "test-results/door-notice-print.png", fullPage: true });
  await page.pdf({ path: "test-results/door-notice-print.pdf", format: "Letter", preferCSSPageSize: true });
  await page.emulateMedia({ media: "screen" });
  await page.setViewportSize({ width: 390, height: 844 });

  // The browser's own print dialog can't be driven, so this counts the call. The record is the app's, checked below.
  await page.evaluate(() => {
    const w = window as unknown as { printCalls: number; print: () => void };
    w.printCalls = 0;
    w.print = () => { w.printCalls += 1; };
  });
  const recorded = page.waitForResponse((r) => r.url().includes("/door") && r.request().method() === "POST");
  await page.getByRole("button", { name: "Print door notice" }).click();
  expect((await recorded).status()).toBe(200);
  await expect.poll(() => page.evaluate(() => (window as unknown as { printCalls: number }).printCalls)).toBe(1);

  await page.goto("/queue");
  await expect(page.locator('article[data-recall="27072"]').first()).toContainText("Door notice printed", { timeout: 60_000 });

  await page.goto("/queue/sent");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Refunds sent");
  await expect(page.locator("main")).toContainText("No refunds or payouts sent yet.");
  const csv = await page.request.get("/queue/sent/csv");
  expect(csv.status()).toBe(200);
  expect(csv.headers()["content-type"]).toContain("text/csv");
  expect((await csv.text()).trim().split("\r\n")).toHaveLength(1);
});
