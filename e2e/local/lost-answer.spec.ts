// A refund lands, every answer is lost, and the seller recovers it from the page. PayPal is faked here.
import { readFileSync } from "node:fs";
import { expect, test } from "@playwright/test";

const paypal = () => JSON.parse(readFileSync(process.env.FAKE_PAYPAL_STATE ?? "", "utf8")) as { posts: number; made: number; requestIds: number };

test("a lost refund answer is recovered by asking PayPal again, with one refund made", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Try it as a demo shop" }).click();
  await expect(page).toHaveURL(/\/queue$/, { timeout: 60_000 });

  const papablic = page.locator('article[data-recall="27027"]');
  await papablic.getByRole("button", { name: "Review refund" }).click();
  await page.locator('article[data-recall="27027"]').getByRole("button", { name: "Refund 90.00 USD" }).click();
  await expect(page).toHaveURL(/\/queue\/refunds\/[0-9a-f-]+$/, { timeout: 60_000 });

  // PayPal made the refund, but the app never heard. It must not claim either outcome.
  await expect(page.getByTestId("ledger")).toContainText("unconfirmed");
  await expect(page.getByTestId("refund")).toContainText("not held here");
  await expect(page.getByTestId("exceptions")).toContainText("No clear answer from PayPal yet.");
  expect(paypal()).toEqual({ posts: 3, made: 1, requestIds: 1 });

  // The seller is not left at a dead end: they are told where to look, by a number they recognize.
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

  await page.getByRole("button", { name: "Ask PayPal again" }).click();

  await expect(page.getByTestId("ledger")).toContainText("refunded");
  await expect(page.getByTestId("ledger")).toContainText("90.00 USD");
  await expect(page.getByTestId("refund")).toContainText("COMPLETED");
  await expect(page.getByTestId("capture")).toContainText("REFUNDED");
  await expect(page.getByRole("button", { name: "Ask PayPal again" })).toHaveCount(0);
  await expect(page.getByTestId("stuck")).toHaveCount(0);
  expect(paypal()).toEqual({ posts: 4, made: 1, requestIds: 1 });

  await page.goto("/queue");
  await expect(page.locator('article[data-recall="27027"]').getByTestId("refund-state")).toHaveText("Refunded");
  await expect(page.locator('article[data-recall="27027"]').getByRole("button", { name: "Review refund" })).toHaveCount(0);
});
