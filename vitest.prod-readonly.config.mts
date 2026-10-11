import { defineConfig } from "vitest/config";
import path from "node:path";

/**
 * STRICTLY READ-ONLY checks of the PRODUCTION spreadsheet (`npm run test:prod-readonly`).
 * All writes are blocked by a guard inside the test file. Not part of `npm test`.
 */
export default defineConfig({
  resolve: {
    alias: {
      "@": path.resolve(import.meta.dirname, "src"),
      "server-only": path.resolve(import.meta.dirname, "tests/stubs/server-only.ts"),
    },
  },
  test: {
    environment: "node",
    include: ["tests/live/**/*.prod-readonly.test.ts"],
    testTimeout: 90_000,
    hookTimeout: 120_000,
    fileParallelism: false,
  },
});
