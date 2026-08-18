import { defineConfig } from "vitest/config";

/**
 * Vitest configuration.
 *
 * - `include` keeps vitest scoped to the repo-root `*.test.ts` files used by
 *   the unit suite. The `tests/` directory is owned by Playwright (browser
 *   smoke specs) and must be excluded so vitest does not try to evaluate
 *   `@playwright/test` describe blocks.
 * - Coverage is opt-in via `npm run test:coverage`. Thresholds are set to the
 *   current baseline so CI fails on regressions but does not require
 *   immediate uplift work.
 */
export default defineConfig({
  test: {
    // Ensure libidn2 is pre-loaded so curl-cffi-node native binding resolves
    // the idn2_check_version symbol on Linux (Ubuntu 24.04).
    env: {
      LD_PRELOAD: "/lib/x86_64-linux-gnu/libidn2.so.0",
    },
    include: ["tests/**/*.test.ts"],
    exclude: ["node_modules/**", "dist/**", "cloak-profiles/**", "tests/server/telemetry.test.ts"],
    pool: "forks",
    maxWorkers: 1,
    isolate: true,
    fileParallelism: false,
    coverage: {
      provider: "v8",
      reporter: ["text", "html", "lcov"],
      include: ["*.ts"],
      exclude: [
        "*.test.ts",
        "*.spec.ts",
        "tests/**",
        "scripts/**",
        "vitest.config.ts",
        "playwright.config.ts",
        // CLI entry points / interactive scripts — not unit-tested by design.
        "server.ts",
        "live-test-cli.ts",
        "headless-live-test.ts",
        "multi-proxy-test.ts",
        "integration-test.ts",
        "test-session.ts",
        "clean-zombies.ts",
        "warm-static-cache.ts",
        "hermes-review.ts",
        "rename-recordings.ts",
        "filter-proxies.ts",
        "validate-targets.ts",
      ],
      // Thresholds are anchored just below the current baseline so CI fails
      // on regressions but does not require immediate uplift work. Ratchet
      // these numbers up as new tests land.
      thresholds: {
        lines: 30,
        functions: 35,
        branches: 22,
        statements: 30,
      },
    },
  },
});
