import fs from 'fs';
import path from 'path';
import vm from 'node:vm';
import { createLogger } from '../core/logger.js';
import { readRecentRecords, computePhaseStats, type PhaseTimings } from './timing-telemetry.js';
import { addProposal, calculateConfidence, type ProposalEvidence } from './hermes-proposals.js';
import { HermesLLM, getHermesLLM } from './hermes-llm.js';
import { DynamicTimings } from '../core/timings.js';
import { insertRevision, getLastActiveRevision, markRevisionRolledBack } from '../core/database.js';

const log = createLogger('OpsOrchestrator');

export interface OpsSkill {
  id: string;
  triggerCondition: string;
  script: string;
  createdAt: string;
}

// Timing constants we can propose changes to
const ANALYZABLE_TIMINGS: Array<{ constant: string; phase: keyof PhaseTimings; file: string }> = [
  { constant: "COOKIE_POST_DISMISS_SETTLE", phase: "cookieDismissMs", file: "src/core/timings.ts" },
  { constant: "POST_SUBMIT_DOM_SETTLE", phase: "submitMs", file: "src/core/timings.ts" },
  { constant: "POST_CLICK_RACE_DELAY", phase: "submitMs", file: "src/core/timings.ts" },
  { constant: "INTER_ATTEMPT_PAUSE", phase: "credentialFillMs", file: "src/core/timings.ts" },
  { constant: "FAST_RACE_WINDOW", phase: "responseWaitMs", file: "src/core/timings.ts" },
];

/**
 * Operations Orchestrator
 * Executes AI-generated server maintenance scripts safely.
 * Enhanced with post-batch timing analysis and LLM-powered insights.
 */
export class OpsOrchestrator {
  private skillsDir: string;
  private activeSkills: OpsSkill[] = [];
  private onSkillComplete?: (skill: OpsSkill, success: boolean, output: string) => void;
  private llm: HermesLLM;

  constructor(opts?: { onSkillComplete?: (skill: OpsSkill, success: boolean, output: string) => void }) {
    this.onSkillComplete = opts?.onSkillComplete;
    this.skillsDir = path.join(process.cwd(), '.agents', 'skills', 'ops');
    this.llm = getHermesLLM();
    this.init();
  }

  private init() {
    try {
      if (!fs.existsSync(this.skillsDir)) {
        fs.mkdirSync(this.skillsDir, { recursive: true });
      } else {
        this.loadSkills();
      }
    } catch (e) {
      log.warn(`[Ops] Failed to initialize skills directory: ${String(e)}`);
    }
  }

  private loadSkills() {
    const files = fs.readdirSync(this.skillsDir).filter(f => f.endsWith('.json'));
    for (const file of files) {
      try {
        const skill = JSON.parse(fs.readFileSync(path.join(this.skillsDir, file), 'utf8'));
        this.activeSkills.push(skill);
      } catch (e) {
        log.warn(`[Ops] Failed to load skill ${file}: ${String(e)}`);
      }
    }
    log.info(`[Ops] Loaded ${this.activeSkills.length} active autonomous OpsSkills.`);
  }

  public registerOpsSkill(script: string, triggerCondition: string = 'manual') {
    const id = `ops_skill_${Date.now()}`;
    const skill: OpsSkill = {
      id,
      triggerCondition,
      script,
      createdAt: new Date().toISOString()
    };
    this.activeSkills.push(skill);
    try {
      fs.writeFileSync(
        path.join(this.skillsDir, `${id}.json`),
        JSON.stringify(skill, null, 2)
      );
      log.info(`[Ops] Registered new OpsSkill: ${id} (trigger: ${triggerCondition})`);
    } catch (e) {
      log.warn(`[Ops] Failed to save skill ${id}: ${String(e)}`);
    }
  }

  public async executeSkill(skill: OpsSkill) {
    log.info(`[Ops] Executing OpsSkill: ${skill.id}...`);
    return new Promise<void>((resolve) => {
      try {
        const sandboxContext = vm.createContext({
          console: {
            log: (...args: any[]) => log.info(`[OpsSkill ${skill.id}]`, ...args),
            error: (...args: any[]) => log.warn(`[OpsSkill ${skill.id}] ERROR:`, ...args),
            warn: (...args: any[]) => log.warn(`[OpsSkill ${skill.id}] WARN:`, ...args)
          },
          fetch: fetch,
          setTimeout: setTimeout,
          clearTimeout: clearTimeout
        });

        // Run the script in the isolated context with a strict timeout
        vm.runInNewContext(skill.script, sandboxContext, { timeout: 5000 });
        
        log.info(`[Ops] OpsSkill ${skill.id} executed successfully in sandbox.`);
        this.onSkillComplete?.(skill, true, "Sandbox execution OK");
      } catch (err) {
        log.warn(`[Ops] OpsSkill ${skill.id} FAILED in sandbox: ${err instanceof Error ? err.message : String(err)}`);
        this.onSkillComplete?.(skill, false, err instanceof Error ? err.message : String(err));
      }
      resolve();
    });
  }

  public async evaluateTriggers(context: { recentOutcomes: string[]; stats: Record<string, number>; successRate?: number }) {
    // 1. Rollback mechanism
    if (context.successRate !== undefined && context.successRate < 0.4) {
      // Success rate is below 40% (a severe drop), let's check for recent revisions to rollback
      const lastRevision = getLastActiveRevision();
      if (lastRevision) {
        log.warn(`🚨 [Ops] Success rate dropped to ${Math.round(context.successRate * 100)}%. Triggering rollback of revision ${lastRevision.id} (${lastRevision.revision_type}).`);
        
        if (lastRevision.revision_type === 'timing') {
          const prevState = JSON.parse(lastRevision.previous_state) as Record<string, number>;
          Object.assign(DynamicTimings, prevState);
          log.info(`[Ops] Restored DynamicTimings to pre-revision state.`);
        } else if (lastRevision.revision_type === 'skill') {
          // Disable the skill by removing it from active
          this.activeSkills = this.activeSkills.filter(s => s.id !== lastRevision.target_id);
          log.info(`[Ops] Disabled anomalous OpsSkill ${lastRevision.target_id}.`);
        }
        
        markRevisionRolledBack(lastRevision.id, "Success rate dropped below threshold");
      }
    }

    // 2. Normal anomaly execution
    for (const skill of this.activeSkills) {
      if (skill.triggerCondition === 'manual') continue;
      if (skill.triggerCondition.includes('anomaly') && context.recentOutcomes.includes('blocked')) {
        await this.executeSkill(skill);
      }
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // 📊 POST-BATCH TIMING ANALYSIS
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Run post-batch analysis on timing telemetry data.
   * Reads recent records, computes statistics, and generates proposals.
   */
  public async postBatchAnalysis(hoursBack: number = 4): Promise<number> {
    const records = readRecentRecords(hoursBack);
    if (records.length < 5) {
      log.info(`[Ops] Post-batch: Only ${records.length} records in last ${hoursBack}h — need 5+ for analysis.`);
      return 0;
    }

    log.info(`[Ops] 📊 Post-batch analysis starting with ${records.length} records from last ${hoursBack}h...`);

    let proposalsGenerated = 0;

    for (const { constant, phase, file } of ANALYZABLE_TIMINGS) {
      const stats = computePhaseStats(records, phase);
      if (!stats || stats.count < 5) continue;

      // Get the current timing constant value
      const currentValue = (DynamicTimings as unknown as Record<string, number>)[constant];
      if (currentValue === undefined) continue;

      // Check if P95 is significantly lower than current value (room to reduce)
      const margin = 1.3; // 30% safety margin
      const safeProposed = Math.round(stats.p95 * margin);

      if (safeProposed < currentValue * 0.8) {
        // There's room for at least 20% reduction
        const successRate = records.filter(r => r.success).length / records.length;
        const evidence: ProposalEvidence = {
          sampleCount: stats.count,
          p50Ms: stats.p50,
          p95Ms: stats.p95,
          maxMs: stats.max,
          minMs: stats.min,
          meanMs: stats.mean,
          successRate,
        };

        const confidence = calculateConfidence(evidence);

        // Record a snapshot of the state before creating the proposal, so if applied it can be rolled back
        insertRevision(
          "timing",
          constant,
          JSON.stringify(DynamicTimings),
          JSON.stringify({ ...DynamicTimings, [constant]: safeProposed })
        );

        addProposal({
          type: "timing_reduction",
          constant,
          file,
          currentValue,
          proposedValue: safeProposed,
          confidence,
          reasoning: `P95=${stats.p95}ms with ${margin}x margin = ${safeProposed}ms. Current ${constant}=${currentValue}ms. ${Math.round((1 - safeProposed / currentValue) * 100)}% reduction possible. Based on ${stats.count} samples.`,
          evidence,
        });

        proposalsGenerated++;
        log.info(`[Ops] 📈 Proposal: ${constant} ${currentValue}ms → ${safeProposed}ms (${Math.round((1 - safeProposed / currentValue) * 100)}% reduction, confidence: ${confidence})`);
      }
    }

    log.info(`[Ops] 📊 Post-batch analysis complete: ${proposalsGenerated} proposals generated.`);
    return proposalsGenerated;
  }

  /**
   * Run LLM-powered deep analysis on the batch results.
   * Produces a natural language summary with actionable insights.
   */
  public async deepBatchAnalysis(hoursBack: number = 4): Promise<string | null> {
    if (!this.llm.isAvailable()) return null;

    const records = readRecentRecords(hoursBack);
    if (records.length < 3) return null;

    const successCount = records.filter(r => r.success).length;
    const failCount = records.length - successCount;
    const verdictCounts: Record<string, number> = {};
    for (const r of records) {
      verdictCounts[r.verdict] = (verdictCounts[r.verdict] || 0) + 1;
    }

    const phaseSummaries: string[] = [];
    for (const phase of ["cookieDismissMs", "credentialFillMs", "submitMs", "responseWaitMs", "totalE2EMs"] as const) {
      const stats = computePhaseStats(records, phase);
      if (stats) {
        phaseSummaries.push(`${phase}: P50=${stats.p50}ms, P95=${stats.p95}ms, max=${stats.max}ms (${stats.count} samples)`);
      }
    }

    const userContent = `Batch Results (last ${hoursBack} hours):
- Total attempts: ${records.length}
- Successes: ${successCount} (${Math.round(successCount / records.length * 100)}%)
- Failures: ${failCount}
- Verdicts: ${Object.entries(verdictCounts).map(([k, v]) => `${k}: ${v}`).join(", ")}

Phase Timing Statistics:
${phaseSummaries.join("\n")}

Sites: ${[...new Set(records.map(r => r.site))].join(", ")}
Backends: ${[...new Set(records.map(r => r.backend))].join(", ")}

Provide:
1. A 2-sentence summary of batch health
2. The top 3 actionable improvements to make
3. Any patterns in failures that suggest systematic issues`;

    const result = await this.llm.analyzeText(
      "You are Hermes-Analyst performing post-batch analysis of web automation timing data. Be specific and actionable.",
      userContent
    );

    if (result.content) {
      log.info(`[Ops] 🧠 Deep batch analysis:\n${result.content}`);

      // Persist the analysis
      try {
        const analysisDir = path.join(process.cwd(), "data", "hermes-intelligence");
        if (!fs.existsSync(analysisDir)) fs.mkdirSync(analysisDir, { recursive: true });
        fs.appendFileSync(
          path.join(analysisDir, "batch-analyses.jsonl"),
          JSON.stringify({
            timestamp: new Date().toISOString(),
            hoursBack,
            recordCount: records.length,
            successRate: successCount / records.length,
            analysis: result.content,
            model: result.model,
            latencyMs: result.latencyMs,
          }) + "\n"
        );
      } catch { /* ignore persistence failures */ }

      return result.content;
    }

    return null;
  }

  /**
   * GLM-4 Watchdog log analysis (legacy — kept for backwards compatibility).
   */
  public async analyzeLogs(logText: string) {
    const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
    if (!OPENROUTER_API_KEY) return;

    try {
      log.info(`[Ops] Sending ${logText.length} chars of log data to GLM-4.6 Watchdog...`);
      const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${OPENROUTER_API_KEY}`
        },
        body: JSON.stringify({
          model: "zhipu/glm-4", // Zhipu AI GLM-4 via OpenRouter
          messages: [{
            role: "user",
            content: `You are the Hermes Watchdog. Analyze these server logs for severe anomalies, repeated proxy bans, or memory leaks.\nIf you detect a severe anomaly requiring immediate intervention, output ONLY a JSON object: {"action": "create_skill", "trigger": "anomaly", "script": "// nodejs code to fix"}. If everything is fine, output "OK".\n\nLogs:\n${logText.substring(0, 50000)}`
          }]
        }),
        signal: AbortSignal.timeout(30000)
      });

      const json = await response.json() as { choices?: Array<{ message?: { content?: string } }> };
      const aiResponse = json.choices?.[0]?.message?.content?.trim();

      if (aiResponse && aiResponse !== "OK") {
        if (aiResponse.includes('{"action"')) {
           const match = aiResponse.match(/\{[\s\S]*\}/);
           if (match) {
             const parsed = JSON.parse(match[0]);
             if (parsed.action === 'create_skill' && parsed.script) {
               log.warn(`🚨 [Ops] GLM-4 detected anomaly! Generating emergency OpsSkill!`);
               this.registerOpsSkill(parsed.script, "glm4-anomaly-generated");
             }
           }
        }
      }
    } catch (e) {
      log.warn(`[Ops] GLM-4 Log Analysis failed: ${String(e)}`);
    }
  }

  /**
   * Autonomous Stale Context & Process Sweeper
   */
  public async healStaleContexts(): Promise<{ killed: number; cleanedProfiles: number }> {
    log.info("[Ops] 🧹 Initiating autonomous context & zombie sweep...");
    let killed = 0;
    let cleanedProfiles = 0;

    try {
      const { killOurOrphans } = await import("../services/process-cleaner.js");
      const result = await killOurOrphans({ timeoutMs: 5000, minEtimeSec: 180 });
      killed = result.killed;
    } catch (e) {
      log.warn(`[Ops] Process cleaner failed: ${String(e)}`);
    }

    try {
      const tempDir = path.join(process.cwd(), "data", "temp_profiles");
      if (fs.existsSync(tempDir)) {
        const files = fs.readdirSync(tempDir);
        const now = Date.now();
        for (const file of files) {
          const filePath = path.join(tempDir, file);
          try {
            const stat = fs.statSync(filePath);
            if (now - stat.mtimeMs > 30 * 60 * 1000) { // older than 30 mins
              fs.rmSync(filePath, { recursive: true, force: true });
              cleanedProfiles++;
            }
          } catch {}
        }
      }
    } catch (e) {
      log.warn(`[Ops] Temp profiles cleanup failed: ${String(e)}`);
    }

    log.info(`[Ops] 🧹 Sweep complete: Reaped ${killed} processes, purged ${cleanedProfiles} stale profile directories.`);
    return { killed, cleanedProfiles };
  }

  /**
   * Autonomous Dynamic Concurrency Governor
   */
  public dynamicConcurrencyGovernor(recentOutcomes: string[], currentConcurrency: number): { recommendedConcurrency: number; action: "throttle" | "expand" | "maintain"; reason: string } {
    if (recentOutcomes.length < 3) {
      return { recommendedConcurrency: currentConcurrency, action: "maintain", reason: "Insufficient sample size" };
    }

    const recent = recentOutcomes.slice(-10);
    const blockCount = recent.filter(o => o === "blocked" || o === "rate_limited" || o === "crash").length;
    const blockRate = blockCount / recent.length;

    if (blockRate >= 0.4 && currentConcurrency > 1) {
      const newConcurrency = Math.max(1, currentConcurrency - 1);
      log.warn(`🚨 [Ops Governor] Block rate elevated (${Math.round(blockRate * 100)}%). Auto-throttling concurrency: ${currentConcurrency} → ${newConcurrency}`);
      return { recommendedConcurrency: newConcurrency, action: "throttle", reason: `Elevated block rate (${Math.round(blockRate * 100)}%)` };
    }

    const successCount = recent.filter(o => o === "success" || o === "incorrect" || o === "tempdisabled" || o === "disabled").length;
    const cleanRate = successCount / recent.length;

    if (cleanRate >= 0.9 && recent.length >= 8 && currentConcurrency < 6) {
      const newConcurrency = currentConcurrency + 1;
      log.info(`⚡ [Ops Governor] Clean flow detected (${Math.round(cleanRate * 100)}%). Auto-expanding concurrency: ${currentConcurrency} → ${newConcurrency}`);
      return { recommendedConcurrency: newConcurrency, action: "expand", reason: `High clean flow rate (${Math.round(cleanRate * 100)}%)` };
    }

    return { recommendedConcurrency: currentConcurrency, action: "maintain", reason: "Flow parameters stable" };
  }

  /**
   * Autonomous High-Confidence Proposal Applicator
   */
  public async autoApplyProposals(minConfidence: number = 0.85): Promise<number> {
    const { getPendingProposals, reviewProposal } = await import("./hermes-proposals.js");
    const proposals = getPendingProposals().filter(p => p.confidence >= minConfidence);
    let appliedCount = 0;

    for (const proposal of proposals) {
      try {
        if (proposal.type === "timing_reduction" && proposal.constant && proposal.proposedValue !== undefined) {
          (DynamicTimings as unknown as Record<string, number>)[proposal.constant] = proposal.proposedValue;
          reviewProposal(proposal.id, "approved");
          appliedCount++;
          log.info(`⚡ [Ops] Auto-applied high-confidence timing reduction: ${proposal.constant} = ${proposal.proposedValue}ms (confidence: ${proposal.confidence})`);
        }
      } catch (e) {
        log.warn(`[Ops] Failed to auto-apply proposal ${proposal.id}: ${String(e)}`);
      }
    }

    return appliedCount;
  }
}



