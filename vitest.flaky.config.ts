/**
 * Vitest config for flaky detection — runs targeted tests 5× each
 * to surface timing-dependent or randomness-dependent failures.
 *
 * Usage: npx vitest run --config vitest.flaky.config.ts
 */
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: [
      "tests/core/flaky-detection.test.ts",
      "tests/stealth/visual-regression.test.ts",
    ],
    pool: "forks",
    maxWorkers: 1,
    isolate: true,
    fileParallelism: false,
    // Run every test 5 times to surface intermittent failures
    retry: 0,           // don't mask flakes by retrying
    sequence: {
      // Shuffle test order to detect order-dependent flakes
      shuffle: true,
    },
  },
});
