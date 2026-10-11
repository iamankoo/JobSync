import { defineConfig } from "vitest/config";
import path from "node:path";

/**
 * LIVE Google Sheets integration tests (real API, DISPOSABLE test spreadsheet only).
 * Run with `npm run test:live`. Deliberately not part of `npm test`.
 * The test spreadsheet ID comes only from GOOGLE_TEST_SPREADSHEET_ID in .env.test.local.
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
    include: ["tests/live/**/*.live.test.ts"],
    testTimeout: 90_000,
    hookTimeout: 120_000,
    fileParallelism: false,
    sequence: { concurrent: false },
  },
});
