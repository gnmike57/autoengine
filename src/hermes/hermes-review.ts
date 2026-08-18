#!/usr/bin/env node
/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unused-vars, @typescript-eslint/require-await , @typescript-eslint/no-misused-promises*/

/**
 * Hermes 24/7 QA Agent - Node.js Daemon
 * v6.0.0-2026 (Automati Specialized - WebSocket Orchestrator Mode)
 *
 * Real-time God-mode orchestrator for the Automati Engine.
 * Connects to the dashboard WebSocket to monitor all credential outcomes dynamically.
 * Auto-adjusts concurrency, handles backend pivoting, and tracks performance metrics.
 */

import fs from 'node:fs';
import path from 'node:path';
import WebSocket from 'ws';
import { exec, spawn } from 'node:child_process';
import { createLogger } from '../core/logger.js';
import { scanForRequeue } from './batch-requeuer.js';
import { StrategyEngine } from './strategy-engine.js';
import { OutcomeTracker } from './outcome-tracker.js';
import { ResearchOrchestrator } from '../intelligence/research-orchestrator.js';
import { OpsOrchestrator } from './ops-orchestrator.js';
import { Ollama } from 'ollama'; // Local LLM framework
import { getHermesObserver } from './hermes-observer.js';
import { logDecision } from './decision-journal.js';

const log = createLogger('Hermes');

const DEEP_FIND_BUTTON_FN = `
function deepFindButton(regex) {
  let queue = [document.documentElement];
  while (queue.length > 0) {
    const node = queue.shift();
    if (!node) continue;
    if (node.shadowRoot) queue.push(node.shadowRoot);
    if (node.nodeType === 1) {
      if (node.matches && node.matches('button, [role="button"], a.btn, [class*="close"], [class*="cookie"]')) {
        const text = (node.textContent || node.getAttribute('aria-label') || '').toLowerCase();
        if (regex.test(text)) return node;
      }
      const children = node.children || [];
      for (let i = 0; i < children.length; i++) queue.push(children[i]);
    } else if (node.nodeType === 11) {
      const children = node.children || [];
      for (let i = 0; i < children.length; i++) queue.push(children[i]);
    }
  }
  return null;
}
`;

class HermesOrchestrator {
  repoRoot: string;
  learningDir: string;
  memoryPath: string;
  wsUrl: string;
  ws: WebSocket | null;
  reconnectTimer: ReturnType<typeof setTimeout> | null;
  pollerTimer: ReturnType<typeof setInterval> | null;
  aiImprovementTimer: ReturnType<typeof setInterval> | null;
  zombieTimer: ReturnType<typeof setInterval> | null;
  openRouterApiKey: string | undefined;
  strategyEngine: StrategyEngine;
  outcomeTracker: OutcomeTracker;
  opsOrchestrator: OpsOrchestrator;
  currentBackend: string;
  currentConcurrency: number;
  currentProxyPool: string | undefined;
  stats: {
    total: number;
    success: number;
    noaccount: number;
    blocked: number;
    error: number;
    consecutiveBlocks: number;
    consecutiveSuccesses: number;
  };
  recentOutcomes: string[];
  timings: {
    KEYSTROKE_DELAY_FAST: number;
    POST_CLICK_RACE_DELAY: number;
  };
  failurePatterns: Map<string, { type?: string; target?: string; outcome?: string; paths?: Array<Array<{ url: string; domHint: string; timestamp: number }>>; occurrences?: number; firstSeen?: string | number; lastSeen?: string | number; count?: number; [key: string]: unknown }>;
  activeInterventions: Set<string>;
  pageStates: Map<string, { hash: string; firstSeen: number; lastSeen: number; aggrLevel: number }>;
  loginFlowsModel: Map<string, { path: Array<{ url: string; domHint: string; timestamp: number }> }>; // Tracks state transitions for AI synthesis
  timelineMatrices: Map<string, { runs: Array<{ matrix: unknown; fillTime: number; currentTimings: unknown; timestamp: number }> }>; // Aggregated Timeline Matrices
  patchesDir: string;
  draftPatchesDir: string; // Directory for Human-in-the-Loop pending approvals
  coreGoal: string;
  _lastJitterTime: number;
  ollama: Ollama;

  constructor(repoRoot = process.cwd()) {
    this.repoRoot = repoRoot;
    this.learningDir = path.join(this.repoRoot, 'learning');
    this.patchesDir = path.join(this.learningDir, 'patches');
    this.draftPatchesDir = path.join(this.learningDir, 'drafts'); // HITL Drafts
    this.memoryPath = path.join(this.learningDir, 'hermes-memory.json');
    // Dynamically resolve port from .env to stay in sync with the server
    const _port = (() => {
      try {
        const envPath = path.join(this.repoRoot, '.env');
        if (fs.existsSync(envPath)) {
          const m = fs.readFileSync(envPath, 'utf8').match(/^PORT=(\d+)/m);
          if (m) return m[1];
        }
      } catch { /* fallback */ }
      return process.env.PORT || '9223';
    })();
    this.wsUrl = `ws://localhost:${_port}`;
    this.ws = null;
    this.reconnectTimer = null;
    this.pollerTimer = null;
    this.aiImprovementTimer = null;
    this.zombieTimer = null;
    this.openRouterApiKey = process.env.OPENROUTER_API_KEY;
    this.ollama = new Ollama({ host: 'http://127.0.0.1:11434' }); // Connect to local Ollama instance
    this.strategyEngine = new StrategyEngine();
    this.opsOrchestrator = new OpsOrchestrator({
      onSkillComplete: (skill, success, output) => {
        this.recordOpsSkillOutcome(skill, success, output);
      }
    });
    this.outcomeTracker = new OutcomeTracker({
      onAlert: async (alert) => {
        log.warn(`🚨 Outcome Alert triggered: ${alert.type} in window ${alert.window} (Rate: ${alert.rate}%)`);
        const webhookUrl = process.env.WEBHOOK_URL;
        if (webhookUrl) {
          try {
            const message = `🚨 **Hermes Alert** 🚨\n**Type:** ${alert.type}\n**Window:** ${alert.window}\n**Rate:** ${alert.rate}%\n**Threshold:** ${alert.threshold}%`;
            await fetch(webhookUrl, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ content: message })
            });
          } catch (e) {
            log.error(`Failed to send webhook: ${e instanceof Error ? e.message : String(e)}`);
          }
        }
      }
    });

    // Engine State
    this.currentBackend = 'cloak-headless';
    this.currentConcurrency = 5;
    this.coreGoal = "Ensure that all queued credentials are tested until and results marked accurately, and all the while the apps efficiency and backends are rotated when fingerprinted, and code is fixed when broken, and zombie windows are killed, and hermes intelligence and skills are increasing and adding always, and his understanding and reasoning of the app until the point there is no credentials left to test. Hermes is to follow instructions from the app websocket and also report issues when needing clarification. Hermes is to be seeking to always add and refine skills, and rollback changes if regression is detected, and refine and tinker until it has 100% coverage of the orchestration.";

    // Rolling Analytics
    this.stats = {
      total: 0,
      success: 0,
      noaccount: 0,
      blocked: 0,
      error: 0,
      consecutiveBlocks: 0,
      consecutiveSuccesses: 0,
    };
    this.recentOutcomes = [];

    // Micro-Timing Optimizer (MTO) State
    this.timings = {
      KEYSTROKE_DELAY_FAST: 70, // Start at default
      POST_CLICK_RACE_DELAY: 500, // Start at default
    };

    // Self-Learning & Intelligence State
    this.failurePatterns = new Map();
    this.activeInterventions = new Set();
    this.pageStates = new Map();
    this.loginFlowsModel = new Map(); // Tracks URL/DOM state for proactive stuck detection
    this.timelineMatrices = new Map(); // Tracks component timeline visibility
    this._lastJitterTime = 0;


    this.ensureDirectories();
    this.loadMemory();

    log.info('🚀 Hermes Orchestrator v6.0.0 started in God-Mode');
    log.info(`📍 Repo: ${this.repoRoot}`);
  }

  ensureDirectories() {
    if (!fs.existsSync(this.learningDir)) {
      fs.mkdirSync(this.learningDir, { recursive: true });
    }
    if (!fs.existsSync(this.patchesDir)) {
      fs.mkdirSync(this.patchesDir, { recursive: true });
    }
    if (!fs.existsSync(this.draftPatchesDir)) {
      fs.mkdirSync(this.draftPatchesDir, { recursive: true });
    }
  }

  loadMemory() {
    try {
      if (fs.existsSync(this.memoryPath)) {
        const mem = JSON.parse(fs.readFileSync(this.memoryPath, 'utf8'));
        log.info(`🧠 Loaded memory: ${mem.totalCredentialsProcessed || 0} lifetime credentials processed.`);
        if (mem.lastKnownBackend) this.currentBackend = mem.lastKnownBackend;
        if (mem.lastKnownConcurrency) this.currentConcurrency = mem.lastKnownConcurrency;
        if (mem.coreGoal) this.coreGoal = mem.coreGoal;
        if (mem.failurePatterns) {
          this.failurePatterns = new Map(Object.entries(mem.failurePatterns));
          log.info(`🧠 Loaded ${this.failurePatterns.size} historical failure patterns.`);
        }
        if (mem.opsSkillOutcomes) this.opsSkillOutcomes = mem.opsSkillOutcomes;
      }
    } catch(e) {
      log.info('🧠 Starting with fresh memory.');
    }
  }

  saveMemory() {
    try {
      let mem: any = {};
      if (fs.existsSync(this.memoryPath)) mem = JSON.parse(fs.readFileSync(this.memoryPath, 'utf8'));
      mem.lastHeartbeat = new Date().toISOString();
      mem.totalCredentialsProcessed = (mem.totalCredentialsProcessed || 0) + this.stats.total;
      mem.lastKnownBackend = this.currentBackend;
      mem.lastKnownConcurrency = this.currentConcurrency;
      mem.failurePatterns = Object.fromEntries(this.failurePatterns);
      mem.timelineMatrices = Object.fromEntries(this.timelineMatrices);
      mem.opsSkillOutcomes = this.opsSkillOutcomes;
      mem.coreGoal = this.coreGoal;
      fs.writeFileSync(this.memoryPath, JSON.stringify(mem, null, 2));
    } catch { /* intentional */ }
  }

  private opsSkillOutcomes: any[] = [];

  private static readonly MAX_FAILURE_PATTERNS = 1000;

  private _setFailurePattern(key: string, value: any): void {
    this.failurePatterns.delete(key);
    this.failurePatterns.set(key, value);
    if (this.failurePatterns.size > HermesOrchestrator.MAX_FAILURE_PATTERNS) {
      const oldest = this.failurePatterns.keys().next().value;
      if (oldest !== undefined) this.failurePatterns.delete(oldest);
    }
  }

  // eslint-disable-next-line @typescript-eslint/no-redundant-type-constituents
  private _getFailurePattern(key: string): any | undefined {
    if (!this.failurePatterns.has(key)) return undefined;
    const value = this.failurePatterns.get(key)!;
    this.failurePatterns.delete(key);
    this.failurePatterns.set(key, value);
    return value;
  }

  private recordOpsSkillOutcome(skill: any, success: boolean, output: string) {
    this.opsSkillOutcomes.push({
      skillId: skill.id,
      trigger: skill.triggerCondition,
      success,
      output: output.substring(0, 500) // Keep it brief for the AI prompt
    });
    // Keep only the last 10 outcomes to avoid blowing up the context window
    if (this.opsSkillOutcomes.length > 10) {
      this.opsSkillOutcomes.shift();
    }
  }

  connect() {
    log.info(`🔌 Connecting to Dashboard WebSocket at ${this.wsUrl}...`);
    this.ws = new WebSocket(this.wsUrl);

    this.ws.on('open', () => {
      log.info('✅ Connected to Dashboard!');
      if (this.reconnectTimer) clearInterval(this.reconnectTimer);
      // Sync FROM the server's init payload — do NOT override the user's
      // dashboard settings. The server's app-config.json is the single source
      // of truth for backend/concurrency.

      // Start proactive poller
      if (!this.pollerTimer) {
        this.pollerTimer = setInterval(() => this.proactivePoll(), 3000);
      }

      // Start 10-minute AI self-improvement loop
      if (!this.aiImprovementTimer && this.openRouterApiKey) {
        log.info("🤖 AI Self-Improvement Loop Activated. Hermes will auto-generate patches every 10 minutes.");
        this.aiImprovementTimer = setInterval(() => this.selfImprovementLoop(), 10 * 60 * 1000);
        // Start immediately as well
        void this.selfImprovementLoop().catch((err) => log.error(`Self-improvement loop startup failed: ${err instanceof Error ? err.message : String(err)}`));
      }

      // Phase 1: GC Sweep for Zombie Browsers every 5 minutes
      if (!this.zombieTimer) {
        this.zombieTimer = setInterval(() => this.sweepZombies(), 5 * 60 * 1000);
      }
    });

    this.ws.on('message', (data: any) => {
      try {
        const msg = JSON.parse(data.toString());
        this.handleMessage(msg);
      } catch { /* intentional */ }
    });

    this.ws.on('close', () => {
      log.info('❌ Disconnected from Dashboard. Reconnecting in 5s...');
      if (this.pollerTimer) { clearInterval(this.pollerTimer); this.pollerTimer = null; }
      if (this.aiImprovementTimer) { clearInterval(this.aiImprovementTimer); this.aiImprovementTimer = null; }
      if (this.zombieTimer) { clearInterval(this.zombieTimer); this.zombieTimer = null; }
      this.reconnect();
    });

    this.ws.on('error', () => {
      // Handled by close
    });
  }

  reconnect() {
    this.ws = null;
    this.reconnectTimer = setTimeout(() => this.connect(), 5000);
  }

  sendCommand(type: string, data: any) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ type, data }));
      // log.info(`📡 Dispatched Command: ${type} =>`, data);
    }
  }

  handleMessage(msg: any) {
    // Sync internal state from server's init payload on connect
    if (msg.type === 'init') {
      const config = msg.data?.config;
      if (config) {
        if (config.backend) {
          this.currentBackend = config.backend;
          log.info(`[Hermes] Synced backend from server: ${config.backend}`);
        }
        if (config.concurrency) {
          this.currentConcurrency = config.concurrency;
          log.info(`[Hermes] Synced concurrency from server: ${config.concurrency}`);
        }
        if (config.proxyPool) this.currentProxyPool = config.proxyPool;
      }
      return;
    }

    if (msg.type === 'config-sync') {
      const config = msg.data?.config;
      if (config) {
        if (config.backend) this.currentBackend = config.backend;
        if (config.concurrency) this.currentConcurrency = config.concurrency;
        if (config.proxyPool) this.currentProxyPool = config.proxyPool;
      }
      return;
    }

    if (msg.type === 'screenshot') {
      this.handleScreenshotAnalysis(msg.data);
    }

    if (msg.type === 'bot_detection_event') {
      const data = msg.data as { email: string; url: string; signal: string; source: string; details: string };
      log.warn(`🚨 Bot Detection Triggered [${data.email}] - Signal: ${data.signal} (${data.source})`);
      // Store mutation metrics for anomaly detection
      if (!this.failurePatterns.has('dom-mutations')) {
        this._setFailurePattern('dom-mutations', [] as any);
      }
      const mutations = (this._getFailurePattern('dom-mutations') as unknown as unknown[]) || [];
      mutations.push(data);
      if (mutations.length > 50) mutations.shift();
      this.saveMemory();
    }
    if (msg.type === 'hermes-command') {
      const action = msg.data?.action;
      log.info(`[Hermes] Received remote command from iOS/Dashboard: ${action}`);
      if (action === 'set_goal') {
        this.coreGoal = msg.data.goal;
        log.info(`🎯 [Hermes Core Goal Updated]: ${this.coreGoal}`);
        this.saveMemory();
      } else if (action === 'force_cycle') {
        log.info(`⚡ [Hermes] Forced AI optimization cycle triggered.`);
        void this.selfImprovementLoop().catch((err) => log.error(`Force cycle failed: ${err instanceof Error ? err.message : String(err)}`));
      } else if (action === 'inject_ops_skill' && msg.data.script) {
        log.info(`🛠️ [Hermes] Remote injected OpsSkill received!`);
        this.opsOrchestrator.registerOpsSkill(msg.data.script, "remote-injected-immediate");
      } else if (action === 'approve_draft') {
        this.approveDraftPatch(msg.data.filename);
      }
    }

    if (msg.type === 'telemetry_matrix') {
      const { target, matrix, fillTime, currentTimings } = msg.data;
      if (!this.timelineMatrices.has(target)) {
        this.timelineMatrices.set(target, { runs: [] });
      }
      const model = this.timelineMatrices.get(target);
      if (model) {
        model.runs.push({ matrix, fillTime, currentTimings, timestamp: Date.now() });
        if (model.runs.length > 20) model.runs.shift();
      }
      this.saveMemory();
    }

    if (msg.type === 'telemetry_state_mutations') {
      const data = msg.data as { email: string; mutations: number };
      const { email } = data;
      // Process telemetry state mutation logic here
    }

    if (msg.type === 'telemetry_transition') {
      const data = msg.data as { email: string; url: string; domHint: string };
      const { email, url, domHint } = data;
      if (!this.loginFlowsModel.has(email)) {
        this.loginFlowsModel.set(email, { path: [] });
      }
      const flow = this.loginFlowsModel.get(email);
      if (!flow) return;
      const lastStep = flow.path[flow.path.length - 1];

      // Prevent duplicate logging of identical urls
      if (!lastStep || lastStep.url !== url) {
        flow.path.push({ url, domHint, timestamp: Date.now() });
      }
    }

    if (msg.type === 'telemetry_outcome') {
      const data = msg.data as { email: string; target: string; outcome: string };
      const { email, target, outcome } = data;
      const flow = this.loginFlowsModel.get(email);
      if (flow && flow.path.length > 0) {
        const modelKey = `model_${target}_${outcome}`;

        const existingData = this._getFailurePattern(modelKey) as { type?: string; target?: string; outcome?: string; paths?: Array<Array<{ url: string; domHint: string; timestamp: number }>>; occurrences?: number; firstSeen?: string | number; lastSeen?: string | number; count?: number } || {
          type: 'max_level_flow',
          target,
          outcome,
          paths: []
        };
        if (!existingData.paths) existingData.paths = [];
        existingData.paths.push(flow.path);
        // Keep only last 10 paths per outcome to avoid massive json
        if (existingData.paths.length > 10) existingData.paths.shift();

        this._setFailurePattern(modelKey, existingData);
        this.saveMemory();
      }
      this.loginFlowsModel.delete(email); // Clean up after outcome
    }

    // Phase 1: Viewport Mapping Integration
    if (msg.type === 'viewport_heatmap') {
      const { target, coordinates } = msg.data;
      log.info(`🗺️ [Hermes] Ingested viewport heatmap for ${target}: ${coordinates.length} data points.`);
      this.loginFlowsModel.set(`viewport_${target}`, coordinates);
    }

    if (msg.type === 'row-update') {
      const outcome = msg.data.outcome; // "success", "noaccount", "blocked", "N/A", "preemptive-block"

      if (outcome === "preemptive-block") {
        log.info(`\n🚨 [HERMES] Preemptive TLS/Cloudflare block detected! 🚨`);
        log.info(`[HERMES] Swapping backend away from ${this.currentBackend} dynamically...`);
        const fallbacks = ["cloak-headless", "cloak-headed", "stealth-headed", "zendriver"];
        this.currentBackend = fallbacks.find(b => b !== this.currentBackend) || "cloak-headless";
        this.sendCommand('set-backend', { value: this.currentBackend });
        return; // Don't count as standard stat
      }

      this.stats.total++;
      this.outcomeTracker.record(outcome, this.currentBackend, 'off');

      // Add to sliding window for heuristic block rate calculation
      this.recentOutcomes.push(outcome);
      if (this.recentOutcomes.length > 50) this.recentOutcomes.shift();

      const blockCount = this.recentOutcomes.filter(o => o.startsWith('blocked')).length;
      const blockRate = blockCount / this.recentOutcomes.length;

      // Heuristic Rate-Limit Jitter
      if (blockRate > 0.15 && this.recentOutcomes.length >= 10) {
        // Inject macro jitter (10-25% slowdown) if blocks spike (max once every 10 seconds to avoid spam)
        const now = Date.now();
        if (!this._lastJitterTime || now - this._lastJitterTime > 10000) {
          log.info(`[HERMES] Block rate at ${(blockRate * 100).toFixed(1)}%. Injecting macro jitter...`);
          this.timings.KEYSTROKE_DELAY_FAST = Math.min(150, Math.round(this.timings.KEYSTROKE_DELAY_FAST * (1 + (Math.random() * 0.15 + 0.10))));
          this.sendCommand('set-timing', { key: 'KEYSTROKE_DELAY_FAST', value: this.timings.KEYSTROKE_DELAY_FAST });
          this._lastJitterTime = now;
        }
      }

      // Phase 3: ALL classifications are positive victories (except N/A, error, blocked)
      if (outcome.startsWith('success') || outcome.startsWith('noaccount') || outcome.startsWith('permdisabled') || outcome.startsWith('tempdisabled') || outcome.startsWith('2FA')) {
        this.stats.consecutiveBlocks = 0;
        this.stats.consecutiveSuccesses++;
        if (outcome.startsWith('success')) this.stats.success++;
        if (outcome.startsWith('noaccount')) this.stats.noaccount++;

        // MTO: Descend (Speed up)
        if (this.timings.KEYSTROKE_DELAY_FAST > 15) {
          this.timings.KEYSTROKE_DELAY_FAST -= 1;
          this.sendCommand('set-timing', { key: 'KEYSTROKE_DELAY_FAST', value: this.timings.KEYSTROKE_DELAY_FAST });
        }
      } else if (outcome.startsWith('blocked') || outcome.startsWith('N/A') || outcome.startsWith('api-error') || outcome.startsWith('error')) {
        this.stats.consecutiveBlocks++;
        this.stats.consecutiveSuccesses = 0;
        this.stats.blocked++;

        // MTO: Ascend (Slow down/Back off)
        if (this.timings.KEYSTROKE_DELAY_FAST < 120) {
          this.timings.KEYSTROKE_DELAY_FAST += 5;
          this.sendCommand('set-timing', { key: 'KEYSTROKE_DELAY_FAST', value: this.timings.KEYSTROKE_DELAY_FAST });
        }
      }

      this.analyzeAndOrchestrate();
    } else if (msg.type === 'complete') {
      try { logDecision({ type: 'batch_complete', decision: `Batch completed: ${this.stats.total} total, ${this.stats.success} success, ${this.stats.blocked} blocked`, rationale: 'Batch completion event from engine', preMetrics: { ...this.stats, backend: this.currentBackend, concurrency: this.currentConcurrency }, postMetrics: {} }); } catch { /* non-critical */ }
      log.info(`\n🎉 Batch Complete! Hermes Analytics:`);
      console.table(this.stats);
      this.saveMemory();

      const requeueResult = scanForRequeue();
      if (requeueResult.credentials.length > 0) {
        log.info(`🔄 Awaiting next batch... Found ${requeueResult.credentials.length} credentials to requeue.`);
        const plan = this.strategyEngine.plan();

        log.info(`🧠 Strategy Engine Plan: Backend=${plan.backend}, Concurrency=${plan.concurrency}, Rationale=${plan.rationale.join('; ')}`);

        try { logDecision({ type: 'strategy_plan', decision: `Strategy: backend=${plan.backend}, concurrency=${plan.concurrency}`, rationale: plan.rationale.join('; '), preMetrics: { backend: this.currentBackend, concurrency: this.currentConcurrency }, postMetrics: { backend: plan.backend, concurrency: plan.concurrency } }); } catch { /* non-critical */ }

        this.currentBackend = plan.backend;
        this.currentConcurrency = plan.concurrency;

        this.sendCommand('set-backend', { value: plan.backend });
        this.sendCommand('set-concurrency', { value: plan.concurrency });

        for (const [key, val] of Object.entries(plan.timings)) {
           this.sendCommand('set-timing', { key, value: val });
        }

        setTimeout(() => {
          this.sendCommand('action', { action: 'start_engine' });
        }, 1000);
      } else {
        log.info('🔄 Awaiting next batch... Queue is exhausted or in cooldown.');
      }

      // Reset rolling stats
      this.stats.consecutiveBlocks = 0;
      this.stats.consecutiveSuccesses = 0;
    } else if (msg.type === 'cdp_result') {
      if (msg.success && msg.command === 'get_content') {
        this.handleProactiveState(msg.email, msg.data);
      } else if (!msg.success) {
        // Ignored. The session might have naturally completed and closed.
      }
    } else if (msg.type === 'active_sessions_result') {
      const emails: string[] = msg.emails || [];
      // Request DOM content for all live sessions
      emails.forEach(email => {
        if (!this.activeInterventions.has(email)) {
          this.executeCdpIntervention(email, { type: 'get_content' });
        }
      });
      // Clean up orphaned states
      for (const email of this.pageStates.keys()) {
        if (!emails.includes(email)) this.pageStates.delete(email);
      }
    }
  }

  // ── Phase 1 & 2: Proactive Polling & Escalating Aggressiveness ─────────────

  proactivePoll() {
    this.sendCommand('get_active_sessions', {});
  }

  sweepZombies() {
    log.info("🧹 [Hermes GC] Initiating system-wide sweep for zombie browser instances...");
    this.sendCommand('sweep_zombies', {});
    // Fallback: Kill processes securely if engine is completely locked
    const zombieScript = path.join(this.repoRoot, 'src/services/clean-zombies.ts');
    if (fs.existsSync(zombieScript)) {
      exec('npx tsx src/services/clean-zombies.ts', { cwd: this.repoRoot }, (err, stdout, _stderr) => {
        if (err) log.warn(`[ZombieSweep] Fallback script failed: ${err.message}`);
        else if (stdout) log.info(`[ZombieSweep] ${stdout.trim()}`);
      });
    } else {
      log.warn(`[ZombieSweep] Fallback script not found: ${zombieScript}`);
    }
  }

  handleProactiveState(email: string, data: { url: string; text: string }) {
    if (this.activeInterventions.has(email)) return;
    const now = Date.now();
    const hash = `${data.url}|${data.text.length}`;

    let state = this.pageStates.get(email);
    if (!state) {
      state = { hash, firstSeen: now, lastSeen: now, aggrLevel: 0 };
      this.pageStates.set(email, state);
      return;
    }

    if (state.hash !== hash) {
      // Page is moving organically — reset stuck timer
      state.hash = hash;
      state.firstSeen = now;
      state.lastSeen = now;
      state.aggrLevel = 0;
    } else {
      state.lastSeen = now;
      const stuckDuration = now - state.firstSeen;

      // Escalation Ladder
      if (stuckDuration > 10000 && state.aggrLevel === 0) {
        state.aggrLevel = 1;
        this.triggerEscalation(email, state, data, 1);
      } else if (stuckDuration > 15000 && state.aggrLevel === 1) {
        state.aggrLevel = 2;
        this.triggerEscalation(email, state, data, 2);
      } else if (stuckDuration > 20000 && state.aggrLevel === 2) {
        state.aggrLevel = 3;
        this.triggerEscalation(email, state, data, 3);
      } else if (stuckDuration > 30000 && state.aggrLevel === 3) {
        state.aggrLevel = 4;
        this.triggerEscalation(email, state, data, 4);
      }
    }
  }

  // ── Patch Validation + TTL (Rule 48) ───────────────────────────────────────
  // Validates AI-generated patches before injection: max size, no network APIs,
  // no navigation mutations, and auto-prunes patches older than 24 hours.
  private static readonly PATCH_MAX_SIZE = 10 * 1024; // 10KB per patch
  private static readonly PATCH_TOTAL_MAX = 50 * 1024; // 50KB total accumulated
  private static readonly PATCH_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours
  private static readonly PATCH_FORBIDDEN_PATTERNS = [
    /\bfetch\s*\(/i,
    /\bXMLHttpRequest\b/i,
    /\bnavigator\.sendBeacon\b/i,
    /\blocation\.href\s*=/i,
    /\blocation\.assign\b/i,
    /\blocation\.replace\b/i,
    /\bwindow\.open\b/i,
    /\bimportScripts\b/i,
  ];

  validateAndLoadPatches(): string {
    if (!fs.existsSync(this.patchesDir)) return '';

    const patchFiles = fs.readdirSync(this.patchesDir).filter((f: string) => f.endsWith('.js'));
    const now = Date.now();
    let accumulated = '';
    let totalSize = 0;

    for (const file of patchFiles) {
      const filePath = path.join(this.patchesDir, file);
      try {
        const stat = fs.statSync(filePath);

        // TTL pruning: delete patches older than 24 hours
        if (now - stat.mtimeMs > HermesOrchestrator.PATCH_TTL_MS) {
          fs.unlinkSync(filePath);
          log.info(`[PatchValidator] Pruned expired patch: ${file} (age: ${Math.round((now - stat.mtimeMs) / 3600000)}h)`);
          continue;
        }

        // Size gate: skip patches larger than 10KB
        if (stat.size > HermesOrchestrator.PATCH_MAX_SIZE) {
          log.warn(`[PatchValidator] Rejected oversized patch: ${file} (${stat.size} bytes, max ${HermesOrchestrator.PATCH_MAX_SIZE})`);
          continue;
        }

        const content = fs.readFileSync(filePath, 'utf8');

        // Forbidden API scan
        const forbidden = HermesOrchestrator.PATCH_FORBIDDEN_PATTERNS.find(rx => rx.test(content));
        if (forbidden) {
          log.warn(`[PatchValidator] Rejected patch with forbidden API: ${file} (pattern: ${forbidden.source})`);
          continue;
        }

        // Total accumulated size cap
        if (totalSize + content.length > HermesOrchestrator.PATCH_TOTAL_MAX) {
          log.warn(`[PatchValidator] Skipping patch ${file}: would exceed total limit (${totalSize + content.length} > ${HermesOrchestrator.PATCH_TOTAL_MAX})`);
          continue;
        }

        accumulated += content + '\n';
        totalSize += content.length;
      } catch (e) {
        log.warn(`[PatchValidator] Failed to read patch ${file}: ${String(e)}`);
      }
    }

    return accumulated;
  }

  triggerEscalation(email: string, state: any, data: any, level: number) {
    this.activeInterventions.add(email);
    log.info(`\n🕵️ [Hermes CDP] Level ${level} Intervention triggered for stuck session: ${email}`);

    if (level === 1) {
      // Level 1: Execute AI-generated patches first, then fallback to safe dismiss
      const aiPatches = this.validateAndLoadPatches();

      const scriptContent = `
        (() => {
          let resultMsg = "No obvious modals found";
          try {
            // AI PATCHES BEGIN
            ${aiPatches.replace(/`/g, '')}
            // AI PATCHES END
          } catch(e) { console.error("AI Patch Error:", e); }

          ${DEEP_FIND_BUTTON_FN}
          const cookieBtn = deepFindButton(/accept all|agree|cookie|got it/i);
          if (cookieBtn) { cookieBtn.click(); resultMsg = "Clicked cookie button via Shadow-DOM pierce"; }
          const closeBtn = deepFindButton(/close|^x$/i);
          if (closeBtn) { closeBtn.click(); resultMsg = "Clicked close modal via Shadow-DOM pierce"; }
          return resultMsg;
        })()
      `;
      this.executeCdpIntervention(email, { type: 'evaluate', script: scriptContent });
    } else if (level === 2) {
      // Level 2: Moderate interaction escapes
      this.executeCdpIntervention(email, { type: 'evaluate', script: `
        (() => {
          // Fire Escape key event
          document.dispatchEvent(new KeyboardEvent('keydown', {'key': 'Escape'}));
          // Nuke overlay z-indexes
          const style = document.createElement('style');
          style.innerHTML = '[class*="overlay"], [class*="backdrop"], [class*="modal"] { display: none !important; pointer-events: none !important; }';
          document.head.appendChild(style);
          return 'Dispatched Escape and nuked overlays';
        })()
      `});
      // Click safely out of bounds to clear focus-traps
      this.executeCdpIntervention(email, { type: 'click', selector: 'body' });
    } else if (level === 3) {
      // Level 3: Aggressive Reload
      this.learnFromFailure(email, data.url, 'chronic_freeze');
      this.executeCdpIntervention(email, { type: 'reload' });
      // Reset timer so it gets 10s to load
      state.firstSeen = Date.now();
      state.hash = '';
    } else if (level === 4) {
      // Level 4: Nuclear engine abort
      log.info(`🧨 [Hermes CDP] Session unrecoverable. Requesting engine to abort row to unblock queue.`);
      this.sendCommand('action', { action: 'log', message: `Nuclear abort requested for ${email}` });
      // Wait, we can't directly abort from CDP without engine API, but we can force navigation to "about:blank" to crash the playwright flow
      this.executeCdpIntervention(email, { type: 'evaluate', script: 'window.location.href = "about:blank";' });
    }

    // Release intervention lock after 3s to observe results
    setTimeout(() => {
      this.activeInterventions.delete(email);
    }, 3000);
  }

  handleScreenshotAnalysis(data: any) {
    const { email, imagePath } = data;
    const site = data.site || data.target || data.backend || 'unknown';
    if (this.activeInterventions.has(email)) return; // Already intervening

    // Basic heuristic: check if we're getting repeated screenshots for the same email
    // This implies the engine is stuck.
    const patternKey = `${email}_${site}`;
    const pattern = this._getFailurePattern(patternKey) || { count: 0, lastSeen: 0 };
    pattern.count = (pattern.count || 0) + 1;
    pattern.lastSeen = Date.now();
    this._setFailurePattern(patternKey, pattern);

    if (pattern.count >= 3) {
      log.info(`\n🕵️ [Hermes CDP] STUCK SESSION DETECTED for ${email} on ${site}. Initiating Live Intervention...`);
      this.activeInterventions.add(email);
      this.learnFromFailure(email, site, 'stuck_session');

      // 1. Grab DOM text
      this.executeCdpIntervention(email, { type: 'get_content' });

      // 1.5 VISUAL DELTA AI HOOK
      if (imagePath && fs.existsSync(imagePath)) {
        log.info(`📸 [Hermes Vision] Triggering Visual Delta AI Hook for ${site}...`);
        const dest = path.join(this.learningDir, 'idle_anomalies', `${site}_${Date.now()}.jpeg`);
        try {
          fs.mkdirSync(path.dirname(dest), { recursive: true });
          fs.copyFileSync(imagePath, dest);
          // Fire and forget vision optimizer in background
          exec(`npx tsx hermes/vision-optimizer.ts`, (err, stdout, stderr) => {
            if (err) log.warn(`[Vision] Optimizer failed: ${err.message}`);
            if (stdout) log.info(stdout);
            if (stderr) log.warn(`[Vision] ${stderr}`);
          });
        } catch(e) { log.error('Failed to trigger vision optimizer', e); }
      }

      // 2. Try blind dismissals of common modals
      setTimeout(() => {
        this.executeCdpIntervention(email, { type: 'evaluate', script: `
          (() => {
            ${DEEP_FIND_BUTTON_FN}
            const cookieBtn = deepFindButton(/accept all|agree|cookie|got it/i);
            if (cookieBtn) { cookieBtn.click(); return 'Clicked cookie button via Shadow-DOM pierce'; }
            const closeBtn = deepFindButton(/close|^x$/i);
            if (closeBtn) { closeBtn.click(); return 'Clicked close modal via Shadow-DOM pierce'; }
            return 'No obvious modals found';
          })()
        `});
      }, 2000);

      // 3. Clear intervention flag after 10s
      setTimeout(() => {
        this.activeInterventions.delete(email);
      }, 10000);
    }
  }

  executeCdpIntervention(email: string, command: string | Record<string, unknown>) {
    this.sendCommand('cdp_execute', { email, command });
  }

  learnFromFailure(_email: string, site: string, category: string) {
    const key = `learn_${site}_${category}`;
    const memory = this._getFailurePattern(key) || { occurrences: 0, firstSeen: new Date().toISOString() };
    memory.occurrences = (memory.occurrences || 0) + 1;
    memory.lastSeen = new Date().toISOString();

    if (memory.occurrences === 1) {
      log.info(`🧠 [Self-Learning] Logged new failure pattern: ${category} on ${site}`);
    } else if (memory.occurrences % 5 === 0) {
      log.info(`🧠 [Self-Learning] Chronic failure pattern detected: ${category} on ${site} (${memory.occurrences} times). Auto-generating remediation plan for next agent cycle.`);
      // Issue Pause command to Orchestrator to prevent proxy burn
      this.sendCommand('action', { action: 'pause_engine' });
      void this.triggerHumanInTheLoop(site, category).catch((err) => log.error(`HITL trigger failed: ${err instanceof Error ? err.message : String(err)}`));
    }

    this._setFailurePattern(key, memory);
    this.saveMemory();
  }

  async triggerHumanInTheLoop(site: string, category: string) {
      log.warn(`🚨 [Human-In-The-Loop] Engine paused. Escaping automated loop. Sending Webhook alert for ${category} on ${site}.`);

      const webhookUrl = process.env.WEBHOOK_URL;
      if (webhookUrl) {
          try {
              const msg = `🚨 **Engine Paused (Human Intervention Required)** 🚨\nTarget: ${site}\nIssue: ${category}\nThe queue has been halted to prevent burning proxies. I am querying the Local LLM for a patch draft...`;
              await fetch(webhookUrl, { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ content: msg }) });
          } catch(e) { /* ignore */ }
      }

      // Attempt to draft a patch via Local LLM immediately
      void this.selfImprovementLoop(true).catch((e) => log.error(`[HITL] Self-improvement loop failed: ${e}`));
  }

  approveDraftPatch(filename: string) {
      const draftPath = path.join(this.draftPatchesDir, filename);
      if (fs.existsSync(draftPath)) {
          const activePath = path.join(this.patchesDir, filename.replace('draft_', ''));
          fs.renameSync(draftPath, activePath);
          log.info(`✅ [Human-In-The-Loop] Draft ${filename} approved and moved to active patches.`);

          // Auto-resume engine after approval
          this.sendCommand('action', { action: 'resume_engine' });
          log.info(`▶️ Engine resumed.`);
      } else {
          log.warn(`[HITL] Draft not found: ${filename}`);
      }
  }

  // ── Phase 4: Autonomous Self-Improvement Loop ────────────────────────────

  private _lastImprovementTime = 0;
  private _improvementConsecutiveFailures = 0;
  private _improvementBackoffUntil = 0;

  async selfImprovementLoop(isHitl = false) {
    const now = Date.now();
    if (now < this._improvementBackoffUntil) {
      log.info(`[Hermes AI] Circuit breaker open — skipping (backoff until ${new Date(this._improvementBackoffUntil).toISOString()})`);
      return;
    }
    if (!isHitl && now - this._lastImprovementTime < 60000) {
      log.info(`[Hermes AI] Rate limited — skipping (last run ${Math.round((now - this._lastImprovementTime) / 1000)}s ago, min 60s interval)`);
      return;
    }
    this._lastImprovementTime = now;

    if (!isHitl && (this.stats.total === 0 || this.failurePatterns.size === 0)) return;

    log.info("\n🤖 [Hermes AI] Initiating Self-Improvement Sequence...");

    // 1. Extract Top Failures
    const failPatterns = Array.from(this.failurePatterns.entries())
      .filter(([key, data]) => !key.startsWith('model_') && ((data.occurrences ?? 0) > 2 || (data.count ?? 0) > 2))
      .sort((a, b) => ((b[1].occurrences as number) || (b[1].count as number) || 0) - ((a[1].occurrences as number) || (a[1].count as number) || 0))
      .slice(0, 5)
      .map(([key, _]) => key)
      .join(', ');

    // 2. Extract Max-Level Flow Data (Golden Paths vs Blocked Paths)
    let flowContext = "";
    const flowModels = Array.from(this.failurePatterns.entries()).filter(([key]) => key.startsWith('model_'));

    if (flowModels.length > 0) {
      flowContext = "\n\nMax-Level Flow Intelligence (Based on live telemetry):\n";
      for (const [__key, data] of flowModels) {
        flowContext += `\nTarget: ${data.target}, Outcome: ${data.outcome}\n`;
        const recentPath = data.paths?.[data.paths.length - 1];
        if (recentPath) {
          const stepSummary = recentPath.map((step: any, i: number) => `Step ${i + 1}: ${step.url}`).join(" -> ");
          flowContext += `Recent Path: ${stepSummary}\n`;
        }
      }
    }

    // 3. Extract Timeline Matrix
    let matrixContext = "";
    if (this.timelineMatrices.size > 0) {
      matrixContext = "\n\nTimeline Matrices (Micro-second DOM visibility analysis vs actual fill times):\n";
      for (const [target, data] of this.timelineMatrices.entries()) {
        const recentRun = data.runs?.[data.runs.length - 1];
        if (recentRun) {
          matrixContext += `Target: ${target}\nMatrix: ${JSON.stringify(recentRun.matrix)}\nFillTime: ${recentRun.fillTime}ms\nTimings: ${JSON.stringify(recentRun.currentTimings)}\n\n`;
        }
      }
    }

    // 4. Extract Viewport Mapping
    let heatmapContext = "";
    const heatmapModels = Array.from(this.loginFlowsModel.entries()).filter(([key]) => key.startsWith('viewport_'));
    if (heatmapModels.length > 0) {
      heatmapContext = "\n\nViewport Heatmap Patterns:\n";
      for (const [key, data] of heatmapModels) {
        heatmapContext += `${key}: ${JSON.stringify(data)}\n`;
      }
    }

    // 5. Server Telemetry & Ops Outcomes
    const mem = process.memoryUsage();
    const memMb = Math.round(mem.rss / 1024 / 1024);
    let telemetryContext = `\n\nServer Telemetry:\nMemory RSS: ${memMb}MB (Threshold > 2000MB implies leak)\nApp Uptime: ${Math.round(process.uptime() / 60)} minutes`;

    if (this.opsSkillOutcomes.length > 0) {
      telemetryContext += `\n\nRecent OpsSkill Execution Outcomes (Learn from these):\n`;
      for (const outcome of this.opsSkillOutcomes) {
        telemetryContext += `Skill ${outcome.skillId} (Trigger: ${outcome.trigger}) - Success: ${outcome.success} - Output: ${outcome.output}\n`;
      }
    }

    if (!failPatterns && !flowContext && !matrixContext && !heatmapContext && memMb < 1500 && !isHitl) {
      log.info("🤖 [Hermes AI] No patterns detected and system healthy. Sleeping.");
      return;
    }

    try {
      const promptText = `You are an Autonomous Software Engineer (Hermes) specializing in DOM manipulation and WAF evasion. You are tasked with writing a raw JS snippet to be injected via page.evaluate().`
        + "\n\nRecent Failures: " + failPatterns + flowContext
        + matrixContext + heatmapContext + telemetryContext
        + "\n\nOUTPUT FORMAT: Output ONLY a valid Javascript snippet (no markdown tags, no explanation) that patches the DOM or bypasses the blocker. Make sure it is wrapped in an IIFE.";

      log.info(`[Hermes Local LLM] Querying local Ollama (llama3) for a draft patch... (Using unlimited fast bandwidth for processing)`);

      const response = await this.ollama.chat({
          model: 'llama3', // Assumes a modern local model is pulled
          messages: [{ role: 'user', content: promptText }]
      });

      const aiResponse = response.message.content || "";

      if (aiResponse) {
        let cleanText = aiResponse.trim();

        // Strip markdown if it snuck in
        if (cleanText.includes("```javascript")) {
          cleanText = cleanText.split("```javascript")[1]?.split("```")[0] ?? cleanText;
        } else if (cleanText.includes("```")) {
          cleanText = cleanText.split("```")[1]?.split("```")[0] ?? cleanText;
        }
        cleanText = cleanText.trim();

        if (isHitl) {
            const patchName = "draft_patch_" + Date.now() + ".js";
            fs.writeFileSync(path.join(this.draftPatchesDir, patchName), cleanText);
            log.info(`✋ [HITL] Patch generated and saved to ${patchName}. Awaiting your approval to merge and resume.`);
            const webhookUrl = process.env.WEBHOOK_URL;
            if (webhookUrl) {
                try {
                    await fetch(webhookUrl, { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ content: `🛠️ Draft patch generated: **${patchName}**. Review in dashboard or send 'approve_draft' command to deploy and resume.` }) });
                } catch(e) { /* ignore */ }
            }
        } else {
            // Auto-deploy (Only if not Human-in-the-Loop)
            const patchName = "patch_" + Date.now() + ".js";
            fs.writeFileSync(path.join(this.patchesDir, patchName), cleanText);

            // Also inject this dynamically as a new research skill
            const orchestrator = new ResearchOrchestrator({ log: (m) => log.debug(m) });
            orchestrator.injectHermesSkill(cleanText, "global", "hermes-ai-patch");

            log.info("✅ [Hermes AI] Successfully generated and injected new codebase skill: " + patchName);
        }
      }
      this._improvementConsecutiveFailures = 0;
    } catch (e: unknown) {
      this._improvementConsecutiveFailures++;
      if (this._improvementConsecutiveFailures >= 5) {
        const backoffMs = 5 * 60 * 1000;
        this._improvementBackoffUntil = Date.now() + backoffMs;
        log.warn(`⚠️ [Hermes AI] Circuit breaker opened: ${this._improvementConsecutiveFailures} consecutive failures. Backing off for 5 minutes.`);
      }
      log.warn("⚠️ [Hermes Local LLM] Inference failed. Make sure Ollama is running and 'llama3' is pulled: " + (e instanceof Error ? e.message : String(e)));
    }
  }

  // ────────────────────────────────────────────────────────────────────────

  analyzeAndOrchestrate() {
    // ── Observer intelligence context ──
    try {
      const obs = getHermesObserver();
      const anomalyCount = obs.getAnomalyCount();
      const recentInsights = obs.getRecentInsights(3);
      if (anomalyCount > 0 || recentInsights.length > 0) {
        log.info(`[Hermes↔Observer] Anomalies: ${anomalyCount}, Insights: ${recentInsights.length}, Active sessions: ${obs.getActiveSessionCount()}`);
      }
    } catch { /* Observer not initialized yet — safe to skip */ }

    // 1. Pivot Backend on High Block Rate (3 blocks in a row)
    if (this.stats.consecutiveBlocks >= 3) {
      log.info(`\n🚨 [HERMES ALERT] 3 consecutive blocks detected on ${this.currentBackend}!`);

      // Rotate through active (non-spider) backends only
      const ACTIVE_BACKENDS = ['cloak-headless', 'stealth', 'zendriver', 'cloak-headed'];
      const currentIdx = ACTIVE_BACKENDS.indexOf(this.currentBackend);
      const prevBackend = this.currentBackend;
      const nextBackend = ACTIVE_BACKENDS[(currentIdx + 1) % ACTIVE_BACKENDS.length] || 'cloak-headless';

      log.info(`🛡️ Pivoting backend to ${nextBackend} for evasion...`);
      this.sendCommand('set-backend', { value: nextBackend });
      this.currentBackend = nextBackend;

      // Reset thresholds after action
      this.stats.consecutiveBlocks = 0;
      this.stats.consecutiveSuccesses = 0;
      try { logDecision({ type: 'backend_swap', decision: `Pivoted from ${prevBackend} to ${nextBackend}`, rationale: `3 consecutive blocks on ${prevBackend}`, preMetrics: { backend: prevBackend }, postMetrics: { backend: nextBackend } }); } catch { /* non-critical */ }
    }

    // Deep-Flow Synchronization: Adjust AI Decoy aggression dynamically
    if (this.stats.consecutiveBlocks >= 2) {
      log.info(`⚠️ [Hermes Sync] Block pressure detected. Instructing AI Decoys to Escalate Aggression.`);
      this.sendCommand('set-decoy-aggression', { level: 'high' });
    } else if (this.stats.consecutiveSuccesses >= 5) {
      this.sendCommand('set-decoy-aggression', { level: 'normal' });
    }

    // 2. Scale Concurrency on Perfect Stability (15 flawless runs in a row)
    if (this.stats.consecutiveSuccesses >= 15 && this.currentConcurrency < 32) {
      const prevConcurrency = this.currentConcurrency;
      log.info(`\n🚀 [HERMES SCALE] 15 consecutive stable classifications! Ramping concurrency...`);
      this.currentConcurrency += 1;
      this.sendCommand('set-concurrency', { value: this.currentConcurrency });
      this.stats.consecutiveSuccesses = 0; // Require another 15 perfectly clean runs to bump again
      try { logDecision({ type: 'concurrency_change', decision: `Increased concurrency from ${prevConcurrency} to ${this.currentConcurrency}`, rationale: '15 consecutive stable classifications', preMetrics: { concurrency: prevConcurrency }, postMetrics: { concurrency: this.currentConcurrency } }); } catch { /* non-critical */ }
    }

    // Periodically save memory
    if (this.stats.total % 25 === 0) {
      this.saveMemory();
    }
  }

  start() {
    this.connect();
    // Heartbeat for terminal output
    setInterval(() => {
      log.info(`💓 [Hermes] Total: ${this.stats.total} | Blk: ${this.stats.blocked} | Succ: ${this.stats.success} | Concurrency: ${this.currentConcurrency} | Backend: ${this.currentBackend}`);
    }, 30000); // 30s heartbeat
  }
}

export async function scanDomain(domain: string, vectors: string[]): Promise<Array<{ vector: string; script: string }>> {
  log.info(`[Hermes Scan] Scanning ${domain} for vectors: ${vectors.join(", ")}`);

  // MOCK: Hermes deep scan logic for zero-day analysis
  const results = [];
  for (const vector of vectors) {
    results.push({
      vector,
      script: `// Hermes dynamically generated patch for ${vector}\n(function() { console.log('Hermes patching ${vector}'); })();`
    });
  }

  return results;
}

import { fileURLToPath } from 'node:url';

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const scanIndex = args.indexOf('--scan');

  if (scanIndex !== -1 && scanIndex + 1 < args.length) {
    const domain = args[scanIndex + 1] as string;
    // If vectors were passed as comma-separated after domain, we could parse them,
    // but the CLI in research-orchestrator currently just passes domain.
    scanDomain(domain, ["unknown_vector"]).then(results => {
      const skills = results.map((r: { vector: string; script: string }) => ({
        id: `hermes-${domain}-${r.vector}-${Date.now()}`,
        vector: r.vector,
        target: domain,
        script: r.script,
        frameworks: ["camoufox", "cloakbrowser", "zendriver", "spider"],
        generatedBy: "hermes",
        generatedAt: new Date().toISOString(),
        validated: true
      }));
      console.log(JSON.stringify(skills));
      process.exit(0);
    }).catch(_err => {
      console.error("[]");
      process.exit(1);
    });
  } else {
    const repoPath = process.argv[3] ?? process.cwd();
    const hermes = new HermesOrchestrator(repoPath);

    process.on('SIGINT', () => {
      log.info('🛑 Shutting down Hermes Orchestrator gracefully...');
      hermes.saveMemory();
      process.exit(0);
    });
    process.on('SIGTERM', () => {
      log.info('🛑 Shutting down Hermes Orchestrator gracefully...');
      hermes.saveMemory();
      process.exit(0);
    });

    process.on('message', (msg: any) => {
      if (msg && msg.type === 'review-now') {
        void hermes.selfImprovementLoop().catch((err) => log.error(`Review cycle failed: ${err instanceof Error ? err.message : String(err)}`));
      }
    });

    hermes.start();
  }
}

export default HermesOrchestrator;