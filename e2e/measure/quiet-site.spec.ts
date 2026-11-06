// What someone finds on a quiet day: no demo shop exists and nobody has pressed anything. The site is only worth
// checking this way after its demo shops have been deleted, which this can't do itself:
//   BASE_URL=http://localhost:3111 pnpm exec playwright test --config playwright.measure.config.ts quiet-site
// QUIET_OLD_COOKIE names a file holding a session for a shop that has since been deleted. The last test makes a shop.
import { readFileSync } from "node:fs";
import { expect, test } from "@playwright/test";

const businessDate = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", dateStyle: "medium" }).format(new Date());

const PAGES: [path: string, heading: string, shows: string][] = [
  ["/", "Help your resale shop check past sales for recalls and reach the families who bought them.", "Try it as a demo shop"],
  ["/judge", "Three minutes, no login", "Try it as a demo shop"],
  ["/eval", "", "held-out"],
  ["/safety", "Safety checks", "refused"],
  ["/evidence/paypal", "How it uses PayPal", "PayPal"],
  ["/evidence/ag-grid", "How it uses AG Grid", "AG Grid"],
  ["/privacy", "Privacy", "48"],
  ["/check", "", "order file"],
];

for (const [path, heading, shows] of PAGES) {
  test(`${path} shows real content with no shops`, async ({ page }) => {
    const problems: string[] = [];
    page.on("console", (m) => {
      if (m.type() === "error") problems.push(m.text());
    });
    page.on("pageerror", (e) => problems.push(e.message));
    page.on("response", (r) => {
      if (r.status() >= 400 && r.url().startsWith(new URL(page.url() || "http://x").origin)) problems.push(`${r.status()} ${r.url()}`);
    });
    const res = await page.goto(path);
    expect(res?.status(), path).toBe(200);
    if (heading) await expect(page.getByRole("heading", { level: 1 })).toHaveText(heading);
    else await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    await expect(page.locator("main")).toContainText(shows);
    await expect(page.locator("main").getByRole("alert")).toHaveCount(0);
    await page.waitForLoadState("networkidle");
    expect(problems).toEqual([]);
  });
}

test("Safety has results to show, every one refused", async ({ page }) => {
  await page.goto("/safety");
  const attacks = page.getByTestId("safety-results").locator("[data-attack]");
  await expect(attacks).toHaveCount(5);
  await expect(page.locator('[data-attack][data-outcome="REFUSED"]')).toHaveCount(5);
});

test("Replay goes straight to a run made today, with numbers, and nothing said to be missing", async ({ page, request }) => {
  await page.goto("/replay");
  await expect(page).toHaveURL(/\/replay\/[0-9a-f-]{36}$/);
  const runId = new URL(page.url()).pathname.split("/").pop() ?? "";
  await expect(page.getByTestId("ran-at")).toContainText(`Run ${businessDate}`);
  await expect(page.getByTestId("replay-gap")).toHaveCount(0);
  await expect(page.locator("main p").first()).toContainText("Every real CPSC recall from 2025 on");
  const checked = Number(await page.getByTestId("replay-counts").locator(".stat-value").first().innerText());
  expect(checked).toBeGreaterThan(900);

  const proof = await (await request.get(`/api/proof/${runId}`)).json();
  expect(proof).toMatchObject({ agree: true, sameRecalls: true, recallYearsMissing: [] });
  expect(proof.search.complete).toBe(true);
  expect(Date.now() - Date.parse(proof.ranAt)).toBeLessThan(26 * 3_600_000);
});

test("the public API answers with recalls", async ({ request }) => {
  const day = await request.get("/api/recalls/today/matches?shop=demo");
  expect(day.status()).toBe(200);
  const body = await day.json();
  expect(body.recalls.length).toBeGreaterThan(0);
  expect(body.recallDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
});

test("health is ok", async ({ request }) => {
  const res = await request.get("/api/health");
  const body = await res.json();
  expect(body.checks).toEqual({ database: true, webhook: true, lastPull: true, purge: true, poll: true, replay: true });
  expect(res.status()).toBe(200);
});

test("a session for a deleted shop goes back to the home page, not to an empty queue", async ({ context, page, baseURL }) => {
  const file = process.env.QUIET_OLD_COOKIE;
  test.skip(!file, "needs QUIET_OLD_COOKIE");
  const value = readFileSync(file ?? "", "utf8").trim();
  await context.addCookies([{ name: "rr_session", value, url: baseURL ?? "" }]);
  const res = await page.goto("/queue");
  expect(res?.status()).toBe(200);
  await expect(page).toHaveURL(new RegExp(`^${baseURL}/?$`));
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
});

test("the home button makes a working shop from nothing, with every demo card", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  await page.getByRole("button", { name: "Try it as a demo shop" }).click();
  await expect(page).toHaveURL(/\/queue$/, { timeout: 120_000 });
  await expect(page.getByTestId("needs").locator("article")).toHaveCount(9);
  await expect(page.locator("main").getByRole("alert")).toHaveCount(0);
});
