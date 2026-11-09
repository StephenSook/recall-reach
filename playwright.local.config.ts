import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { defineConfig } from "@playwright/test";

// Failures PayPal's sandbox cannot be made to produce, in a real browser against a local production build
// with PayPal faked. Run `pnpm build` first, with DATABASE_URL set:  pnpm test:local
const secret = () => randomBytes(32).toString("hex");
export const FAKE_PAYPAL_STATE = process.env.FAKE_PAYPAL_STATE ?? join(tmpdir(), `fake-paypal-${process.pid}.json`);
process.env.FAKE_PAYPAL_STATE = FAKE_PAYPAL_STATE;
export const FAKE_PAYPAL_CONTROL = process.env.FAKE_PAYPAL_CONTROL ?? join(tmpdir(), `fake-paypal-control-${process.pid}.json`);
process.env.FAKE_PAYPAL_CONTROL = FAKE_PAYPAL_CONTROL;

export default defineConfig({
  testDir: "e2e/local",
  // The axe pass has its own config, with WebKit too: playwright.axe.config.ts.
  testIgnore: "axe.spec.ts",
  timeout: 3 * 60_000,
  retries: 0,
  workers: 1,
  reporter: [["list"]],
  outputDir: "test-results",
  use: { baseURL: "http://localhost:3100", screenshot: "only-on-failure", trace: "retain-on-failure" },
  webServer: {
    command: "pnpm exec next start -p 3100",
    url: "http://localhost:3100/api/live",
    reuseExistingServer: false,
    timeout: 120_000,
    env: {
      NODE_OPTIONS: `--import=${pathToFileURL(resolve("e2e/support/fake-paypal.mjs")).href}`,
      FAKE_PAYPAL_STATE,
      FAKE_PAYPAL_CONTROL,
      DATABASE_URL: process.env.DATABASE_URL ?? "",
      PAYPAL_CLIENT_ID: "fake",
      PAYPAL_CLIENT_SECRET: "fake",
      PAYPAL_WEBHOOK_ID: "fake",
      RECORD_HMAC_SECRET: secret(),
      SESSION_SECRET: secret(),
      SHOP_DATA_KEY: secret(),
    },
  },
});
