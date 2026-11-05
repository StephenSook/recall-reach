import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// Tests that call real external services (CPSC). Run with `pnpm test:live`; never part of `pnpm test`.
export default defineConfig({
  resolve: {
    alias: { "@": fileURLToPath(new URL(".", import.meta.url)) },
  },
  test: {
    environment: "node",
    include: ["**/*.live.test.ts"],
    exclude: ["**/node_modules/**", ".next/**"],
    testTimeout: 180_000,
    hookTimeout: 90_000, // starting the test database can take up to 35 s (see vitest.config.ts)
  },
});
