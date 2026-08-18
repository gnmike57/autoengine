/**
 * shouldRunCashierVerification — exhaustive predicate tests
 *
 * Tests the cashier verification predicate from engine.ts for all
 * outcome × bypass × alreadyVerified combinations.
 */
import { describe, it, expect } from "vitest";
import { shouldRunCashierVerification, type Outcome } from "../../src/core/engine.js";

describe("shouldRunCashierVerification", () => {
  const ALL_OUTCOMES: Outcome[] = [
    "queued", "testing", "success", "success-unconfirmed", "2FA",
    "noaccount", "permdisabled", "tempdisabled", "skipped", "N/A",
    "incorrect", "pin-misdirection", "blocked",
    "soft_success_failed_cashier", "honeypot",
  ];

  it("returns true for success without bypass", () => {
    expect(shouldRunCashierVerification(
      { outcome: "success", bypassCashierVerification: false },
      "joe", null,
    )).toBe(true);
  });

  it("returns true for noaccount without bypass", () => {
    expect(shouldRunCashierVerification(
      { outcome: "noaccount", bypassCashierVerification: false },
      "joe", null,
    )).toBe(true);
  });

  it("returns false when bypass is set", () => {
    expect(shouldRunCashierVerification(
      { outcome: "success", bypassCashierVerification: true },
      "joe", null,
    )).toBe(false);
  });

  it("returns false when site already verified", () => {
    expect(shouldRunCashierVerification(
      { outcome: "success", bypassCashierVerification: false },
      "joe", "joe",
    )).toBe(false);
  });

  it("returns true when a DIFFERENT site was verified", () => {
    expect(shouldRunCashierVerification(
      { outcome: "success", bypassCashierVerification: false },
      "joe", "ignition",
    )).toBe(true);
  });

  describe("returns false for all non-success/noaccount outcomes", () => {
    const excluded = ALL_OUTCOMES.filter(o => o !== "success" && o !== "noaccount");
    for (const outcome of excluded) {
      it(`returns false for outcome="${outcome}"`, () => {
        expect(shouldRunCashierVerification(
          { outcome, bypassCashierVerification: false },
          "joe", null,
        )).toBe(false);
      });
    }
  });
});
