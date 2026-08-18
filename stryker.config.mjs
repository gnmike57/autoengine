/**
 * @type {import('@stryker-mutator/api/core').PartialStrykerOptions}
 *
 * Mutation testing configuration for the classification gate.
 * Targets the critical classifyLoginResponse function and its
 * surrounding logic. Run with: npx stryker run
 */
export default {
  mutate: [
    "src/core/engine.ts",
    "src/targets/login-flow.ts",
    "src/profiles/profile-determinism.ts",
  ],
  testRunner: "vitest",
  plugins: ["@stryker-mutator/vitest-runner"],
  reporters: ["html", "clear-text", "progress"],
  thresholds: {
    high: 80,
    low: 60,
    break: 50,
  },
  timeoutMS: 30000,
  concurrency: 4,
  // Focus mutation testing on the most critical classification logic
  mutator: {
    excludedMutations: [
      // Don't mutate string literals (trigger words are already tested exhaustively)
      "StringLiteral",
    ],
  },
};
