import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "e2e/measure",
  timeout: 5 * 60_000,
  retries: 0,
  workers: 1,
  reporter: [["list"]],
  outputDir: "test-results",
  use: { baseURL: process.env.BASE_URL ?? "https://recall-reach-web-e022.onrender.com", trace: "retain-on-failure" },
});
