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
  },
});
