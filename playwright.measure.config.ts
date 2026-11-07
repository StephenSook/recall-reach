import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "e2e/measure",
  timeout: 5 * 60_000,
  retries: 0,
  workers: 1,
  reporter: [["list"]],
  outputDir: "test-results",
  // Waits for /api/health to name EXPECT_BUILD before any test runs against a deployed site.
  globalSetup: "./e2e/support/expectBuild.ts",
  use: { baseURL: process.env.BASE_URL ?? "https://recall-reach-web-e022.onrender.com", trace: "retain-on-failure" },
});
