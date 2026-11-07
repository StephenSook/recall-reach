// The API docs portal APIMatic generated, on a deployment: every page loads without a console error, and the check's
// Send button runs one read-only check against this site.
//   pnpm exec playwright test --config playwright.measure.config.ts api-docs
import { expect, test } from "@playwright/test";

const PAGES = ["/api-docs", "/api-docs/sdks/typescript", "/api-docs/api/openapi/check/checkRecall", "/api-docs/api/openapi/status/health"];

for (const path of PAGES) {
  test(`${path} loads with no console error`, async ({ page }) => {
    const errors: string[] = [];
    page.on("console", (m) => {
      if (m.type() === "error") errors.push(m.text());
    });
    page.on("pageerror", (e) => errors.push(String(e)));
    const res = await page.goto(path);
    expect(res?.status()).toBe(200);
    await page.waitForLoadState("networkidle");
    await expect(page.locator("h1").first()).toBeVisible();
    expect(errors).toEqual([]);
  });
}

test("the check's Send button runs the example check against this site", async ({ page }) => {
  await page.goto("/api-docs/api/openapi/check/checkRecall");
  const answer = page.waitForResponse((r) => r.url().includes("/api/check?") && r.request().method() === "GET");
  await page.getByRole("button", { name: "Send" }).click();
  const res = await answer;
  expect(res.status()).toBe(200);
  expect((await res.json()).results[0].recallNumber).toBe("27072");
});
