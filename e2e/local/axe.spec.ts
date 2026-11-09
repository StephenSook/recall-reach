// axe-core on every public page a judge is sent to, at desktop and phone width, in each browser the config names. A view
// passes only with zero violations. Run with playwright.axe.config.ts; each view is its own test, so the count is in the
// run's "passed" line.
import { resolve } from "node:path";
import { expect, test } from "@playwright/test";

const AXE = resolve("node_modules/axe-core/axe.min.js");

const AXE_PAGES = [
  "/",
  "/judge",
  "/check",
  "/check?title=Baby+Brezza+sterilizer&model=BRZ0083",
  "/r/sample",
  "/replay",
  "/eval",
  "/safety",
  "/shopper",
  "/status",
  "/privacy",
  "/evidence/paypal",
  "/evidence/api",
];
const SIZES = [
  { name: "desktop", width: 1280, height: 900 },
  { name: "phone", width: 390, height: 844 },
];

for (const path of AXE_PAGES) {
  for (const size of SIZES) {
    test(`${path} at ${size.name} width has no axe violations`, async ({ page }) => {
      await page.setViewportSize({ width: size.width, height: size.height });
      const res = await page.goto(path);
      expect(res?.status(), "the page answers").toBeLessThan(400);
      await page.waitForLoadState("networkidle");
      await page.addScriptTag({ path: AXE });
      const found = await page.evaluate(async () => {
        const axe = (window as unknown as { axe: { run: () => Promise<{ violations: { id: string; impact: string | null; nodes: { target: unknown[] }[] }[] }> } }).axe;
        return (await axe.run()).violations.map((v) => `${v.id} (${v.impact}) x${v.nodes.length}: ${JSON.stringify(v.nodes[0]?.target)}`);
      });
      expect(found).toEqual([]);
    });
  }
}

test("the check can fail: an image with no text alternative is reported", async ({ page }) => {
  await page.goto("/judge");
  await page.evaluate(() => document.querySelector("main")?.insertAdjacentHTML("beforeend", '<img src="/ios-qr.svg" width="20" height="20">'));
  await page.addScriptTag({ path: AXE });
  const ids = await page.evaluate(async () => {
    const axe = (window as unknown as { axe: { run: () => Promise<{ violations: { id: string }[] }> } }).axe;
    return (await axe.run()).violations.map((v) => v.id);
  });
  expect(ids).toContain("image-alt");
});
