import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import {
  readProposals,
  writeProposals,
  addProposal,
  getPendingProposals,
  reviewProposal,
  calculateConfidence,
  type HermesProposal,
  type ProposalEvidence
} from "../../src/hermes/hermes-proposals.js";

describe("Hermes Proposals Engine", () => {
  const proposalsPath = path.join(process.cwd(), "data", "hermes-proposals.json");
  let originalContent: string | null = null;

  beforeEach(() => {
    if (fs.existsSync(proposalsPath)) {
      originalContent = fs.readFileSync(proposalsPath, "utf-8");
      fs.unlinkSync(proposalsPath);
    }
  });

  afterEach(() => {
    if (originalContent !== null) {
      fs.writeFileSync(proposalsPath, originalContent, "utf-8");
    } else if (fs.existsSync(proposalsPath)) {
      fs.unlinkSync(proposalsPath);
    }
  });

  it("should read and write empty proposals file gracefully", () => {
    const file = readProposals();
    expect(file.version).toBe(1);
    expect(file.proposals).toEqual([]);

    writeProposals(file);
    expect(fs.existsSync(proposalsPath)).toBe(true);
  });

  it("should add and update proposals", () => {
    const evidence: ProposalEvidence = {
      sampleCount: 60,
      p50Ms: 120,
      p95Ms: 180,
      maxMs: 250,
      minMs: 80,
      meanMs: 130,
      successRate: 0.98
    };

    const prop = addProposal({
      type: "timing_reduction",
      constant: "POST_SUBMIT_RACE_DELAY",
      file: "src/core/timings.ts",
      currentValue: 500,
      proposedValue: 250,
      confidence: 0.95,
      reasoning: "Consistently completes within 180ms",
      evidence
    });

    expect(prop.id).toBeDefined();
    expect(prop.status).toBe("pending");

    const pending = getPendingProposals();
    expect(pending.length).toBe(1);
    expect(pending[0]?.constant).toBe("POST_SUBMIT_RACE_DELAY");

    // Updating existing pending proposal with new proposed value
    const updated = addProposal({
      type: "timing_reduction",
      constant: "POST_SUBMIT_RACE_DELAY",
      file: "src/core/timings.ts",
      currentValue: 500,
      proposedValue: 200,
      confidence: 0.98,
      reasoning: "Updated with more evidence",
      evidence
    });

    expect(updated.proposedValue).toBe(200);
    expect(getPendingProposals().length).toBe(1);
  });

  it("should review proposals (approve/reject)", () => {
    const prop = addProposal({
      type: "flow_change",
      constant: "ENABLE_EARLY_INTERACTION",
      file: "src/targets/login-flow.ts",
      currentValue: 0,
      proposedValue: 1,
      confidence: 0.85,
      reasoning: "Simulate human focus",
      evidence: {
        sampleCount: 20,
        p50Ms: 50,
        p95Ms: 100,
        maxMs: 150,
        minMs: 20,
        meanMs: 60,
        successRate: 1.0
      }
    });

    const reviewed = reviewProposal(prop.id, "approved");
    expect(reviewed).toBe(true);
    expect(getPendingProposals().length).toBe(0);

    const nonExistent = reviewProposal("fake-id", "rejected");
    expect(nonExistent).toBe(false);
  });

  it("should calculate confidence scores based on sample size, variance, and success rate", () => {
    const highConfidenceEvidence: ProposalEvidence = {
      sampleCount: 100,
      p50Ms: 200,
      p95Ms: 220,
      maxMs: 250,
      minMs: 190,
      meanMs: 205,
      successRate: 0.99
    };

    const scoreHigh = calculateConfidence(highConfidenceEvidence);
    expect(scoreHigh).toBeGreaterThan(0.8);

    const lowConfidenceEvidence: ProposalEvidence = {
      sampleCount: 5,
      p50Ms: 50,
      p95Ms: 500,
      maxMs: 1000,
      minMs: 10,
      meanMs: 200,
      successRate: 0.5
    };

    const scoreLow = calculateConfidence(lowConfidenceEvidence);
    expect(scoreLow).toBeLessThan(0.2);
  });
});
