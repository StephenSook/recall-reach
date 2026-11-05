import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: { "@": fileURLToPath(new URL(".", import.meta.url)) },
  },
  test: {
    environment: "node",
    include: ["**/*.test.ts"],
    // *.live.test.ts files call real external services; they run only through `pnpm test:live`.
    exclude: ["**/node_modules/**", ".next/**", "**/*.live.test.ts"],
    // Each test file that uses the database starts one WebAssembly Postgres (test/pglite.ts). That
    // takes up to 35 s on a loaded 8 GB Mac (measured), so limit how many start at once and give
    // the first test or hook in a file room to wait for it.
    maxWorkers: 4,
    testTimeout: 90_000,
    hookTimeout: 90_000,
  },
});
