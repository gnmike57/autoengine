/**
 * Project Rule 1 — Governing Invariant
 *
 * TEMP_DISABLED proves that a non-permanently-disabled account exists.
 * Four submit invocations with at least three confirmed accepted INCORRECT
 * responses, and no account-exists or success terminal signal, prove NO_ACCOUNT.
 * Anything with incomplete, missing, or conflicting evidence is INCONCLUSIVE.
 */

export const MAX_SUBMIT_INVOCATIONS = 4 as const;
export const MIN_ACCEPTED_INCORRECT_SUBMITS = 3 as const;

export type CanonicalAccountOutcome =
  | "TEMP_DISABLED_ACCOUNT_EXISTS"
  | "PERM_DISABLED_ACCOUNT_EXISTS"
  | "NO_ACCOUNT_CONFIRMED"
  | "SUCCESSFUL_LOGIN"
  | "INCONCLUSIVE";

export type SubmitResponseClass =
  | "incorrect"
  | "temp_disabled"
  | "perm_disabled"
  | "success"
  | "challenge"
  | "rate_limited"
  | "unknown";

export interface SubmitAcceptanceInput {
  runId: string;
  attemptId: string;
  invocationIndex: number;
  variation: string;
  invoked: boolean;
  actionCount?: 1;
  actionKind?: "keyboard" | "mouse" | "locator" | "javascript" | "synthetic" | "cdp";
  actionCoordinates?: { x: number; y: number };
  protocolEventCount?: number;
  observerVariant?: "current_tracker" | "request_response_dom_acceptance";
  domMutation: boolean;
  networkActivity: boolean;
  formStateChanged: boolean;
  responseObserved: boolean;
  responseClass: SubmitResponseClass;
  responseLatencyMs?: number;
  verificationMethod?: string;
  evidence?: string;
}

export interface SubmitAcceptanceEvidence extends SubmitAcceptanceInput {
  accepted: boolean;
  acceptanceSignalCount: number;
  acceptanceSignals: Array<"dom_mutation" | "network_activity" | "form_state_changed" | "response_observed">;
}

export interface AccountEvidenceGate {
  videoPresent: boolean;
  evidenceComplete: boolean;
  actionCount: number;
  dryRun: boolean;
}

export interface AccountClassificationDecision {
  outcome: CanonicalAccountOutcome;
  invocationCount: number;
  acceptedSubmitCount: number;
  acceptedIncorrectCount: number;
  terminalInvocationIndex?: number;
  reason: string;
}

/**
 * A physical action never proves acceptance by itself. Acceptance requires at
 * least two independent post-invocation signals from DOM mutation, network
 * activity, form-state change, and observed response timing/content.
 */
export function buildSubmitAcceptanceEvidence(input: SubmitAcceptanceInput): SubmitAcceptanceEvidence {
  const acceptanceSignals: SubmitAcceptanceEvidence["acceptanceSignals"] = [];
  if (input.domMutation) acceptanceSignals.push("dom_mutation");
  if (input.networkActivity) acceptanceSignals.push("network_activity");
  if (input.formStateChanged) acceptanceSignals.push("form_state_changed");
  if (input.responseObserved) acceptanceSignals.push("response_observed");

  const acceptanceSignalCount = acceptanceSignals.length;
  return {
    ...input,
    accepted: input.invoked && acceptanceSignalCount >= 2,
    acceptanceSignalCount,
    acceptanceSignals,
  };
}

function terminalOutcome(responseClass: SubmitResponseClass): CanonicalAccountOutcome | null {
  switch (responseClass) {
    case "temp_disabled":
      return "TEMP_DISABLED_ACCOUNT_EXISTS";
    case "perm_disabled":
      return "PERM_DISABLED_ACCOUNT_EXISTS";
    case "success":
      return "SUCCESSFUL_LOGIN";
    default:
      return null;
  }
}

export function classifyAccountEvidence(
  evidence: readonly SubmitAcceptanceEvidence[],
  gate: AccountEvidenceGate,
): AccountClassificationDecision {
  const invocationIndices = new Set(evidence.map((item) => item.invocationIndex));
  const accepted = evidence.filter((item) => item.accepted);
  const acceptedIncorrect = accepted.filter((item) => item.responseClass === "incorrect");

  const base = {
    invocationCount: invocationIndices.size,
    acceptedSubmitCount: accepted.length,
    acceptedIncorrectCount: acceptedIncorrect.length,
  };

  if (!gate.videoPresent || !gate.evidenceComplete) {
    return {
      outcome: "INCONCLUSIVE",
      ...base,
      reason: !gate.videoPresent ? "missing-continuous-video" : "incomplete-synchronized-evidence",
    };
  }

  if (gate.dryRun) {
    return { outcome: "INCONCLUSIVE", ...base, reason: "dry-run-disallowed" };
  }

  if (!Number.isInteger(gate.actionCount) || gate.actionCount <= 0) {
    return { outcome: "INCONCLUSIVE", ...base, reason: "zero-or-invalid-action-count" };
  }

  if (gate.actionCount !== evidence.filter((item) => item.invoked).length) {
    return { outcome: "INCONCLUSIVE", ...base, reason: "action-count-evidence-mismatch" };
  }

  if (
    evidence.some((item) =>
      !Number.isInteger(item.invocationIndex) ||
      item.invocationIndex < 1 ||
      item.invocationIndex > MAX_SUBMIT_INVOCATIONS,
    )
  ) {
    return { outcome: "INCONCLUSIVE", ...base, reason: "invalid-invocation-index" };
  }

  if (evidence.length > MAX_SUBMIT_INVOCATIONS) {
    return { outcome: "INCONCLUSIVE", ...base, reason: "too-many-invocation-records" };
  }

  if (invocationIndices.size !== evidence.length) {
    return { outcome: "INCONCLUSIVE", ...base, reason: "duplicate-invocation-evidence" };
  }

  const terminals = accepted
    .map((item) => ({ item, outcome: terminalOutcome(item.responseClass) }))
    .filter((entry): entry is { item: SubmitAcceptanceEvidence; outcome: CanonicalAccountOutcome } => Boolean(entry.outcome));
  const distinctTerminals = new Set(terminals.map((entry) => entry.outcome));

  if (distinctTerminals.size > 1) {
    return { outcome: "INCONCLUSIVE", ...base, reason: "conflicting-terminal-evidence" };
  }

  if (terminals.length > 0) {
    const first = [...terminals].sort((a, b) => a.item.invocationIndex - b.item.invocationIndex)[0]!;
    const laterAccepted = accepted.some((item) => item.invocationIndex > first.item.invocationIndex);
    if (laterAccepted) {
      return { outcome: "INCONCLUSIVE", ...base, reason: "accepted-submit-after-terminal-signal" };
    }
    return {
      outcome: first.outcome,
      ...base,
      terminalInvocationIndex: first.item.invocationIndex,
      reason: `terminal-${first.item.responseClass}`,
    };
  }

  if (accepted.some((item) => item.responseClass === "challenge" || item.responseClass === "rate_limited")) {
    return { outcome: "INCONCLUSIVE", ...base, reason: "challenge-or-rate-limit" };
  }

  if (accepted.some((item) => item.responseClass !== "incorrect")) {
    return { outcome: "INCONCLUSIVE", ...base, reason: "accepted-response-not-incorrect" };
  }

  if (
    evidence.length === MAX_SUBMIT_INVOCATIONS &&
    invocationIndices.size === MAX_SUBMIT_INVOCATIONS &&
    acceptedIncorrect.length >= MIN_ACCEPTED_INCORRECT_SUBMITS
  ) {
    return {
      outcome: "NO_ACCOUNT_CONFIRMED",
      ...base,
      reason: "four-invocation-envelope-with-three-accepted-incorrect-responses",
    };
  }

  return {
    outcome: "INCONCLUSIVE",
    ...base,
    reason: "insufficient-confirmed-accepted-submits",
  };
}
