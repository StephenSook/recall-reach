import { defineConfig } from "@playwright/test";
import local from "./playwright.local.config";

// The axe pass over the public pages, in Chromium and WebKit, against a local production build: pnpm build, then
// pnpm exec playwright test --config playwright.axe.config.ts. It runs locally, not in CI: CI has no browser.
export default defineConfig({
  ...local,
  testMatch: "axe.spec.ts",
  projects: [
    { name: "chromium", use: { browserName: "chromium" } },
    { name: "webkit", use: { browserName: "webkit" } },
  ],
});
