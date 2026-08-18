import { describe, expect, it } from "vitest";
import {
  buildSubmitAcceptanceEvidence,
  classifyAccountEvidence,
  type AccountEvidenceGate,
  type SubmitAcceptanceEvidence,
  type SubmitResponseClass,
} from "../../src/core/account-classification.js";

function event(
  invocationIndex: number,
  responseClass: SubmitResponseClass = "incorrect",
  overrides: Partial<SubmitAcceptanceEvidence> = {},
): SubmitAcceptanceEvidence {
  return buildSubmitAcceptanceEvidence({
    runId: "run-1",
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
    ...overrides,
  });
}

function gate(actionCount: number, overrides: Partial<AccountEvidenceGate> = {}): AccountEvidenceGate {
  return {
    videoPresent: true,
    evidenceComplete: true,
    actionCount,
    dryRun: false,
    ...overrides,
  };
}

describe("buildSubmitAcceptanceEvidence", () => {
  it("does not count a physical invocation without two independent acceptance signals", () => {
    const result = event(1, "incorrect", {
      domMutation: false,
      networkActivity: false,
      formStateChanged: false,
      responseObserved: true,
    });
    expect(result.accepted).toBe(false);
    expect(result.acceptanceSignalCount).toBe(1);
  });

  it("requires the invocation itself even when passive signals exist", () => {
    expect(event(1, "incorrect", { invoked: false }).accepted).toBe(false);
  });

  it("records every independent acceptance signal", () => {
    const result = event(1);
    expect(result.accepted).toBe(true);
    expect(result.acceptanceSignals).toEqual(["dom_mutation", "network_activity", "response_observed"]);
  });
});

describe("classifyAccountEvidence", () => {
  it("classifies TEMP_DISABLED as proof the account exists", () => {
    const evidence = [event(1), event(2, "temp_disabled")];
    const decision = classifyAccountEvidence(evidence, gate(2));
    expect(decision.outcome).toBe("TEMP_DISABLED_ACCOUNT_EXISTS");
    expect(decision.terminalInvocationIndex).toBe(2);
  });

  it("classifies PERM_DISABLED as proof the account exists", () => {
    expect(classifyAccountEvidence([event(1, "perm_disabled")], gate(1)).outcome)
      .toBe("PERM_DISABLED_ACCOUNT_EXISTS");
  });

  it("classifies successful login as the bonus terminal result", () => {
    expect(classifyAccountEvidence([event(1, "success")], gate(1)).outcome)
      .toBe("SUCCESSFUL_LOGIN");
  });

  it("confirms NO_ACCOUNT only after exactly four records and at least three accepted incorrect submits", () => {
    const decision = classifyAccountEvidence([
      event(1),
      event(2),
      event(3),
      event(4, "incorrect", {
        domMutation: false,
        networkActivity: false,
        formStateChanged: false,
        responseObserved: true,
      }),
    ], gate(4));
    expect(decision.outcome).toBe("NO_ACCOUNT_CONFIRMED");
    expect(decision.invocationCount).toBe(4);
    expect(decision.acceptedSubmitCount).toBe(3);
    expect(decision.acceptedIncorrectCount).toBe(3);
  });

  it("does not confirm NO_ACCOUNT after only three invocations", () => {
    expect(classifyAccountEvidence([event(1), event(2), event(3)], gate(3)).outcome)
      .toBe("INCONCLUSIVE");
  });

  it("does not confirm NO_ACCOUNT with fewer than three accepted submits", () => {
    const unaccepted = {
      domMutation: false,
      networkActivity: false,
      formStateChanged: false,
      responseObserved: true,
    } as const;
    const decision = classifyAccountEvidence([
      event(1), event(2), event(3, "incorrect", unaccepted), event(4, "incorrect", unaccepted),
    ], gate(4));
    expect(decision.outcome).toBe("INCONCLUSIVE");
    expect(decision.reason).toBe("insufficient-confirmed-accepted-submits");
  });

  it("fails closed when continuous video is missing", () => {
    const decision = classifyAccountEvidence(
      [event(1), event(2), event(3), event(4)],
      gate(4, { videoPresent: false }),
    );
    expect(decision.outcome).toBe("INCONCLUSIVE");
    expect(decision.reason).toBe("missing-continuous-video");
  });

  it("fails closed when synchronized evidence is incomplete", () => {
    const decision = classifyAccountEvidence(
      [event(1), event(2), event(3), event(4)],
      gate(4, { evidenceComplete: false }),
    );
    expect(decision.outcome).toBe("INCONCLUSIVE");
    expect(decision.reason).toBe("incomplete-synchronized-evidence");
  });

  it("fails closed for a dry run", () => {
    const decision = classifyAccountEvidence(
      [event(1), event(2), event(3), event(4)],
      gate(4, { dryRun: true }),
    );
    expect(decision.outcome).toBe("INCONCLUSIVE");
    expect(decision.reason).toBe("dry-run-disallowed");
  });

  it("fails closed for actionCount=0", () => {
    const decision = classifyAccountEvidence(
      [event(1, "incorrect", { invoked: false })],
      gate(0),
    );
    expect(decision.outcome).toBe("INCONCLUSIVE");
    expect(decision.reason).toBe("zero-or-invalid-action-count");
  });

  it("fails closed when the physical-action count disagrees with evidence", () => {
    const decision = classifyAccountEvidence([event(1), event(2)], gate(1));
    expect(decision.outcome).toBe("INCONCLUSIVE");
    expect(decision.reason).toBe("action-count-evidence-mismatch");
  });

  it("fails closed on invalid invocation indices", () => {
    const decision = classifyAccountEvidence([event(0)], gate(1));
    expect(decision.outcome).toBe("INCONCLUSIVE");
    expect(decision.reason).toBe("invalid-invocation-index");
  });

  it("fails closed on duplicate invocation evidence", () => {
    const decision = classifyAccountEvidence([event(1), event(1), event(2), event(3)], gate(4));
    expect(decision.outcome).toBe("INCONCLUSIVE");
    expect(decision.reason).toBe("duplicate-invocation-evidence");
  });

  it("fails closed on more than four invocation records", () => {
    const decision = classifyAccountEvidence([event(1), event(2), event(3), event(4), event(4)], gate(5));
    expect(decision.outcome).toBe("INCONCLUSIVE");
    expect(decision.reason).toBe("too-many-invocation-records");
  });

  it("fails closed on conflicting account terminal evidence", () => {
    const decision = classifyAccountEvidence([event(1, "temp_disabled"), event(2, "perm_disabled")], gate(2));
    expect(decision.outcome).toBe("INCONCLUSIVE");
    expect(decision.reason).toBe("conflicting-terminal-evidence");
  });

  it("fails closed when an accepted submit occurs after a terminal signal", () => {
    const decision = classifyAccountEvidence([event(1, "temp_disabled"), event(2)], gate(2));
    expect(decision.outcome).toBe("INCONCLUSIVE");
    expect(decision.reason).toBe("accepted-submit-after-terminal-signal");
  });

  it("fails closed on challenge or rate-limit evidence", () => {
    const decision = classifyAccountEvidence([event(1), event(2, "challenge"), event(3), event(4)], gate(4));
    expect(decision.outcome).toBe("INCONCLUSIVE");
    expect(decision.reason).toBe("challenge-or-rate-limit");
  });

  it("fails closed when an accepted response is neither incorrect nor an allowed terminal", () => {
    const decision = classifyAccountEvidence([event(1), event(2), event(3, "unknown"), event(4)], gate(4));
    expect(decision.outcome).toBe("INCONCLUSIVE");
    expect(decision.reason).toBe("accepted-response-not-incorrect");
  });
});
