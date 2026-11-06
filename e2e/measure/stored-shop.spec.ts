// A shop that uploaded before a recall was in the database sees that recall later, with nothing pressed. Two steps on a
// deployment, with the recall arriving between them:
//   PROOF_STEP=upload PROOF_STATE=/path/state.json pnpm exec playwright test --config playwright.measure.config.ts stored-shop
//   PROOF_STEP=after  PROOF_STATE=/path/state.json pnpm exec playwright test --config playwright.measure.config.ts stored-shop
// The state file holds the shop's session, so it stays outside the repo. The last step deletes the shop.
import { expect, test } from "@playwright/test";

const step = process.env.PROOF_STEP;
const state = process.env.PROOF_STATE;
const RECALL = process.env.PROOF_RECALL ?? "22200";
const CSV = `order_number,title,sku,quantity,unit_price,currency,ordered_on
PROOF-1,4moms MamaRoo Multi-Motion Swing,,1,85.00,USD,2022-05-17
`;

test("step 1: a shop uploads, and the recall isn't on its queue yet", async ({ page }) => {
  test.skip(step !== "upload" || !state, "set PROOF_STEP=upload and PROOF_STATE");
  await page.goto("/check");
  await page.getByLabel("Your shop's name").fill("Stored Shop Proof");
  await page.getByLabel("Your order file").setInputFiles({ name: "orders.csv", mimeType: "text/csv", buffer: Buffer.from(CSV) });
  await page.getByRole("button", { name: "Check my file" }).click();
  await expect(page).toHaveURL(/\/queue/, { timeout: 120_000 });
  await expect(page.locator(`article[data-recall="${RECALL}"]`)).toHaveCount(0);
  console.log(`before: ${await page.getByTestId("coverage").innerText()}`);
  console.log(`before cards: ${await page.getByTestId("needs").locator("article").count()}`);
  await page.context().storageState({ path: state! });
});

test.describe("step 2", () => {
  test.use({ storageState: step === "after" ? state : undefined });

  test("the recall is on that shop's queue, with nothing pressed, and the shop is deleted after", async ({ page }) => {
    test.skip(step !== "after" || !state, "set PROOF_STEP=after and PROOF_STATE");
    await page.goto("/queue");
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Stored Shop Proof");
    await expect(page.locator(`article[data-recall="${RECALL}"]`)).toHaveCount(1);
    console.log(`after: ${await page.getByTestId("coverage").innerText()}`);
    console.log(`after cards: ${await page.getByTestId("needs").locator("article").count()}`);
    console.log(`card: ${await page.locator(`article[data-recall="${RECALL}"]`).innerText()}`);

    await page.getByText("Delete my data").click();
    await page.getByRole("button", { name: "Delete everything" }).click();
    await expect(page.locator(".alert")).toHaveText("Your shop's data was deleted.");
  });
});
