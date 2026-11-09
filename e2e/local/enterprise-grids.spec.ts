// The Enterprise features on the queue and Recall Replay, in a real browser, with the licence the deployed site uses.
import { expect, test, type Page } from "@playwright/test";

const SHOTS = process.env.GRID_SHOTS;
const noLicenceComplaint = (logs: string[]) => expect(logs.filter((l) => /licen[cs]e|trial|watermark/i.test(l))).toEqual([]);

async function watchConsole(page: Page) {
  const logs: string[] = [];
  page.on("console", (m) => logs.push(m.text()));
  page.on("pageerror", (e) => logs.push(String(e)));
  return logs;
}

test("the queue groups, filters, totals, exports and charts", async ({ page }) => {
  await page.setViewportSize({ width: 1600, height: 1200 });
  const logs = await watchConsole(page);
  await page.goto("/");
  await page.getByRole("button", { name: "Try it as a demo shop" }).click();
  await expect(page).toHaveURL(/\/queue$/, { timeout: 60_000 });
  const grid = page.getByTestId("match-grid");
  await expect(grid.locator(".ag-row[row-id]").first()).toBeVisible();
  await expect(grid.locator(".ag-status-bar")).toContainText("Rows");
  await expect(grid.locator(".ag-side-bar")).toBeVisible();
  await expect(page.getByTestId("refund-total")).toContainText("Refund eligible");
  if (process.env.AG_GRID_LICENSE_KEY) {
    await expect(page.locator(".ag-watermark").first()).toBeHidden();
    noLicenceComplaint(logs);
  }

  await grid.getByRole("button", { name: "All candidates" }).click();
  await grid.getByRole("button", { name: "By recall", exact: true }).click();
  const group = grid.locator(".ag-row-group").first();
  await expect(group).toBeVisible();
  await expect(group).toContainText("$");
  if (SHOTS) {
    await page.waitForTimeout(800);
    await page.screenshot({ path: `${SHOTS}/grid-grouped.png` });
  }
  await group.locator(".ag-group-contracted").first().click();
  await expect(grid.locator(".ag-row[row-id]:not(.ag-row-group)").first()).toBeVisible();

  // Changing the group replaces it: the grid keeps a group the columns don't mention unless it's told otherwise.
  await grid.getByRole("button", { name: "By state", exact: true }).click();
  await expect(grid.locator('.ag-row-group[aria-level="1"]').first()).toBeVisible();
  await expect(grid.locator('.ag-row-group[aria-level="2"]')).toHaveCount(0);
  await expect(grid.locator(".ag-header-cell", { hasText: "Recall" }).first()).toBeVisible();
  await grid.getByRole("button", { name: "No groups" }).click();
  await expect(grid.locator(".ag-row-group")).toHaveCount(0);
  await grid.getByRole("button", { name: "By recall", exact: true }).click();
  await expect(grid.locator(".ag-row-group").first()).toBeVisible();

  // The right-click menu doesn't offer a way round the export rules.
  await grid.locator(".ag-row-group").first().locator(".ag-cell").first().click({ button: "right" });
  const menu = page.locator(".ag-menu").first();
  await expect(menu).toContainText("Copy");
  await expect(menu).not.toContainText("Export");
  await page.keyboard.press("Escape");

  const download = page.waitForEvent("download");
  await grid.getByRole("button", { name: "Export to Excel" }).click();
  expect((await download).suggestedFilename()).toBe("recall-queue.xlsx");

  // A chart reads group rows as well as sales, so the two can't be on at once.
  await expect(grid.getByRole("button", { name: "Chart sales" })).toBeDisabled();
  await grid.getByRole("button", { name: "No groups" }).click();
  await grid.getByRole("button", { name: "Chart sales" }).click();
  const chart = page.getByTestId("grid-chart");
  await expect(chart.locator("canvas").first()).toBeVisible({ timeout: 15_000 });
  if (SHOTS) {
    await chart.scrollIntoViewIfNeeded();
    await page.waitForTimeout(1200);
    await page.screenshot({ path: `${SHOTS}/grid-chart.png` });
  }
  await grid.getByRole("button", { name: "Hide chart" }).click();
  await expect(chart.locator("canvas")).toHaveCount(0);

  await grid.getByRole("button", { name: "Chart sales" }).click();
  await expect(chart.locator("canvas").first()).toBeVisible({ timeout: 15_000 });
  await grid.getByRole("button", { name: "By state", exact: true }).click();
  await expect(chart.locator("canvas")).toHaveCount(0);
  await grid.getByRole("button", { name: "No groups" }).click();
  expect(logs.filter((l) => /AG Grid: error|is not registered|Missing module/i.test(l))).toEqual([]);
});

test("Recall Replay groups and exports", async ({ page }) => {
  await page.setViewportSize({ width: 1600, height: 1200 });
  const logs = await watchConsole(page);
  await page.goto("/");
  await page.getByRole("button", { name: "Try it as a demo shop" }).click();
  await expect(page).toHaveURL(/\/queue$/, { timeout: 60_000 });
  await page.goto("/replay");
  await page.getByRole("button", { name: /^Run/ }).first().click();
  await expect(page).toHaveURL(/\/replay\/[0-9a-f-]+$/, { timeout: 120_000 });
  const grid = page.getByTestId("replay-grid");
  await expect(grid.locator(".ag-row[row-id]").first()).toBeVisible();
  await expect(grid.locator(".ag-status-bar")).toContainText("Rows");
  await grid.getByRole("button", { name: "By outcome" }).click();
  await expect(grid.locator(".ag-row-group").first()).toContainText(/Matched|Can't tell yet|Cleared|Nothing near/);
  const download = page.waitForEvent("download");
  await grid.getByRole("button", { name: "Export to Excel" }).click();
  expect((await download).suggestedFilename()).toBe("recall-replay.xlsx");
  if (SHOTS) {
    await page.waitForTimeout(800);
    await page.screenshot({ path: `${SHOTS}/grid-replay.png` });
  }
  expect(logs.filter((l) => /AG Grid: error|is not registered|Missing module/i.test(l))).toEqual([]);
});
