import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "e2e/local",
  testMatch: "webmcp.spec.ts",
  workers: 1,
  timeout: 30_000,
  reporter: "list",
  outputDir: "test-results/webmcp",
  use: { baseURL: "http://localhost:3127", screenshot: "only-on-failure" },
  projects: [{ name: "chromium", use: { browserName: "chromium" } }, { name: "webkit", use: { browserName: "webkit" } }],
  webServer: {
    command: "pnpm exec next start --hostname localhost --port 3127",
    url: "http://localhost:3127/shopper",
    reuseExistingServer: false,
    timeout: 60_000,
    env: { JOBS_ENABLED: "false", RENDER_EXTERNAL_URL: "", WEBMCP_ORIGIN_TRIAL_TOKEN: "test-origin-trial-token" },
  },
});
