import { defineConfig } from "@playwright/test";

// The golden path, on a running deployment:
//   pnpm test:golden                      against the live service
//   BASE_URL=http://localhost:3000 pnpm test:golden
export default defineConfig({
  testDir: "e2e",
  testIgnore: ["local/**", "measure/**"], // local fakes PayPal (playwright.local.config.ts); measure is run on purpose
  timeout: 8 * 60_000,
  retries: 0,
  workers: 1,
  reporter: [["list"]],
  outputDir: "test-results",
  use: {
    baseURL: process.env.BASE_URL ?? "https://recall-reach-web-e022.onrender.com",
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
  },
});
