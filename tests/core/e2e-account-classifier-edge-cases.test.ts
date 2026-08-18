import { describe, it, expect } from "vitest";
import {
  buildSubmitAcceptanceEvidence,
  classifyAccountEvidence,
  type AccountEvidenceGate,
  type SubmitAcceptanceEvidence,
  type SubmitResponseClass
} from "../../src/core/account-classification.js";

function makeEvidence(
  invocationIndex: number,
  responseClass: SubmitResponseClass = "incorrect",
  overrides: Partial<SubmitAcceptanceEvidence> = {}
): SubmitAcceptanceEvidence {
  return buildSubmitAcceptanceEvidence({
    runId: "run-e2e-1",
    attemptId: `attempt-${invocationIndex}`,
    invocationIndex,
    variation: "enter_in_password",
    invoked: true,
    domMutation: true,
    networkActivity: true,
    formStateChanged: false,
    responseObserved: true,
    responseClass,
    responseLatencyMs: 250,
    verificationMethod: "network+dom",
    evidence: "fixture",
    ...overrides
  });
}

function makeGate(actionCount: number, overrides: Partial<AccountEvidenceGate> = {}): AccountEvidenceGate {
  return {
    videoPresent: true,
    evidenceComplete: true,
    actionCount,
    dryRun: false,
    ...overrides
  };
}

describe("E2E Account Classifier Invariants & Edge Cases", () => {
  it("TEMP_DISABLED signal immediately terminal with TEMP_DISABLED_ACCOUNT_EXISTS", () => {
    const evidence = [
      makeEvidence(1, "incorrect"),
      makeEvidence(2, "temp_disabled")
    ];

    const decision = classifyAccountEvidence(evidence, makeGate(2));
    expect(decision.outcome).toBe("TEMP_DISABLED_ACCOUNT_EXISTS");
    expect(decision.terminalInvocationIndex).toBe(2);
  });

  it("PERM_DISABLED signal immediately terminal with PERM_DISABLED_ACCOUNT_EXISTS", () => {
    const evidence = [makeEvidence(1, "perm_disabled")];

    const decision = classifyAccountEvidence(evidence, makeGate(1));
    expect(decision.outcome).toBe("PERM_DISABLED_ACCOUNT_EXISTS");
  });

  it("NO_ACCOUNT_CONFIRMED requires exactly 4 invocations and at least 3 confirmed accepted incorrect submits", () => {
    const evidence = [
      makeEvidence(1, "incorrect"),
      makeEvidence(2, "incorrect"),
      makeEvidence(3, "incorrect"),
      makeEvidence(4, "incorrect", {
        domMutation: false,
        networkActivity: false,
        formStateChanged: false,
        responseObserved: true
      })
    ];

    const decision = classifyAccountEvidence(evidence, makeGate(4));
    expect(decision.outcome).toBe("NO_ACCOUNT_CONFIRMED");
    expect(decision.invocationCount).toBe(4);
    expect(decision.acceptedSubmitCount).toBe(3);
    expect(decision.acceptedIncorrectCount).toBe(3);
  });

  it("Edge Case: Fewer than 3 confirmed accepted submits yields INCONCLUSIVE", () => {
    const weakEvidence = [
      makeEvidence(1, "incorrect"),
      makeEvidence(2, "incorrect", { domMutation: false, networkActivity: false, responseObserved: false }),
      makeEvidence(3, "incorrect", { domMutation: false, networkActivity: false, responseObserved: false }),
      makeEvidence(4, "incorrect", { domMutation: false, networkActivity: false, responseObserved: false })
    ];

    const decision = classifyAccountEvidence(weakEvidence, makeGate(4));
    expect(decision.outcome).toBe("INCONCLUSIVE");
    expect(decision.acceptedSubmitCount).toBe(1);
  });

  it("Edge Case: Missing synchronized video or evidence forces INCONCLUSIVE", () => {
    const fourEvidence = [
      makeEvidence(1),
      makeEvidence(2),
      makeEvidence(3),
      makeEvidence(4)
    ];

    const missingVideoDecision = classifyAccountEvidence(
      fourEvidence,
      makeGate(4, { videoPresent: false })
    );
    expect(missingVideoDecision.outcome).toBe("INCONCLUSIVE");

    const incompleteEvidenceDecision = classifyAccountEvidence(
      fourEvidence,
      makeGate(4, { evidenceComplete: false })
    );
    expect(incompleteEvidenceDecision.outcome).toBe("INCONCLUSIVE");
  });

  it("Edge Case: Challenge or Rate Limit stops as INCONCLUSIVE", () => {
    const rateLimitedEvidence = [makeEvidence(1, "rate_limited")];
    const decision = classifyAccountEvidence(rateLimitedEvidence, makeGate(1));
    expect(decision.outcome).toBe("INCONCLUSIVE");
  });

  it("Edge Case: Verified Cashier Success produces SUCCESSFUL_LOGIN", () => {
    const successEvidence = [makeEvidence(1, "success")];
    const decision = classifyAccountEvidence(successEvidence, makeGate(1));
    expect(decision.outcome).toBe("SUCCESSFUL_LOGIN");
  });
});
