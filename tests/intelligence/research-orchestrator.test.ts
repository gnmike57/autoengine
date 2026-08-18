import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import {
  ResearchOrchestrator,
  _resetOrchestrator,
  getOrchestrator,
} from "../../src/intelligence/research-orchestrator.js";
import { DetectionFeedbackLoop, _resetFeedbackLoop } from "../../src/stealth/detection-feedback.js";

const TEST_STATE = path.join(import.meta.dirname ?? ".", "__test_research_state.json");
const TEST_SKILLS = path.join(import.meta.dirname ?? ".", "__test_research_skills.json");
const TEST_FEEDBACK_DB = path.join(import.meta.dirname ?? ".", "__test_research_feedback.json");

function cleanup() {
  for (const f of [TEST_STATE, TEST_SKILLS, TEST_FEEDBACK_DB]) {
    try { fs.unlinkSync(f); } catch { /* ignore */ }
  }
  _resetOrchestrator();
  _resetFeedbackLoop();
}

function makeOrchestrator(hermesThreshold = 3) {
  const feedback = new DetectionFeedbackLoop({ dbPath: TEST_FEEDBACK_DB });
  return new ResearchOrchestrator({
    statePath: TEST_STATE,
    skillsPath: TEST_SKILLS,
    hermesThreshold,
    feedbackLoop: feedback,
  });
}

describe("ResearchOrchestrator", () => {
  beforeEach(cleanup);
  afterEach(cleanup);

  it("starts with no targets", () => {
    const orch = makeOrchestrator();
    expect(orch.getTargets()).toHaveLength(0);
  });

  it("registers a target and deduplicates", () => {
    const orch = makeOrchestrator();
    orch.registerTarget("https://example.com/login", ["webdriver_detected"]);
    orch.registerTarget("https://example.com/other", ["canvas_noise"]);
    const targets = orch.getTargets();
    expect(targets).toHaveLength(1);
    expect(targets[0]!.domain).toBe("example.com");
    expect(targets[0]!.knownVectors).toContain("webdriver_detected");
    expect(targets[0]!.knownVectors).toContain("canvas_noise");
  });

  it("ARC succeeds on first try with known vectors", async () => {
    const orch = makeOrchestrator();
    orch.registerTarget("https://test.com", ["vec_a", "vec_b"]);
    const result = await orch.research("test.com");

    expect(result.phase).toBe("deploying");
    expect(result.skills.length).toBe(2);
    expect(result.skills[0]!.validated).toBe(true);
    expect(result.skills[0]!.generatedBy).toBe("autoresearchclaw");
  });

  it("returns idle for unregistered domain", async () => {
    const orch = makeOrchestrator();
    const result = await orch.research("unknown.com");
    expect(result.phase).toBe("idle");
    expect(result.skills).toHaveLength(0);
  });

  it("skills are retrievable after deployment", async () => {
    const orch = makeOrchestrator();
    orch.registerTarget("https://target.com", ["vec_x"]);
    await orch.research("target.com");

    const skills = orch.getSkillsForDomain("target.com");
    expect(skills.length).toBe(1);
    expect(skills[0]!.vector).toBe("vec_x");
  });

  it("getAllSkills returns all deployed skills", async () => {
    const orch = makeOrchestrator();
    orch.registerTarget("https://a.com", ["v1"]);
    orch.registerTarget("https://b.com", ["v2"]);
    await orch.research("a.com");
    await orch.research("b.com");

    const all = orch.getAllSkills();
    expect(all.length).toBe(2);
  });

  it("target with no vectors triggers ARC failure (no skills generated)", async () => {
    const orch = makeOrchestrator(2);
    orch.registerTarget("https://empty.com", []);
    const r1 = await orch.research("empty.com");
    // ARC with 0 vectors → no skills → fail
    expect(r1.phase).toBe("idle");

    const r2 = await orch.research("empty.com");
    // 2nd failure → triggers Hermes, which also produces 0 skills → blacklist
    expect(r2.phase).toBe("blacklisted");
  });

  it("blacklisted domain is skipped", async () => {
    const orch = makeOrchestrator(1);
    orch.registerTarget("https://blocked.com", []);
    // First failure triggers Hermes (threshold=1), both fail → blacklist
    await orch.research("blocked.com");

    const result = await orch.research("blocked.com");
    expect(result.phase).toBe("blacklisted");
    expect(orch.isDomainBlacklisted("blocked.com")).toBe(true);
  });

  it("persists state and skills to disk", async () => {
    const orch1 = makeOrchestrator();
    orch1.registerTarget("https://persist.com", ["v1"]);
    await orch1.research("persist.com");

    const orch2 = makeOrchestrator();
    expect(orch2.getTargets()).toHaveLength(1);
    expect(orch2.getAllSkills()).toHaveLength(1);
  });

  it("singleton factory works", () => {
    _resetOrchestrator();
    const a = getOrchestrator({ statePath: TEST_STATE, skillsPath: TEST_SKILLS });
    const b = getOrchestrator();
    expect(a).toBe(b);
  });
});
