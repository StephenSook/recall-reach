// A refund lands, every answer is lost, and the seller recovers it from the page. PayPal is faked here.
import { readFileSync, writeFileSync } from "node:fs";
import { expect, test, type Page } from "@playwright/test";

const paypal = () => JSON.parse(readFileSync(process.env.FAKE_PAYPAL_STATE ?? "", "utf8")) as { posts: number; made: number; requestIds: number; orders: number };
const steer = (control: { lose?: number; refuse?: number }) => writeFileSync(process.env.FAKE_PAYPAL_CONTROL ?? "", JSON.stringify(control));

/** A demo shop whose refund landed at PayPal, with all three answers lost. Leaves the browser on the refund page. */
async function refundWithNoAnswer(page: Page) {
  steer({ lose: 3 });
  await page.goto("/");
  await page.getByRole("button", { name: "Try it as a demo shop" }).click();
  await expect(page).toHaveURL(/\/queue$/, { timeout: 60_000 });
  await page.locator('article[data-recall="27027"]').getByRole("button", { name: "Review refund" }).click();
  await page.locator('article[data-recall="27027"]').getByRole("button", { name: "Refund 90.00 USD" }).click();
  await expect(page).toHaveURL(/\/queue\/refunds\/[0-9a-f-]+$/, { timeout: 60_000 });
}

test("a lost refund answer is recovered by asking PayPal again, with one refund made", async ({ page }) => {
  const before = paypal();
  await refundWithNoAnswer(page);

  // PayPal made the refund, but the app never heard. It must not claim either outcome.
  await expect(page.getByTestId("ledger")).toContainText("unconfirmed");
  await expect(page.getByTestId("refund")).toContainText("not held here");
  await expect(page.getByTestId("exceptions")).toContainText("No clear answer from PayPal yet.");
  expect(paypal()).toMatchObject({ posts: before.posts + 3, made: before.made + 1, requestIds: before.requestIds + 1 });

  // One way forward at a time: while a repeat is safe, the seller is not told to refund it by hand.
  await expect(page.getByTestId("stuck")).toHaveCount(0);
  await page.getByRole("button", { name: "Ask PayPal again" }).click();

  await expect(page.getByTestId("ledger")).toContainText("refunded");
  await expect(page.getByTestId("ledger")).toContainText("90.00 USD");
  await expect(page.getByTestId("refund")).toContainText("COMPLETED");
  await expect(page.getByTestId("capture")).toContainText("REFUNDED");
  await expect(page.getByRole("button", { name: "Ask PayPal again" })).toHaveCount(0);
  await expect(page.getByTestId("stuck")).toHaveCount(0);
  expect(paypal()).toMatchObject({ posts: before.posts + 4, made: before.made + 1, requestIds: before.requestIds + 1 });

  await page.goto("/queue");
  await expect(page.locator('article[data-recall="27027"]').getByTestId("refund-state")).toHaveText("Refunded");
  await expect(page.locator('article[data-recall="27027"]').getByRole("button", { name: "Review refund" })).toHaveCount(0);
});

test("a double click on the home page makes one demo shop", async ({ page }) => {
  const before = paypal().orders;
  await page.goto("/");
  await page.getByRole("button", { name: "Try it as a demo shop" }).dblclick();
  await expect(page).toHaveURL(/\/queue$/, { timeout: 60_000 });
  const oneShop = paypal().orders - before;
  await page.waitForTimeout(1500); // a second request, if one went out, would still be finishing
  expect(paypal().orders - before).toBe(oneShop);
  expect(oneShop).toBeLessThanOrEqual(3);
});

test("a refused repeat sends the seller to PayPal, and the line stays blocked", async ({ page }) => {
  await refundWithNoAnswer(page);
  const before = paypal();
  steer({ refuse: 1 });
  await page.getByRole("button", { name: "Ask PayPal again" }).click();

  // PayPal's answer proves nothing about the first send, so nothing here claims the refund failed.
  await expect(page.getByTestId("ledger")).toContainText("unconfirmed");
  await expect(page.getByTestId("exceptions")).toContainText("PayPal refused the repeat (");
  await expect(page.getByTestId("exceptions")).toContainText("REFUND_AMOUNT_EXCEEDED");
  await expect(page.getByRole("button", { name: "Ask PayPal again" })).toHaveCount(0);
  await expect(page.getByTestId("stuck")).toContainText("If no refund shows, refund it there.");
  await expect(page.getByTestId("stuck")).toContainText("DEMO-");

  const refundId = page.url().split("/").pop() ?? "";
  const toPayPal = await page.request.post("/api/queue/refunds/open-paypal", {
    form: { refundId },
    headers: { origin: new URL(page.url()).origin },
    maxRedirects: 0,
  });
  expect(toPayPal.status()).toBe(303);
  expect(toPayPal.headers().location).toBe("https://www.sandbox.paypal.com/unifiedtransactions/");
  await page.reload();
  await expect(page.getByTestId("stuck")).toContainText("Seller sent to PayPal");
  expect(paypal().posts).toBe(before.posts + 1);

  await page.goto("/queue");
  await expect(page.locator('article[data-recall="27027"]').getByRole("button", { name: "Review refund" })).toHaveCount(0);
});
