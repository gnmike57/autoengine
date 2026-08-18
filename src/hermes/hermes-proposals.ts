/**
 * hermes-proposals.ts
 *
 * Defines the proposal format for Hermes timing/flow suggestions.
 * Proposals are written to `data/hermes-proposals.json` after batch analysis
 * and require explicit user approval before being applied.
 */

import fs from "node:fs";
import path from "node:path";
import { createLogger } from "../core/logger.js";

const log = createLogger("HermesProposals");

// ── Types ──────────────────────────────────────────────────────────────────

export type ProposalType = "timing_reduction" | "timing_increase" | "flow_change";
export type ProposalStatus = "pending" | "approved" | "rejected";

export interface ProposalEvidence {
  sampleCount: number;
  p50Ms: number;
  p95Ms: number;
  maxMs: number;
  minMs: number;
  meanMs: number;
  successRate: number;
}

export interface HermesProposal {
  id: string;
  type: ProposalType;
  constant: string;      // e.g., "POST_CLICK_RACE_DELAY"
  file: string;           // Source file where the constant is defined
  currentValue: number;
  proposedValue: number;
  confidence: number;     // 0-1 based on sample count and variance
  reasoning: string;      // Human-readable justification
  evidence: ProposalEvidence;
  status: ProposalStatus;
  createdAt: string;
  reviewedAt?: string;
}

export interface ProposalsFile {
  version: number;
  lastUpdated: string;
  batchId?: string;
  proposals: HermesProposal[];
}

// ── Constants ──────────────────────────────────────────────────────────────

const PROPOSALS_PATH = path.join(process.cwd(), "data", "hermes-proposals.json");

// ── Proposal Management ────────────────────────────────────────────────────

/**
 * Read the current proposals file.
 */
export function readProposals(): ProposalsFile {
  try {
    if (fs.existsSync(PROPOSALS_PATH)) {
      return JSON.parse(fs.readFileSync(PROPOSALS_PATH, "utf-8")) as ProposalsFile;
    }
  } catch (err) {
    log.warn(`[HermesProposals] Failed to read proposals: ${err instanceof Error ? err.message : String(err)}`);
  }
  return { version: 1, lastUpdated: new Date().toISOString(), proposals: [] };
}

/**
 * Write proposals to disk.
 */
export function writeProposals(proposals: ProposalsFile): void {
  try {
    const dir = path.dirname(PROPOSALS_PATH);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    proposals.lastUpdated = new Date().toISOString();
    fs.writeFileSync(PROPOSALS_PATH, JSON.stringify(proposals, null, 2), "utf-8");
    log.info(`[HermesProposals] Wrote ${proposals.proposals.length} proposals to ${PROPOSALS_PATH}`);
  } catch (err) {
    log.warn(`[HermesProposals] Failed to write proposals: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/**
 * Add a new proposal (or update if one with the same constant already exists as pending).
 */
export function addProposal(proposal: Omit<HermesProposal, "id" | "createdAt" | "status">): HermesProposal {
  const file = readProposals();

  // Check for existing pending proposal for the same constant
  const existing = file.proposals.find(
    (p) => p.constant === proposal.constant && p.status === "pending"
  );

  if (existing) {
    // Update existing proposal with new evidence
    Object.assign(existing, proposal);
    existing.createdAt = new Date().toISOString();
    writeProposals(file);
    return existing;
  }

  // Create new proposal
  const newProposal: HermesProposal = {
    ...proposal,
    id: `hp-${Date.now()}-${Math.random().toString(36).substring(2, 8)}`,
    status: "pending",
    createdAt: new Date().toISOString(),
  };

  file.proposals.push(newProposal);
  writeProposals(file);
  return newProposal;
}

/**
 * Get all pending proposals.
 */
export function getPendingProposals(): HermesProposal[] {
  return readProposals().proposals.filter((p) => p.status === "pending");
}

/**
 * Mark a proposal as approved or rejected.
 */
export function reviewProposal(proposalId: string, status: "approved" | "rejected"): boolean {
  const file = readProposals();
  const proposal = file.proposals.find((p) => p.id === proposalId);
  if (!proposal) return false;

  proposal.status = status;
  proposal.reviewedAt = new Date().toISOString();
  writeProposals(file);
  return true;
}

/**
 * Calculate confidence score based on sample count and variance.
 * Higher sample count and lower variance = higher confidence.
 */
export function calculateConfidence(evidence: ProposalEvidence): number {
  const sampleFactor = Math.min(evidence.sampleCount / 50, 1.0); // Full confidence at 50+ samples
  const varianceFactor = evidence.p95Ms > 0
    ? 1 - Math.min((evidence.p95Ms - evidence.p50Ms) / evidence.p95Ms, 0.8)
    : 0.5;
  const successFactor = evidence.successRate;

  return Math.round(sampleFactor * varianceFactor * successFactor * 100) / 100;
}
