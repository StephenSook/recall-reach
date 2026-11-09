// Planning follow-ups on the refund-window chart, in a real browser. PayPal is faked, and the advice is seeded, so no model is
// asked: what's tested here is everything around it. server/agent/followUpAdvice.test.ts covers what Claude is sent.
import { expect, test } from "@playwright/test";
import pg from "pg";

const REASON = "This hazard can seriously injure or kill a child quickly, with little warning.";
const SHOTS = process.env.FOLLOW_UP_SHOTS;

test("an owner plans a follow-up, confirms it, and it's still there after a reload", async ({ page }) => {
  // Tall enough for the whole page: a full-page capture resizes the window, and the chart redraws its bars for that.
  if (SHOTS) await page.setViewportSize({ width: 1280, height: 1400 });
  await page.goto("/");
  await page.getByRole("button", { name: "Try it as a demo shop" }).click();
  await expect(page).toHaveURL(/\/queue$/, { timeout: 60_000 });

  const db = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await db.connect();
  let recallNumber = "";
  try {
    // A sale the demo shop made of a confirmed match, whose family hasn't answered.
    const found = await db.query<{ n: string }>(
      `select r.recall_number as n from recall_matches m join recalls r using (recall_id) join shops s on s.id = m.shop_id
       where s.kind = 'DEMO' and m.verdict = 'MATCH' and m.strength = 'CONFIRMED' and m.order_line_id is not null and m.sale_path = 'REFUND_ELIGIBLE' and m.join_state = 'IDENTIFIED'
       order by s.created_at desc limit 1`,
    );
    recallNumber = found.rows[0].n;
    await db.query(
      `insert into follow_up_advice (recall_sha256, agent_version, recall_id, within_days, reason, hazard_quote, model, input_tokens, output_tokens, cost_micros)
       select raw_sha256, '3', recall_id, 3, $1, hazards->>0, 'seeded', 0, 0, 0 from recalls where recall_number = $2 order by recall_date desc limit 1
       on conflict do nothing`,
      [REASON, recallNumber],
    );
  } finally {
    await db.end();
  }

  const href = `/queue/recalls/${recallNumber}`;
  await page.goto(href);
  const panel = page.getByTestId("follow-ups");
  await expect(panel).toContainText("It never sees your sales.");
  await page.getByRole("button", { name: "Plan follow-ups with Claude" }).click();

  const proposals = page.getByTestId("follow-up-proposals");
  await expect(proposals).toContainText(REASON, { timeout: 30_000 });
  await expect(proposals).toContainText("Follow up by");
  await expect(page.locator(".timeline-follow-proposed").first()).toBeVisible();
  // The sale's own bars stay on the chart once it redraws with the follow-ups: a redraw once cleared them.
  await page.waitForTimeout(1200);
  await expect(page.locator(".b-sch-event-wrap:has(.timeline-refund)").first()).toHaveCSS("opacity", "1");
  await expect(page.locator(".b-sch-event-wrap:has(.timeline-follow-proposed)").first()).toHaveCSS("opacity", "1");
  expect((await page.locator(".timeline-follow-proposed").first().boundingBox())?.width ?? 0).toBeGreaterThan(100);
  if (SHOTS) {
    // The chart fades its bars in.
    await page.waitForTimeout(1500);
    await page.screenshot({ path: `${SHOTS}/follow-proposed.png`, fullPage: false });
  }

  // A plan that fails takes the last one off the screen, so nothing out of date can be confirmed.
  const planUrl = `**/api/queue/recalls/${recallNumber}/follow-ups`;
  await page.route(planUrl, (route) => (route.request().method() === "POST" ? route.fulfill({ status: 502, json: { error: "Claude couldn't back a date with CPSC's words, so no dates are proposed." } }) : route.continue()));
  await page.getByRole("button", { name: "Plan follow-ups with Claude" }).click();
  await expect(page.getByTestId("follow-up-message")).toContainText("no dates are proposed");
  await expect(proposals).toHaveCount(0);
  await page.unroute(planUrl);
  await page.getByRole("button", { name: "Plan follow-ups with Claude" }).click();
  await expect(proposals).toContainText(REASON, { timeout: 30_000 });

  await proposals.getByRole("button", { name: "Confirm" }).first().click();
  const confirmed = page.getByTestId("follow-ups-confirmed");
  await expect(confirmed).toContainText(REASON);
  await expect(page.locator(".timeline-follow-confirmed").first()).toBeVisible();
  await page.waitForTimeout(1200);
  await expect(page.locator(".b-sch-event-wrap:has(.timeline-refund)").first()).toHaveCSS("opacity", "1");

  // Dragging a confirmed follow-up moves it, and the server saves the new date.
  const bar = page.locator(".b-sch-event-wrap:has(.timeline-follow-confirmed)").first();
  const at = await bar.boundingBox();
  if (!at) throw new Error("no bar to drag");
  const dateBefore = await confirmed.locator('input[type="date"]').first().inputValue();
  const moved = page.waitForResponse((r) => r.request().method() === "PUT");
  await page.mouse.move(at.x + 30, at.y + at.height / 2);
  await page.mouse.down();
  await page.mouse.move(at.x + 70, at.y + at.height / 2, { steps: 10 });
  await page.mouse.up();
  expect((await moved).status()).toBe(200);
  await expect(confirmed.locator('input[type="date"]').first()).not.toHaveValue(dateBefore);

  // The Delete key doesn't take a bar off the chart: a reminder goes through Dismiss, which saves.
  const beforeKeys = await page.locator(".b-sch-event-wrap").count();
  await page.locator(".b-sch-event-wrap:has(.timeline-follow-confirmed)").first().click();
  await page.keyboard.press("Delete");
  await page.keyboard.press("Backspace");
  await page.waitForTimeout(300);
  expect(await page.locator(".b-sch-event-wrap").count()).toBe(beforeKeys);

  // Dragging across an empty part of the chart adds nothing: every bar here comes from a sale or a saved follow-up.
  const bars = await page.locator(".b-sch-event-wrap").count();
  const chartAt = await page.getByTestId("refund-timeline").boundingBox();
  if (!chartAt) throw new Error("no chart");
  // The Dates row, right of the Today label: nothing is drawn there.
  await page.mouse.move(chartAt.x + 800, chartAt.y + 100);
  await page.mouse.down();
  await page.mouse.move(chartAt.x + 920, chartAt.y + 100, { steps: 8 });
  await page.mouse.up();
  await page.waitForTimeout(400);
  expect(await page.locator(".b-sch-event-wrap").count()).toBe(bars);

  if (process.env.AXE_PATH) {
    await page.addScriptTag({ path: process.env.AXE_PATH });
    const found = await page.evaluate(async () => {
      const axe = (window as unknown as { axe: { run: () => Promise<{ violations: { id: string; nodes: unknown[] }[] }> } }).axe;
      return (await axe.run()).violations.map((v) => `${v.id} x${v.nodes.length}`);
    });
    expect(found).toEqual([]);
  }

  // A date the window can't take is refused by the server, and the saved date stands.
  const day = confirmed.locator('input[type="date"]').first();
  const before = await day.inputValue();
  const refused = page.waitForResponse((r) => r.request().method() === "PUT");
  await day.fill("2020-01-01");
  expect((await refused).status()).toBe(422);
  await expect(page.getByTestId("follow-up-message")).toContainText("gone");

  await page.reload();
  await expect(page.getByTestId("follow-ups-confirmed")).toContainText(REASON);
  expect(await page.getByTestId("follow-ups-confirmed").locator('input[type="date"]').first().inputValue()).toBe(before);
  await expect(page.locator(".timeline-follow-confirmed").first()).toBeVisible();
  if (SHOTS) {
    await page.waitForTimeout(1500);
    await page.screenshot({ path: `${SHOTS}/follow-confirmed.png`, fullPage: false });
  }

  // The queue card shows it. It's a reminder there: nothing was sent.
  await page.goto("/queue");
  await expect(page.getByTestId("follow-up-by").first()).toContainText("Follow up by");

  await page.goto(href);
  await page.getByTestId("follow-ups-confirmed").getByRole("button", { name: "Dismiss" }).first().click();
  await expect(page.getByTestId("follow-ups-confirmed")).toHaveCount(0);
  await page.reload();
  await expect(page.getByTestId("follow-ups-confirmed")).toHaveCount(0);
});
