// The acceptance test for the whole loop, on a running deployment, as a judge would click it. It
// makes real sandbox captures and one real sandbox refund.
import { expect, test, type Browser, type Locator, type Page } from "@playwright/test";

/** A notice, a refund, a mixed basket, two scope gaps, a can't-tell, two sales that could be one order, and the shelf item. */
const DEMO_CARDS = 9;

const recall = (page: Page, number: string) => {
  const cards = page.locator(`article[data-recall="${number}"]`);
  return number === "27027" ? cards.filter({ hasNotText: "like new" }) : cards; // the mixed basket is the same recall
};

// A seller at a shop counter: every window shows. The wide-screen grid has its own test below.
test.use({ viewport: { width: 390, height: 844 } });

async function startDemoShop(page: Page) {
  await page.goto("/");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(
    "Help your resale shop check past sales for recalls and reach the families who bought them.",
  );
  await page.getByRole("button", { name: "Try it as a demo shop" }).click();
  await expect(page).toHaveURL(/\/queue$/, { timeout: 120_000 });
}

/** Reads the prepared message from the mail link the browser built, the way a mail client would. */
async function mailLink(card: Locator) {
  const link = card.getByRole("link", { name: "Open in mail" });
  await expect(link).toBeVisible({ timeout: 30_000 });
  const href = (await link.getAttribute("href")) ?? "";
  expect(href.startsWith("mailto:")).toBe(true);
  const params = new URLSearchParams(href.slice(href.indexOf("?") + 1).replace(/\+/g, "%2B"));
  return { link, subject: params.get("subject") ?? "", body: params.get("body") ?? "" };
}

/** No sideways scrolling, nothing cut off at the edge, and no overflow dots in a chip's cell. */
async function expectToFit(page: Page, grid: Locator) {
  const link = grid.getByRole("link", { name: "Open" }).first();
  await expect(link).toBeVisible();
  const box = await grid.boundingBox();
  const open = await link.boundingBox();
  expect(open!.x + open!.width).toBeLessThanOrEqual(box!.x + box!.width);
  const clipped = await grid.evaluate((el) => {
    const columns = [...el.querySelectorAll(".ag-header-cell")].reduce((sum, c) => sum + c.getBoundingClientRect().width, 0);
    const chips = [...el.querySelectorAll(".chip-cell")].filter((c) => c.scrollWidth > c.clientWidth);
    return { sideways: columns === 0 || columns > el.clientWidth, chips: chips.length };
  });
  expect(clipped).toEqual({ sideways: false, chips: 0 });
}

async function streamToText(stream: NodeJS.ReadableStream): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}

const familyUrl = (body: string) => {
  const found = /https?:\/\/\S+\/r\/\S+/.exec(body);
  expect(found, "the message links to the family page").not.toBeNull();
  return found![0];
};

/** The family has no account and no session: a separate browser, at phone width. */
async function asFamily<T>(browser: Browser, url: string, act: (page: Page) => Promise<T>): Promise<T> {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  try {
    const page = await context.newPage();
    const response = await page.goto(url);
    expect(response?.headers()["referrer-policy"]).toBe("no-referrer");
    return await act(page);
  } finally {
    await context.close();
  }
}

test("a real recall reaches the queue, the family is told, and one eligible sale is refunded", async ({ page, browser }) => {
  await startDemoShop(page);
  await expect(page.getByTestId("coverage")).toContainText(/Searched \d{4}-\d{2}-\d{2} to \d{4}-\d{2}-\d{2}\. \d+ payments? couldn't be identified\./);

  // NOTICE ONLY: this week's real Baby Brezza recall, sold before it.
  const brezza = recall(page, "27072");
  await expect(brezza).toContainText("Needs review");
  await expect(brezza).toContainText("Notice only");
  await expect(brezza).toContainText("model: BRZ0083");
  await expect(brezza).toContainText("DEMO SHOP");
  await expect(brezza).toContainText("Real CPSC");
  await expect(brezza.getByRole("button", { name: /refund/i })).toHaveCount(0);

  await brezza.getByRole("button", { name: "Approve this notice" }).click();
  await expect(brezza.getByTestId("notice-state")).toHaveText("Prepared");

  const { link, subject, body } = await mailLink(brezza);
  expect(subject).toMatch(/^Safety recall: SuperFast Sterilizer Dryers you bought from DEMO SHOP on \d{4}-\d{2}-\d{2}$/);
  expect(body).toContain("The hazard, in CPSC's words:");
  expect(body).toContain("The recalled sterilizer dryers can overheat when plugged in and operating");
  expect(body).toContain("What to do, in CPSC's words:");
  expect(body).toContain("CPSC recall 27072:");
  expect(body).toContain("This isn't the official recall notice, and it isn't marketing.");
  expect(body).not.toMatch(/refund of/i);

  await link.click();
  await expect(brezza.getByTestId("notice-state")).toHaveText("Opened in mail");
  await brezza.getByRole("button", { name: "I sent it" }).click();
  await expect(recall(page, "27072").getByTestId("notice-state")).toHaveText("You marked sent");

  await asFamily(browser, familyUrl(body), async (family) => {
    await expect(family.getByRole("heading", { level: 1 })).toHaveText("This product was recalled");
    await expect(family.getByText("The recalled sterilizer dryers can overheat")).toBeVisible();
    await expect(family.getByRole("link", { name: "Open the maker's recall page" })).toBeVisible();
    await family.getByRole("button", { name: "I've stopped using it" }).click();
    await expect(family.getByTestId("stopped")).toContainText("This does not finish the recall steps.");
    await expect(family.locator("body")).not.toContainText("DEMO-"); // no order data on the family's page
  });

  await page.reload();
  await expect(recall(page, "27072").getByTestId("notice-state")).toHaveText("Family responded");
  await expect(recall(page, "27072").getByTestId("family-report")).toHaveText("Family says they stopped using it");

  // REFUND ELIGIBLE: a real sandbox capture made today, truly after the recall date.
  const papablic = recall(page, "27027");
  await expect(papablic).toContainText("Refund eligible");
  await expect(papablic.getByTestId("tell-cpsc")).toContainText("CPSC recall 27027", { useInnerText: false });

  await papablic.getByRole("button", { name: "Approve this notice" }).click();
  const before = await mailLink(recall(page, "27027"));
  expect(before.body, "no refund line before PayPal confirms one").not.toContain("PayPal confirmed");

  await recall(page, "27027").getByRole("button", { name: "Review refund" }).click();
  await recall(page, "27027").getByRole("button", { name: "Refund 90.00 USD" }).click();
  await expect(page).toHaveURL(/\/queue\/refunds\/[0-9a-f-]+$/, { timeout: 60_000 });

  await expect(page.getByTestId("ledger")).toContainText("refunded");
  await expect(page.getByTestId("ledger")).toContainText("90.00 USD");
  await expect(page.getByTestId("refund")).toContainText("COMPLETED");
  await expect(page.getByTestId("refund")).toContainText("90.00 USD");
  await expect(page.getByTestId("capture")).toContainText("REFUNDED");

  // PayPal's signed webhook arrives on its own time; reconciliation is complete once it does.
  await expect(async () => {
    await page.reload();
    await expect(page.getByTestId("webhook")).toContainText("received and verified", { timeout: 2_000 });
  }).toPass({ timeout: 5 * 60_000, intervals: [10_000] });
  await expect(page.getByTestId("no-exceptions")).toHaveText("All four records agree.");

  // The refund line appears only now that PayPal has confirmed it.
  await page.goto("/queue");
  await expect(recall(page, "27027").getByTestId("refund-state")).toHaveText("Refunded");
  const after = await mailLink(recall(page, "27027"));
  expect(after.body).toContain("PayPal confirmed a refund of 90.00 USD to your original payment.");

  // A second approval for the same sale is refused: nothing can refund it twice.
  await expect(recall(page, "27027").getByRole("button", { name: "Review refund" })).toHaveCount(0);
});

test("a scope gap is settled by a check request that asks what this recall needs", async ({ page, browser }) => {
  await startDemoShop(page);
  // One card per sale. "Costway high chair" also comes close to other high chair recalls, and they stay
  // under its one card rather than each asking the family a question.
  await expect(page.getByTestId("needs").locator("article")).toHaveCount(DEMO_CARDS);
  await expect(page.locator('article[data-recall="27040"]').getByTestId("also")).toContainText("25206");

  const costway = recall(page, "27040");
  await expect(costway).toContainText("Scope gap");
  await expect(costway).toContainText("Missing:");
  await costway.getByRole("button", { name: "Approve this check request" }).click();

  const { subject, body } = await mailLink(recall(page, "27040"));
  expect(subject).toBe("Quick safety check on Costway high chair you bought from DEMO SHOP");
  expect(body).toContain("Can you check one thing? Does your high chair convert into a table and chair set?");
  expect(body).toContain("Until you can check, stop using it and keep it out of children's reach.");
  expect(body.toLowerCase()).not.toContain("your item is recalled");

  await asFamily(browser, familyUrl(body), async (family) => {
    await expect(family.getByRole("heading", { level: 1 })).toHaveText("Please check one thing");
    await expect(family.getByTestId("question")).toHaveText("Does your high chair convert into a table and chair set?");
    await expect(family.getByRole("textbox")).toHaveCount(0); // CPSC says these chairs carry no model number
    await family.getByRole("button", { name: "Yes", exact: true }).click();
    await expect(family.getByTestId("check-answer")).toHaveText(
      "Yours looks like the recalled product. Please stop using it and follow the steps below.",
    );
  });

  await page.reload();
  await expect(recall(page, "27040").getByTestId("notice-state")).toHaveText("Family responded");
  await expect(recall(page, "27040").getByTestId("check-result")).toHaveText("Family's answer matches the recall");
});

test.describe("on a wide screen", () => {
  test.use({ viewport: { width: 1280, height: 800 } });

  test("the grid finds every candidate, approves only a sale's lead, and exports no buyer data", async ({ page }) => {
    await startDemoShop(page);
    const grid = page.getByTestId("match-grid");
    const rows = grid.locator(".ag-row[row-id]:not(.ag-row-pinned)");
    await expect(rows).toHaveCount(DEMO_CARDS);
    // The payment that says only an amount is listed, and never counted as cleared.
    await grid.getByRole("button", { name: "Couldn't identify (1)" }).click();
    await expect(rows).toHaveCount(1);
    await expect(rows.first()).toContainText("42.00 USD");
    await grid.getByRole("button", { name: /^Needs review/ }).click();
    await expect(rows).toHaveCount(DEMO_CARDS);
    await expectToFit(page, grid);
    // Sales in one order, the cards' order: the two confirmed, newest recall first.
    await expect(rows.nth(0)).toContainText("27072");

    await grid.getByRole("button", { name: /^All candidates/ }).click();
    await expect.poll(() => rows.count()).toBeGreaterThan(3);
    await grid.getByPlaceholder("Filter").fill("25206");
    await expect(rows).toHaveCount(1);
    await expect(rows.first()).toContainText("25206");
    // Another recall on a sale that already has a lead. Approving it could send the wrong message, so it can't be picked.
    await expect(rows.first().locator("input[type=checkbox]")).toBeDisabled();
    await grid.getByPlaceholder("Filter").fill("");

    await grid.getByRole("button", { name: /^Pull from the shelf/ }).click();
    await expect(rows).toHaveCount(1);
    await expect(rows.first()).toContainText("27018");
    await grid.getByRole("button", { name: /^Needs review/ }).click();
    await expect(rows).toHaveCount(DEMO_CARDS);
    const download = page.waitForEvent("download");
    await grid.getByRole("button", { name: "Export Tell CPSC list" }).click();
    const csv = await streamToText(await (await download).createReadStream());
    expect(csv).toContain("27027");
    expect(csv).not.toContain("27072"); // sold before the recall: not on this list
    expect(csv).not.toContain("@");
    expect(csv).not.toContain("gray stars"); // the shop's own words stay out

    // Nothing is printed twice: the windows wait until a row opens one.
    await expect(recall(page, "27040")).toBeHidden();
    const costway = rows.filter({ hasText: "27040" });
    await costway.getByRole("link", { name: "Open" }).click();
    await expect(recall(page, "27040")).toBeVisible();
    await expect(recall(page, "27072")).toBeHidden();

    // The whole row opens it too, and the checkbox only picks it.
    await rows.filter({ hasText: "27072" }).getByText("SuperFast Sterilizer Dryers").click();
    await expect(recall(page, "27072")).toBeVisible();
    await expect(recall(page, "27040")).toBeHidden();
    await costway.locator("input[type=checkbox]").first().check();
    await expect(recall(page, "27072")).toBeVisible();

    await grid.getByRole("button", { name: "Approve selected (1)" }).click();
    await rows.filter({ hasText: "27040" }).getByRole("link", { name: "Open" }).click();
    await expect(recall(page, "27040").getByTestId("notice-state")).toHaveText("Prepared");

    // An action keeps its window open.
    await rows.filter({ hasText: "27072" }).getByRole("link", { name: "Open" }).click();
    await recall(page, "27072").getByRole("button", { name: "Approve this notice" }).click();
    await expect(recall(page, "27072").getByTestId("notice-state")).toHaveText("Prepared");
    await expect(recall(page, "27072")).toBeVisible();
  });

  test("the grid fits a larger window too", async ({ page }) => {
    await page.setViewportSize({ width: 1456, height: 900 });
    await startDemoShop(page);
    await expectToFit(page, page.getByTestId("match-grid"));
  });
});

test("the eval card shows held-out numbers, with their limits on the page", async ({ page }) => {
  await page.goto("/eval");
  await expect(page.getByTestId("eval-sentence")).toContainText(/\d+ of \d+/);
  await expect(page.getByTestId("eval-table")).toContainText("Word match");
  await expect(page.getByText("One labeller")).toBeVisible();
  const { scroll, client } = await page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, client: document.documentElement.clientWidth }));
  expect(scroll).toBeLessThanOrEqual(client);
});

test.describe("Recall Replay", () => {
  test.use({ viewport: { width: 1280, height: 800 } });

  test("runs every recall with a clock, and anyone can recount it", async ({ page }) => {
    await page.goto("/replay");
    const button = page.getByRole("button", { name: /^Run it/ });
    await button.click();
    await expect(page).toHaveURL(/\/replay\/[0-9a-f-]{36}$/, { timeout: 120_000 });
    await expect(page.getByTestId("clock")).toContainText(/\d+ recalls in \d+\.\d seconds/);
    const grid = page.getByTestId("replay-grid");
    await expect(grid.locator(".ag-row[row-id]").first()).toBeVisible();
    await grid.getByRole("button", { name: /^Matched/ }).click();
    await expect(grid.locator(".ag-row[row-id]").first()).toContainText("Matched");

    const runId = new URL(page.url()).pathname.split("/").pop();
    const proof = await (await page.request.get(`/api/proof/${runId}`)).json();
    expect(proof.agree).toBe(true);
    expect(proof.recomputed.checked).toBeGreaterThan(900);
    expect(proof.recomputed.matched + proof.recomputed.scopeGaps + proof.recomputed.cleared + proof.recomputed.notNear).toBe(proof.recomputed.checked);
    await expect(page.locator("body")).not.toContainText("DEMO-HIST");
  });
});

test.describe("on a phone", () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test("the windows do the work: no grid, and nothing runs off the screen", async ({ page }) => {
    await startDemoShop(page);
    await expect(recall(page, "27040")).toBeVisible();
    await expect(page.getByTestId("match-grid")).toHaveCount(0);
    const { scroll, client } = await page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, client: document.documentElement.clientWidth }));
    expect(scroll).toBeLessThanOrEqual(client);
  });
});
