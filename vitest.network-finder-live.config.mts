import { defineConfig } from "vitest/config";
import path from "node:path";

/**
 * LIVE Network Finder checks against the REAL Apollo (account 1 only) and NVIDIA Nemotron APIs.
 * Writes go ONLY to an in-memory spreadsheet (never production). Opt-in:
 *   npx vitest run --config vitest.network-finder-live.config.mts
 * Not part of `npm test` or `npm run test:live`. Spends a few Apollo credits (capped in the test).
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
    include: ["tests/live/**/*.nf-live.test.ts"],
    testTimeout: 180_000,
    hookTimeout: 60_000,
    fileParallelism: false,
    sequence: { concurrent: false },
  },
});
