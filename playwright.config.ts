import { defineConfig } from "@playwright/test";

// The golden path, on a running deployment:
//   pnpm test:golden                      against the live service
//   BASE_URL=http://localhost:3000 pnpm test:golden
export default defineConfig({
  testDir: "e2e",
  testIgnore: ["local/**", "measure/**", "support/**"], // local fakes PayPal (playwright.local.config.ts); measure is run on purpose; support holds helpers and their vitest tests
  timeout: 8 * 60_000,
  retries: 0,
  workers: 1,
  reporter: [["list"]],
  outputDir: "test-results",
  // Waits for /api/health to name EXPECT_BUILD before any test runs against a deployed site.
  globalSetup: "./e2e/support/expectBuild.ts",
  use: {
    baseURL: process.env.BASE_URL ?? "https://recall-reach-web-e022.onrender.com",
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
  },
});
