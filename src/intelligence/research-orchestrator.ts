/* eslint-disable @typescript-eslint/require-await*/
/**
 * Research Orchestrator
 *
 * Implements the AutoResearchClaw-primary / Hermes-failover architecture
 * for automated anti-detection research.
 *
 * Flow:
 *   1. AutoResearchClaw (primary) — reverse-engineers detection scripts
 *      from target sites and generates evasion skills.
 *   2. If AutoResearchClaw fails 3+ consecutive times, Hermes is triggered
 *      as a deep-scan fallback for zero-day detection analysis.
 *   3. Generated skills are validated and deployed to framework configs.
 *   4. Targets that resist both engines are blacklisted for 24 hours.
 *
 * This module is orchestration-only — it dispatches to external research
 * tools and manages the lifecycle. Actual research execution happens in
 * the respective tool containers/processes.
 */

import fs from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { DetectionFeedbackLoop, getFeedbackLoop } from "../stealth/detection-feedback.js";
import { runAutoResearchClaw } from "./arc-runner.js";
import { runHermes } from "./hermes-runner.js";

const execFileAsync = promisify(execFile);

// ── Types ────────────────────────────────────────────────────────────────────

export interface ResearchTarget {
  url: string;
  domain: string;
  /** Detection vectors discovered on this target. */
  knownVectors: string[];
  /** Number of consecutive AutoResearchClaw failures. */
  arcFailCount: number;
  lastResearchAt?: string; // ISO-8601
}

export interface ResearchSkill {
  id: string;
  vector: string;         // detection vector this skill addresses
  target: string;         // domain
  /** JavaScript override snippet to inject. */
  script: string;
  /** Framework compatibility. */
  frameworks: string[];
  generatedBy: "autoresearchclaw" | "hermes";
  generatedAt: string;    // ISO-8601
  validated: boolean;
}

export interface OrchestratorOptions {
  /** Path to persist research state. */
  statePath?: string;
  /** Path to persist discovered skills. */
  skillsPath?: string;
  /** Max consecutive ARC failures before triggering Hermes (default 3). */
  hermesThreshold?: number;
  /** Hours to blacklist a target after both engines fail (default 24). */
  blacklistHours?: number;
  /** Optional logger. */
  log?: (msg: string) => void;
  /** Reference to the detection feedback loop. */
  feedbackLoop?: DetectionFeedbackLoop;
}

export type ResearchPhase = "idle" | "arc_scanning" | "hermes_scanning" | "validating" | "deploying" | "blacklisted";

// ── Defaults ─────────────────────────────────────────────────────────────────

const DEFAULT_STATE_PATH = "research-state.json";
const DEFAULT_SKILLS_PATH = "research-skills.json";
const DEFAULT_HERMES_THRESHOLD = 3;
const DEFAULT_BLACKLIST_HOURS = 24;

// ── Persistence ──────────────────────────────────────────────────────────────

interface OrchestratorState {
  targets: ResearchTarget[];
  blacklistedDomains: Array<{ domain: string; expiresAt: number }>;
}

function loadState(filePath: string): OrchestratorState {
  try {
    if (fs.existsSync(filePath)) {
      return JSON.parse(fs.readFileSync(filePath, "utf-8")) as OrchestratorState;
    }
  } catch { /* start fresh */ }
  return { targets: [], blacklistedDomains: [] };
}

function saveState(state: OrchestratorState, filePath: string): void {
  try {
    fs.writeFileSync(filePath, JSON.stringify(state, null, 2), "utf-8");
  } catch { /* non-critical */ }
}

function loadSkills(filePath: string): ResearchSkill[] {
  try {
    if (fs.existsSync(filePath)) {
      return JSON.parse(fs.readFileSync(filePath, "utf-8")) as ResearchSkill[];
    }
  } catch { /* start fresh */ }
  return [];
}

function saveSkills(skills: ResearchSkill[], filePath: string): void {
  try {
    fs.writeFileSync(filePath, JSON.stringify(skills, null, 2), "utf-8");
  } catch { /* non-critical */ }
}

// ── Orchestrator ─────────────────────────────────────────────────────────────

export class ResearchOrchestrator {
  private readonly statePath: string;
  private readonly skillsPath: string;
  private readonly hermesThreshold: number;
  private readonly blacklistMs: number;
  private readonly log: (msg: string) => void;
  private readonly feedback: DetectionFeedbackLoop;
  private state: OrchestratorState;
  private skills: ResearchSkill[];
  private phase: ResearchPhase = "idle";

  constructor(opts: OrchestratorOptions = {}) {
    this.statePath = opts.statePath ?? DEFAULT_STATE_PATH;
    this.skillsPath = opts.skillsPath ?? DEFAULT_SKILLS_PATH;
    this.hermesThreshold = opts.hermesThreshold ?? DEFAULT_HERMES_THRESHOLD;
    this.blacklistMs = (opts.blacklistHours ?? DEFAULT_BLACKLIST_HOURS) * 60 * 60 * 1000;
    this.log = opts.log ?? (() => {});
    this.feedback = opts.feedbackLoop ?? getFeedbackLoop();
    this.state = loadState(this.statePath);
    this.skills = loadSkills(this.skillsPath);
    this.evictExpiredBlacklist();
  }

  // ── Public API ─────────────────────────────────────────────────────────

  /**
   * Register a target domain for research.
   */
  registerTarget(url: string, knownVectors: string[] = []): ResearchTarget {
    const domain = this.extractDomain(url);
    let target = this.state.targets.find(t => t.domain === domain);
    if (!target) {
      target = { url, domain, knownVectors, arcFailCount: 0 };
      this.state.targets.push(target);
      this.persist();
      this.log(`[research] Registered target: ${domain}`);
    } else {
      // Merge new vectors
      for (const v of knownVectors) {
        if (!target.knownVectors.includes(v)) {
          target.knownVectors.push(v);
        }
      }
      this.persist();
    }
    return target;
  }

  /**
   * Inject a raw JavaScript patch generated by Hermes AI directly into the orchestrator.
   */
  injectHermesSkill(script: string, domain: string = "global", vector: string = "hermes-ai-patch"): void {
    const skill: ResearchSkill = {
      id: `hermes-${domain}-${vector}-${Date.now()}`,
      vector,
      target: domain,
      script,
      frameworks: ["camoufox", "cloakbrowser", "zendriver", "spider"],
      generatedBy: "hermes",
      generatedAt: new Date().toISOString(),
      validated: true, // Auto-validate AI patches for immediate use if requested
    };
    this.skills.push(skill);
    this.deploySkills([skill]);
    this.persist();
    this.log(`[research] Injected and deployed new Hermes AI skill for ${domain}`);
  }

  /**
   * Initiate research for a target. Returns the phase the orchestrator
   * entered and any skills generated.
   *
   * In a production environment, this would dispatch to actual ARC/Hermes
   * processes. Here we implement the decision logic and skill management.
   */
  async research(domain: string): Promise<{
    phase: ResearchPhase;
    skills: ResearchSkill[];
    message: string;
  }> {
    // Check blacklist
    if (this.isDomainBlacklisted(domain)) {
      return {
        phase: "blacklisted",
        skills: [],
        message: `${domain} is blacklisted — skipping research`,
      };
    }

    const target = this.state.targets.find(t => t.domain === domain);
    if (!target) {
      return {
        phase: "idle",
        skills: [],
        message: `${domain} is not registered as a research target`,
      };
    }

    // Phase 1: Try AutoResearchClaw
    this.phase = "arc_scanning";
    this.log(`[research] Phase 1: AutoResearchClaw scanning ${domain}`);

    const arcResult = await this.runAutoResearchClaw(target);

    if (arcResult.success && arcResult.skills.length > 0) {
      // ARC succeeded — validate and deploy
      target.arcFailCount = 0;
      target.lastResearchAt = new Date().toISOString();
      this.phase = "validating";

      const validated = await this.validateSkills(arcResult.skills);
      if (validated.length > 0) {
        this.phase = "deploying";
        this.deploySkills(validated);
        this.persist();
        return {
          phase: "deploying",
          skills: validated,
          message: `ARC generated ${validated.length} validated skills for ${domain}`,
        };
      }
    }

    // ARC failed
    target.arcFailCount++;
    this.log(`[research] ARC failed for ${domain} (${target.arcFailCount}/${this.hermesThreshold})`);

    // Phase 2: Trigger Hermes if threshold exceeded
    if (target.arcFailCount >= this.hermesThreshold) {
      this.phase = "hermes_scanning";
      this.log(`[research] Phase 2: Hermes deep scan for ${domain}`);

      const hermesResult = await this.runHermes(target);

      if (hermesResult.success && hermesResult.skills.length > 0) {
        target.arcFailCount = 0;
        target.lastResearchAt = new Date().toISOString();

        const validated = await this.validateSkills(hermesResult.skills);
        if (validated.length > 0) {
          this.deploySkills(validated);
          this.persist();
          return {
            phase: "deploying",
            skills: validated,
            message: `Hermes generated ${validated.length} skills for ${domain}`,
          };
        }
      }

      // Both failed — blacklist target
      this.blacklistDomain(domain);
      this.persist();
      return {
        phase: "blacklisted",
        skills: [],
        message: `Both ARC and Hermes failed for ${domain} — blacklisted for ${DEFAULT_BLACKLIST_HOURS}h`,
      };
    }

    this.phase = "idle";
    this.persist();
    return {
      phase: "idle",
      skills: [],
      message: `ARC failed (${target.arcFailCount}/${this.hermesThreshold}), Hermes not yet triggered`,
    };
  }

  /**
   * Get all deployed skills for a specific domain.
   */
  getSkillsForDomain(domain: string): ResearchSkill[] {
    return this.skills.filter(s => s.target === domain && s.validated);
  }

  /**
   * Get all deployed skills.
   */
  getAllSkills(): ResearchSkill[] {
    return [...this.skills];
  }

  /**
   * Check if a domain is blacklisted from research.
   */
  isDomainBlacklisted(domain: string): boolean {
    this.evictExpiredBlacklist();
    const now = Date.now();
    return this.state.blacklistedDomains.some(
      b => b.domain === domain && b.expiresAt > now,
    );
  }

  /** Current orchestrator phase. */
  get currentPhase(): ResearchPhase {
    return this.phase;
  }

  /** Get all registered targets. */
  getTargets(): ResearchTarget[] {
    return [...this.state.targets];
  }

  // ── Research engines ──────────────────────────────────────────────────

  /**
   * Run AutoResearchClaw against a target.
   *
   * Dispatches to the ARC CLI/API:
   *   1. Try local script: `npx tsx scripts/arc-scan.ts --target=<domain>`
   *   2. Try Python: `python deploy_skills.py --target=<domain>`
   *   3. If neither exists, generate skills from known vectors (offline mode)
   *
   * Real repo: https://github.com/aiming-lab/AutoResearchClaw
   */
  protected async runAutoResearchClaw(target: ResearchTarget): Promise<{
    success: boolean;
    skills: ResearchSkill[];
  }> {
      return runAutoResearchClaw(target, { log: this.log.bind(this) });
  }

  /**
   * Run Hermes deep scan against a target.
   *
   * Dispatches to the Hermes review system:
   *   1. Try importing hermes-review.ts and calling its scan function
   *   2. Try CLI: `npx tsx src/hermes/hermes-review.ts --scan <domain>`
   *   3. Fallback to offline zero-day analysis from known vectors
   */
  protected async runHermes(target: ResearchTarget): Promise<{
    success: boolean;
    skills: ResearchSkill[];
  }> {
      return runHermes(target, { log: this.log.bind(this) });
  }

  /**
   * Validate generated skills by checking they are syntactically valid JS
   * and don't contain obviously dangerous patterns.
   *
   * In production with a browser context available, each skill would be
   * executed in a sandboxed page.evaluate() to verify it doesn't break
   * the page and actually addresses the detection vector.
   */
  protected async validateSkills(skills: ResearchSkill[]): Promise<ResearchSkill[]> {
    const validated: ResearchSkill[] = [];

    for (const skill of skills) {
      try {
        // Syntactic validation: check the script is valid JavaScript
        // eslint-disable-next-line @typescript-eslint/no-implied-eval
        new Function(skill.script);

        // Safety check: reject scripts with dangerous patterns
        const dangerous = [
          /eval\s*\(/,         // eval() calls
          /Function\s*\(/,     // Function constructor
          /import\s*\(/,       // dynamic imports
          /require\s*\(/,      // CommonJS requires
          /\bfetch\s*\(/,      // network calls
          /XMLHttpRequest/,    // XHR
          /WebSocket/,         // WebSockets
        ];

        const hasDangerous = dangerous.some(pattern => pattern.test(skill.script));
        if (hasDangerous) {
          this.log(`[research] Skill ${skill.id} rejected: contains dangerous patterns`);
          continue;
        }

        validated.push({ ...skill, validated: true });
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        this.log(`[research] Skill ${skill.id} invalid: ${msg}`);
      }
    }

    this.log(`[research] Validated ${validated.length}/${skills.length} skills`);
    return validated;
  }

  /**
   * Push validated skills to framework repos via Git.
   */
  async autoCommitSkills(skills: ResearchSkill[]): Promise<void> {
    if (skills.length === 0) return;

    const skillsDir = "research-skills";
    try {
      if (!fs.existsSync(skillsDir)) {
        fs.mkdirSync(skillsDir, { recursive: true });
      }

      for (const skill of skills) {
        const filename = `${skillsDir}/${skill.id}.js`;
        const header = [
          `// Skill: ${skill.id}`,
          `// Vector: ${skill.vector}`,
          `// Target: ${skill.target}`,
          `// Generated by: ${skill.generatedBy}`,
          `// Generated at: ${skill.generatedAt}`,
          `// Frameworks: ${skill.frameworks.join(", ")}`,
          "",
        ].join("\n");
        fs.writeFileSync(filename, header + skill.script, "utf-8");
      }

      // Try git commit
      try {
        await execFileAsync("git", ["add", skillsDir], { timeout: 10_000 });
        await execFileAsync(
          "git",
          ["commit", "-m", `chore: deploy ${skills.length} research skills [skip ci]`],
          { timeout: 10_000 },
        );
        this.log(`[research] Committed ${skills.length} skills to git`);
      } catch {
        this.log("[research] Git commit skipped (not in a git repo or no changes)");
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      this.log(`[research] autoCommitSkills failed: ${msg}`);
    }
  }

  /**
   * Generate an offline skill script for a known detection vector.
   * These are basic overrides that address common detection patterns.
   */
  private generateOfflineSkill(vector: string, domain: string): string {
    const templates: Record<string, string> = {
      webdriver_detected: `(function() { Object.defineProperty(navigator, 'webdriver', { get: () => false, configurable: true }); })();`,
      chrome_runtime_missing: `(function() { if (!window.chrome) window.chrome = {}; if (!window.chrome.runtime) window.chrome.runtime = { id: 'x' }; })();`,
      css_supports_mismatch: `(function() { var orig = CSS.supports; CSS.supports = function() { return orig.apply(this, arguments); }; })();`,
      canvas_fingerprint: `(function() { var orig = HTMLCanvasElement.prototype.toDataURL; HTMLCanvasElement.prototype.toDataURL = function(type) { return orig.call(this, type); }; })();`,
      timezone_mismatch: `(function() { /* Handled by stealth-scripts timezone alignment */ })();`,
      hardware_concurrency_anomaly: `(function() { Object.defineProperty(navigator, 'hardwareConcurrency', { get: () => 4, configurable: true }); })();`,
    };

    return templates[vector] ??
      `// AutoResearchClaw skill for ${vector}\n// Target: ${domain}\n// No template available — manual investigation needed`;
  }

  // ── Internals ──────────────────────────────────────────────────────────

  private deploySkills(skills: ResearchSkill[]): void {
    for (const skill of skills) {
      // Remove any existing skill for the same vector+target
      this.skills = this.skills.filter(
        s => !(s.vector === skill.vector && s.target === skill.target),
      );
      this.skills.push(skill);
    }
    saveSkills(this.skills, this.skillsPath);
    this.log(`[research] Deployed ${skills.length} skills`);
  }

  private blacklistDomain(domain: string): void {
    const now = Date.now();
    const existing = this.state.blacklistedDomains.find(b => b.domain === domain);
    if (existing) {
      existing.expiresAt = now + this.blacklistMs;
    } else {
      this.state.blacklistedDomains.push({
        domain,
        expiresAt: now + this.blacklistMs,
      });
    }
    this.log(`[research] Blacklisted ${domain} for ${DEFAULT_BLACKLIST_HOURS}h`);
  }

  private evictExpiredBlacklist(): void {
    const now = Date.now();
    this.state.blacklistedDomains = this.state.blacklistedDomains.filter(
      b => b.expiresAt > now,
    );
  }

  private extractDomain(url: string): string {
    try {
      return new URL(url).hostname;
    } catch {
      return url.replace(/^https?:\/\//, "").split("/")[0] ?? url;
    }
  }

  private persist(): void {
    saveState(this.state, this.statePath);
  }
}

// ── Singleton ────────────────────────────────────────────────────────────────

let _singleton: ResearchOrchestrator | undefined;

export function getOrchestrator(opts?: OrchestratorOptions): ResearchOrchestrator {
  if (!_singleton) {
    _singleton = new ResearchOrchestrator(opts);
  }
  return _singleton;
}

export function _resetOrchestrator(): void {
  _singleton = undefined;
}

export function generateOfflineSkill(vector: string, domain: string): string {
  const templates: Record<string, string> = {
    webdriver_detected: "(function() { Object.defineProperty(navigator, 'webdriver', { get: () => false, configurable: true }); })();",
    chrome_runtime_missing: "(function() { if (!window.chrome) window.chrome = {}; if (!window.chrome.runtime) window.chrome.runtime = { id: 'x' }; })();",
    css_supports_mismatch: "(function() { var orig = CSS.supports; CSS.supports = function() { return orig.apply(this, arguments); }; })();",
    canvas_fingerprint: "(function() { var orig = HTMLCanvasElement.prototype.toDataURL; HTMLCanvasElement.prototype.toDataURL = function(type) { return orig.call(this, type); }; })();",
    timezone_mismatch: "(function() { /* Handled by stealth-scripts timezone alignment */ })();",
    hardware_concurrency_anomaly: "(function() { Object.defineProperty(navigator, 'hardwareConcurrency', { get: () => 4, configurable: true }); })();",
  };
  return templates[vector] ?? `// AutoResearchClaw skill for ${vector}\n// Target: ${domain}\n// No template available — manual investigation needed`;
}
