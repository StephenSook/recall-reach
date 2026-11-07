// Two people running the demo at once, on a running deployment. Neither may see or change the other's shop. Each start makes
// real sandbox captures, so this uses two of a visitor's demo starts. It makes no refund. OTHER_REFUND_ID, if set, is a refund
// row from a third shop, which neither may open.
import { expect, test, type Browser, type Locator, type Page } from "@playwright/test";

/** Each is a browser of its own, with its own cookies and so its own session. */
async function shopper(browser: Browser) {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const page = await context.newPage();
  return { context, page };
}

async function startDemoShop(page: Page) {
  await page.goto("/");
  await page.getByRole("button", { name: "Try it as a demo shop" }).click();
  await expect(page).toHaveURL(/\/queue$/, { timeout: 180_000 });
  await expect(page.getByTestId("needs").locator("article")).toHaveCount(9);
}

const brezza = (page: Page) => page.locator('article[data-recall="27072"]');
const papablic = (page: Page) => page.locator('article[data-recall="27027"]').filter({ hasNotText: "like new" });

async function familyLink(card: Locator) {
  const link = card.getByRole("link", { name: "Open in mail" });
  await expect(link).toBeVisible({ timeout: 30_000 });
  const href = (await link.getAttribute("href")) ?? "";
  const body = new URLSearchParams(href.slice(href.indexOf("?") + 1).replace(/\+/g, "%2B")).get("body") ?? "";
  const found = /https?:\/\/\S+\/r\/\S+/.exec(body);
  expect(found, "the message links to the family page").not.toBeNull();
  return found![0];
}

test("two demo shops started together can't see or change each other's", async ({ browser, baseURL }) => {
  test.setTimeout(600_000);
  const one = await shopper(browser);
  const two = await shopper(browser);
  const family = await shopper(browser);
  try {
    await Promise.all([startDemoShop(one.page), startDemoShop(two.page)]);
    const cookies = async (s: typeof one) => (await s.context.cookies()).map((c) => `${c.name}=${c.value}`).join(";");
    expect(await cookies(one)).not.toBe(await cookies(two));

    // One shop approves a notice. The other's card hasn't moved.
    await brezza(one.page).getByRole("button", { name: "Approve this notice" }).click();
    await expect(brezza(one.page).getByTestId("notice-state")).toHaveText("Prepared");
    await two.page.reload();
    await expect(brezza(two.page).getByRole("button", { name: "Approve this notice" })).toBeVisible();
    await expect(brezza(two.page).getByTestId("notice-state")).toHaveCount(0);

    // Each family's page is its own.
    const linkOne = await familyLink(brezza(one.page));
    await brezza(two.page).getByRole("button", { name: "Approve this notice" }).click();
    const linkTwo = await familyLink(brezza(two.page));
    expect(linkOne).not.toBe(linkTwo);

    // A family answering one shop's notice reaches that shop only.
    await family.page.goto(linkOne);
    await family.page.getByRole("button", { name: "I've stopped using it" }).click();
    await expect(family.page.getByTestId("stopped")).toBeVisible();
    await expect(brezza(one.page).getByTestId("family-report")).toHaveText("Family says they stopped using it. Recall steps not confirmed.", { timeout: 30_000 });
    await two.page.reload();
    await expect(brezza(two.page).getByTestId("family-report")).toHaveCount(0);
    await expect(brezza(two.page).getByTestId("notice-state")).not.toHaveText("Family responded");

    // Sent straight to the server: one shop's match id, in the other's session, changes nothing on the first shop's card.
    const matchId = await papablic(one.page).locator('input[name="matchId"]').first().getAttribute("value");
    expect(matchId).toBeTruthy();
    const headers = { origin: baseURL ?? "" };
    await two.page.request.post("/api/queue/notices", { form: { matchId: matchId! }, headers, maxRedirects: 0 });
    await two.page.request.post("/api/queue/refunds/approve", { form: { matchId: matchId! }, headers, maxRedirects: 0 });
    await one.page.reload();
    await expect(papablic(one.page).getByTestId("notice-state")).toHaveCount(0);
    await expect(papablic(one.page).getByRole("button", { name: /^Refund / })).toHaveCount(0);

    // A refund page belongs to its shop. Neither can open a third shop's.
    const other = process.env.OTHER_REFUND_ID;
    if (other) {
      for (const shop of [one, two]) expect((await shop.page.goto(`/queue/refunds/${other}`))?.status()).toBe(404);
    }

    // Without a session, there's no queue at all.
    const nobody = await browser.newContext();
    const page = await nobody.newPage();
    await page.goto("/queue");
    await expect(page).not.toHaveURL(/\/queue$/);
    await nobody.close();
  } finally {
    await one.context.close();
    await two.context.close();
    await family.context.close();
  }
});
