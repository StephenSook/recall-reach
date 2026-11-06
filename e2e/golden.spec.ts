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
  // A public demo never shows, or sends to, a real inbox.
  expect(decodeURIComponent(href.slice(0, href.indexOf("?")))).toMatch(/^mailto:([^@\s]*@example\.com)?$/);
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
    await expect(family.getByTestId("stopped")).toBeInViewport({ ratio: 1 });
    await expect(family.locator("body")).not.toContainText("DEMO-"); // no order data on the family's page
  });

  // No reload: the seller's page sees it by itself, and the status and the wait count move with it.
  await expect(recall(page, "27072").getByTestId("notice-state")).toHaveText("Family responded", { timeout: 15_000 });
  await expect(recall(page, "27072").locator(".chips")).toContainText("Family responded");
  await expect(recall(page, "27072").locator(".chips")).not.toContainText("Needs review");
  await expect(page.locator(".page-head")).toContainText("8 items wait for you");
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

  // PayPal's signed webhook arrives on its own time; reconciliation is complete once it does. No reload: the page sees it by itself.
  await expect(page.getByTestId("webhook")).toContainText("received and verified", { timeout: 170_000 });
  await expect(page.getByTestId("no-exceptions")).toHaveText("All four records agree.");

  // The refund line appears only now that PayPal has confirmed it.
  await page.goto("/queue");
  await expect(recall(page, "27027").getByTestId("refund-state")).toHaveText("Refunded");
  await expect(recall(page, "27027").locator(".chips")).toContainText("Refunded");
  await expect(recall(page, "27027").locator(".chips")).not.toContainText("Refund eligible");
  // Refunded with the notice not sent: the family still has to be told, so it still waits.
  await expect(page.locator(".page-head")).toContainText("8 items wait for you");
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

  await expect(recall(page, "27040").getByTestId("notice-state")).toHaveText("Family responded", { timeout: 15_000 });
  await expect(recall(page, "27040").getByTestId("check-result")).toHaveText("Family's answer matches the recall");
  await expect(recall(page, "27040").locator(".chips")).toContainText("Family's answer matches");
  await expect(recall(page, "27040").locator(".chips")).not.toContainText("Scope gap");
  await expect(recall(page, "27040").locator(".chips")).not.toContainText(/confirmed/i);
  await expect(page.locator(".page-head")).toContainText("8 items wait for you");
});

test.describe("on a wide screen", () => {
  test.use({ viewport: { width: 1280, height: 800 } });

  test("the grid finds every candidate, approves only a sale's lead, and exports no buyer data", async ({ page, browser }) => {
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

    // An action keeps its window open, and on screen: the grid draws late, and must not push it off.
    await rows.filter({ hasText: "27072" }).getByRole("link", { name: "Open" }).click();
    await recall(page, "27072").getByRole("button", { name: "Approve this notice" }).click();
    await expect(recall(page, "27072").getByTestId("notice-state")).toHaveText("Prepared");
    await expect(recall(page, "27072").getByTestId("notice-state")).toBeInViewport({ ratio: 1 });
    await rows.filter({ hasText: "27027" }).first().getByRole("link", { name: "Open" }).click();
    await recall(page, "27027").getByRole("button", { name: "Review refund" }).click();
    await expect(recall(page, "27027").getByRole("button", { name: "Refund 90.00 USD" })).toBeInViewport({ ratio: 1 });

    // Sent is done: the row, the tab counts and the wait count all move, and the row can still be found.
    await grid.getByRole("button", { name: /^All candidates/ }).click();
    await rows.filter({ hasText: "BRZ0083" }).first().getByRole("link", { name: "Open" }).click();
    const { link } = await mailLink(recall(page, "27072"));
    await link.click();
    await recall(page, "27072").getByRole("button", { name: "I sent it" }).click();
    await expect(recall(page, "27072").getByTestId("notice-state")).toHaveText("You marked sent");
    await expect(recall(page, "27072").locator(".chips")).toContainText("You marked sent");
    await expect(page.locator(".page-head")).toContainText("8 items wait for you");
    await expect(grid.getByRole("button", { name: "Needs review (8)" })).toBeVisible();
    await expect(rows).toHaveCount(8);
    await expect(rows.filter({ hasText: "BRZ0083" })).toHaveCount(0);
    await grid.getByRole("button", { name: "Done (1)" }).click();
    await expect(rows).toHaveCount(1);
    await expect(rows.first()).toContainText("You marked sent");

    // A family's answer moves a sale to Done with no reload, and its open card stays open and on screen.
    await grid.getByRole("button", { name: /^Needs review/ }).click();
    await rows.filter({ hasText: "27040" }).getByRole("link", { name: "Open" }).click();
    const question = await mailLink(recall(page, "27040"));
    await asFamily(browser, familyUrl(question.body), async (family) => {
      await family.getByRole("button", { name: "Yes", exact: true }).click();
      await expect(family.getByTestId("check-answer")).toBeVisible();
    });
    await expect(recall(page, "27040").locator(".chips")).toContainText("Family's answer matches", { timeout: 15_000 });
    await expect(recall(page, "27040")).toBeVisible();
    await expect(recall(page, "27040").getByTestId("check-result")).toBeInViewport({ ratio: 1 });
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
  // The limit sits with the number, in the very next row.
  await expect(page.getByRole("row", { name: /A look-alike could reach a family/ }).locator("xpath=following-sibling::tr[1]")).toContainText("One labeller");
  // The true count, with why the rest ask.
  await expect(page.getByTestId("eval-stated-table")).toContainText("53 of 60");
  await expect(page.getByTestId("eval-stated-limited")).toContainText("The other 7 ask instead. On 5 of them CPSC limits the recall within the model");
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
    await expect(page.getByTestId("ran-at")).toHaveText(/^Run [A-Z][a-z]{2} \d{1,2}, \d{4}, \d{1,2}:\d{2} [AP]M ET\.$/);
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

for (const width of [1280, 390]) {
  test(`no page anyone can open logged out runs off the side at ${width} wide`, async ({ page }) => {
    await page.setViewportSize({ width, height: 844 });
    for (const path of ["/", "/judge", "/replay", "/safety", "/eval", "/evidence/paypal", "/evidence/ag-grid", "/evidence/api", "/evidence/channel3", "/sweep/27072", "/privacy", "/check"]) {
      await page.goto(path);
      const { scroll, client } = await page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, client: document.documentElement.clientWidth }));
      expect.soft(scroll, `${path} at ${width}`).toBeLessThanOrEqual(client);
    }
  });
}

test.describe("a recall's refund windows", () => {
  test.use({ viewport: { width: 1280, height: 800 } });

  test("draws each sale's window from the card, survives a resize, and leaves the queue as it found it", async ({ page, baseURL }) => {
    const crashes: string[] = [];
    page.on("pageerror", (e) => crashes.push(String(e)));
    await startDemoShop(page);
    const elsewhere: string[] = [];
    page.on("request", (r) => {
      if (!r.url().startsWith(baseURL ?? "") && !r.url().startsWith("data:")) elsewhere.push(new URL(r.url()).host);
    });

    const card = page.locator('article[data-recall="27027"]').first();
    await page.getByTestId("match-grid").locator(`a[href="#${await card.getAttribute("id")}"]`).click();
    await card.getByText("Why this came up").click();
    await card.getByRole("link", { name: "Refund windows" }).click();
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Refund windows");
    const timeline = page.getByTestId("refund-timeline");
    await expect(timeline.locator(".b-sch-event")).toHaveCount(2);
    await expect(timeline.locator(".b-sch-event").first()).toContainText("Sold after the recall");
    await expect(timeline).toHaveCSS("opacity", "1");
    const x = async (id: string) => (await page.getByTestId(id).boundingBox())?.x ?? 0;
    expect(await x("line-recall")).toBeGreaterThan(0);
    expect(await x("line-recall")).toBeLessThan(await x("line-today"));
    // A sale made after the recall starts right of its line, and 180 days are most of a fitted axis.
    const bar = await timeline.locator(".b-sch-event").first().boundingBox();
    expect(bar?.x ?? 0).toBeGreaterThan(await x("line-recall"));
    expect(bar?.width ?? 0).toBeGreaterThan(300);
    await expect(page.getByTestId("timeline-list").locator("li")).toHaveCount(2);
    expect(elsewhere).toEqual([]);

    await page.setViewportSize({ width: 390, height: 844 });
    await expect(timeline).toHaveCount(0);
    await expect(page.getByTestId("timeline-list").locator("li")).toHaveCount(2);
    const { scroll, client } = await page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, client: document.documentElement.clientWidth }));
    expect(scroll).toBeLessThanOrEqual(client);

    await page.setViewportSize({ width: 1280, height: 800 });
    await expect(timeline.locator(".b-sch-event")).toHaveCount(2);
    await expect(page.getByTestId("line-today")).toHaveCount(1);

    await page.getByRole("link", { name: "Back to the queue" }).click();
    await expect(page.getByTestId("match-grid")).toBeVisible();
    expect(await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue("--b-primary"))).toBe("");
    expect(crashes).toEqual([]);

    // A near miss that cleared gets nothing, so it isn't on the line.
    await page.goto("/queue/recalls/27072");
    await expect(timeline.locator(".b-sch-event")).toHaveCount(1);
    await expect(timeline.locator(".b-sch-event").first()).toContainText("a notice, not a refund");
    await expect(page.getByRole("main")).not.toContainText("Formula Pro");

    // A scope gap isn't told it gets a notice.
    await page.goto("/queue/recalls/27040");
    await expect(timeline.locator(".b-sch-event").first()).toContainText("Not a confirmed match");

    expect((await page.goto("/queue/recalls/00000"))?.status()).toBe(404);
  });
});

test("the safety checks run live, and every one is refused", async ({ page }) => {
  await page.goto("/safety");
  await page.getByRole("button", { name: /^Run them/ }).click();
  await expect(page).toHaveURL(/\/safety$/, { timeout: 60_000 });
  await expect(page.getByTestId("safety-clock")).toContainText("5 of 5 refused");
  await expect(page.locator('article[data-outcome="REFUSED"]')).toHaveCount(5);
  await expect(page.locator('article[data-attack="forged-webhook"]')).toContainText("401");
});

test("the judge's door works logged out, and every page it names is there", async ({ page, request }) => {
  await page.goto("/");
  await page.getByRole("link", { name: "Judging this? Start here" }).click();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Three minutes, no login");
  await expect(page.getByRole("button", { name: "Try it as a demo shop" })).toBeVisible();
  for (const [path, heading] of [
    ["/evidence/paypal", "How it uses PayPal"],
    ["/evidence/ag-grid", "How it uses AG Grid"],
    ["/privacy", "Privacy"],
    ["/safety", "Safety checks"],
    ["/replay", "Recall Replay"],
  ]) {
    await page.goto(path);
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(heading);
  }
  const health = await request.get("/api/health");
  expect(health.ok()).toBe(true);
  const day = await request.get("/api/recalls/today/matches?shop=demo");
  expect(day.ok()).toBe(true);
  expect((await day.json()).recalls.length).toBeGreaterThan(0);
  expect((await request.get("/api/recalls/today/matches?shop=other")).status()).toBe(400);

  const checked = await (await request.get("/api/check?title=Baby%20Brezza%20sterilizer&model=BRZ0083")).json();
  expect(checked.results[0]).toMatchObject({ recallNumber: "27072", verdict: "MATCH" });
  const mcp = await request.post("/api/mcp", {
    headers: { accept: "application/json, text/event-stream" },
    data: { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "check_recall", arguments: { title: "Baby Brezza sterilizer", model: "BRZ0083" } } },
  });
  expect(mcp.ok()).toBe(true);
  expect(JSON.parse((await mcp.json()).result.content[0].text).results[0].recallNumber).toBe("27072");
  expect(await (await request.get("/openapi.yaml")).text()).toContain("openapi: 3");
  await page.goto("/sweep/27072");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("On the market now");
  await expect(page.locator("main")).not.toContainText("was recalled");
  await page.goto("/evidence/channel3");
  await expect(page.getByTestId("sweep-totals")).toContainText("recalls searched");
  await page.goto("/evidence/api");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("For agents and marketplaces");
  await expect(page.getByTestId("public-calls")).toContainText("through the tool");
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
