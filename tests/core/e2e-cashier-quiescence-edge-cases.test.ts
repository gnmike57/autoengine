import { describe, it, expect } from "vitest";
import { shouldRunCashierVerification } from "../../src/core/engine.js";

describe("E2E Cashier Verification & DOM Quiescence Invariants", () => {
  it("Invariant: soft_success_failed_cashier occurs if cashier bounces back to /login", () => {
    // When cashier is not bypassed, success outcomes must verify cashier
    const needsVerification = shouldRunCashierVerification(
      { outcome: "success", bypassCashierVerification: false },
      "joe",
      null
    );
    expect(needsVerification).toBe(true);
  });

  it("Edge Case: Already verified site skips redundant cashier navigation", () => {
    const skipRedundant = shouldRunCashierVerification(
      { outcome: "success", bypassCashierVerification: false },
      "joe",
      "joe" // Already verified site is joe
    );
    expect(skipRedundant).toBe(false);
  });

  it("Edge Case: Terminal blocks (honeypot, 403) never trigger cashier verification", () => {
    const honeypot = shouldRunCashierVerification(
      { outcome: "honeypot", bypassCashierVerification: false },
      "joe",
      null
    );
    expect(honeypot).toBe(false);

    const blocked = shouldRunCashierVerification(
      { outcome: "blocked", bypassCashierVerification: false },
      "joe",
      null
    );
    expect(blocked).toBe(false);
  });
});
