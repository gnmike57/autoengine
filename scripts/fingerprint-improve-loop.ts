/**
 * Fingerprint Improvement Loop
 * 
 * Runs an endless self-improving audit cycle:
 * 1. Launches ALL backends concurrently against a dual-SDK audit page
 * 2. Collects fingerprint hashes, signal coherence, and detection vectors
 * 3. Scores each backend and identifies the weakest signals
 * 4. Reports results to the dashboard via WebSocket
 * 5. Loops until all backends reach minimum possible suspect score
 */

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocket } from 'ws';
import { createCloakSession } from '../backends/cloak.js';
import { createStealthSession } from '../backends/stealth.js';
import { createZendriverSession } from '../backends/zendriver.js';
import { createLogger } from '../src/core/logger.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const log = createLogger('fp-loop');

// ── Types ──
interface BackendResult {
  backend: string;
  fpjsHash: string | null;
  thumbmarkHash: string | null;
  signals: Record<string, any>;
  coherence: { coherent: boolean; issues: string[]; score: number };
  error?: string;
  durationMs: number;
}

interface RoundResult {
  round: number;
  timestamp: string;
  backends: BackendResult[];
  bestScore: number;
  worstScore: number;
  avgScore: number;
  uniqueFpjsHashes: number;
  uniqueThumbmarkHashes: number;
  allCoherent: boolean;
}

// ── Audit Server ──
let auditServer: http.Server | null = null;
let auditUrl = '';

async function startAuditServer(): Promise<string> {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      if (req.url === '/' || req.url === '/index.html') {
        const html = fs.readFileSync(path.join(__dirname, '../tests/dual-sdk-audit.html'), 'utf-8');
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(html);
      } else if (req.url === '/thumbmark.mjs') {
        try {
          const js = fs.readFileSync(path.join(__dirname, '../node_modules/@thumbmarkjs/thumbmarkjs/dist/thumbmark.esm.js'), 'utf-8');
          res.writeHead(200, { 'Content-Type': 'application/javascript' });
          res.end(js);
        } catch {
          res.writeHead(404); res.end('ThumbmarkJS not found');
        }
      } else {
        res.writeHead(404); res.end();
      }
    });
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address() as any;
      auditUrl = `http://127.0.0.1:${addr.port}`;
      auditServer = server;
      resolve(auditUrl);
    });
  });
}

// ── Backend Configs ──
const BACKEND_CONFIGS: Array<{ name: string, fn: any, osProfile: any, useHttpCloak?: boolean, headed?: boolean }> = [
  { name: 'stealth', fn: createStealthSession, osProfile: 'windows' as const },
  { name: 'stealth-httpcloak', fn: createStealthSession, osProfile: 'windows' as const, useHttpCloak: true },
  { name: 'cloak-headless', fn: createCloakSession, osProfile: 'windows' as const },
  { name: 'cloak-headless-nocloak', fn: createCloakSession, osProfile: 'windows' as const, useHttpCloak: false },
  { name: 'cloak-headed', fn: createCloakSession, osProfile: 'windows' as const, headed: true },
  { name: 'cloak-headed-nocloak', fn: createCloakSession, osProfile: 'windows' as const, useHttpCloak: false, headed: true },
  { name: 'zendriver', fn: createZendriverSession, osProfile: 'macos' as const },
  { name: 'zendriver-headed', fn: createZendriverSession, osProfile: 'macos' as const, headed: true },
  { name: 'stealth-headed', fn: createStealthSession, osProfile: 'windows' as const, headed: true },
];

// ── Run Single Backend ──
async function runBackendAudit(config: typeof BACKEND_CONFIGS[0], index: number, url: string): Promise<BackendResult> {
  const startTime = Date.now();
  const email = `audit_loop_${config.name}_${index}@example.com`;

  let session: any;
  try {
    session = await config.fn({
      email,
      liveTest: false,
      osProfile: config.osProfile,
      headless: config.headed ? false : true,
      useHttpCloak: config.useHttpCloak,
    } as any);
  } catch (e: unknown) {
    return {
      backend: config.name,
      fpjsHash: null, thumbmarkHash: null,
      signals: {}, coherence: { coherent: false, issues: ['Launch failed: ' + (e instanceof Error ? e.message : String(e))], score: 99 },
      error: `Launch failed: ${e instanceof Error ? e.message : String(e)}`,
      durationMs: Date.now() - startTime
    };
  }

  try {
    const page = session.page;
    await page.goto(url, { waitUntil: 'networkidle', timeout: 45000 });

    // Wait for coherence data (set before SDK loads)
    await page.waitForFunction(
      () => (window as any).__auditResult?.coherence?.issues !== undefined,
      { timeout: 15000 }
    ).catch(() => {});

    // Give SDKs a chance to load (FingerprintJS or ThumbmarkJS)
    await page.waitForFunction(
      () => (window as any).__auditResult?.fpjs?.hash || (window as any).__auditResult?.fpjs?.error,
      { timeout: 20000 }
    ).catch(() => {});

    // Extra wait for ThumbmarkJS
    await page.waitForFunction(
      () => (window as any).__auditResult?.thumbmark?.hash || (window as any).__auditResult?.thumbmark?.error,
      { timeout: 10000 }
    ).catch(() => {});

    // Read the full audit result
    const result = await page.evaluate(() => (window as any).__auditResult);

    await session.close();

    return {
      backend: config.name,
      fpjsHash: result?.fpjs?.hash || null,
      thumbmarkHash: result?.thumbmark?.hash || null,
      signals: result?.signals || {},
      coherence: result?.coherence || { coherent: false, issues: ['No coherence data'], score: 99 },
      durationMs: Date.now() - startTime
    };
  } catch (e: unknown) {
    await session.close().catch(() => {});
    return {
      backend: config.name,
      fpjsHash: null, thumbmarkHash: null,
      signals: {}, coherence: { coherent: false, issues: [(e instanceof Error ? e.message : String(e))], score: 99 },
      error: (e instanceof Error ? e.message : String(e)),
      durationMs: Date.now() - startTime
    };
  }
}

// ── Dashboard WebSocket ──
let ws: WebSocket | null = null;

function connectDashboard() {
  try {
    const port = (() => {
      try {
        const envContent = fs.readFileSync(path.join(process.cwd(), '.env'), 'utf8');
        const m = envContent.match(/^PORT=(\d+)/m);
        if (m) return m[1];
      } catch { /* fallback */ }
      return process.env.PORT || '9223';
    })();
    ws = new WebSocket(`ws://localhost:${port}`);
    ws.on('open', () => log.info('Connected to dashboard'));
    ws.on('close', () => { ws = null; });
    ws.on('error', () => { ws = null; });
  } catch { ws = null; }
}

function broadcastAudit(data: any) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: 'fp-audit-update', data }));
  }
}

// ── Score Calculation ──
function calculateBackendScore(result: BackendResult): number {
  let score = 0;

  // Coherence issues (each issue = +3 points)
  score += (result.coherence?.issues?.length || 0) * 3;

  // Automation traces (critical)
  if (result.signals.webdriver === true) score += 15;
  if (result.signals.playwrightTrace) score += 10;
  if (result.signals.seleniumTrace) score += 10;
  if (result.signals.cdcTrace) score += 8;

  // Missing Chrome object (suspicious for Chrome UA)
  if (result.signals.userAgent?.includes('Chrome') && !result.signals.chromeObj) score += 5;

  // Timezone issues
  if (result.signals.timezone && result.signals.timezoneOffset !== undefined) {
    const tz = result.signals.timezone;
    const offset = result.signals.timezoneOffset;
    if (tz.startsWith('Australia/') && offset > 0) score += 8;
    if (tz.startsWith('America/') && offset < 0) score += 8;
  }

  // Screen coherence
  if (result.signals.screen) {
    if (result.signals.screen.availHeight > result.signals.screen.height) score += 3;
    if (result.signals.screen.colorDepth !== result.signals.screen.pixelDepth) score += 2;
  }

  // DevTools detection
  if (result.signals.outerWidth && result.signals.innerWidth) {
    const diff = result.signals.outerWidth - result.signals.innerWidth;
    if (diff < 0 || diff > 200) score += 5;
  }

  // Plugin count (zero plugins is suspicious)
  if (result.signals.pluginCount === 0) score += 3;

  // WebGL issues
  if (result.signals.webgl?.renderer?.toLowerCase()?.includes('swiftshader')) score += 10;
  if (result.signals.webgl?.renderer?.toLowerCase()?.includes('virtual')) score += 8;

  // Bonus: SDK hash produced = good sign
  if (!result.fpjsHash) score += 5;
  if (!result.thumbmarkHash) score += 3;

  return score;
}

// ── Main Loop ──
async function runImprovementLoop() {
  const url = await startAuditServer();
  log.info(`\n${'═'.repeat(60)}`);
  log.info(`  🔬 FINGERPRINT IMPROVEMENT LOOP`);
  log.info(`  Audit server: ${url}`);
  log.info(`  Backends: ${BACKEND_CONFIGS.map(b => b.name).join(', ')}`);
  log.info(`${'═'.repeat(60)}\n`);

  connectDashboard();

  const history: RoundResult[] = [];
  let round = 0;
  let consecutiveNoImprovement = 0;
  let bestOverallScore = Infinity;

  while (true) {
    round++;
    log.info(`\n${'─'.repeat(60)}`);
    log.info(`  📋 ROUND ${round}`);
    log.info(`${'─'.repeat(60)}`);

    // Run ALL backends concurrently
    const promises = BACKEND_CONFIGS.map((config, i) =>
      runBackendAudit(config, round * 100 + i, url)
    );

    const results = await Promise.all(promises);

    // Calculate scores
    const scored = results.map(r => ({
      ...r,
      internalScore: calculateBackendScore(r)
    }));

    // Aggregate
    const fpjsHashes = new Set(scored.filter(r => r.fpjsHash).map(r => r.fpjsHash));
    const tmHashes = new Set(scored.filter(r => r.thumbmarkHash).map(r => r.thumbmarkHash));
    const scores = scored.map(r => r.internalScore);
    const bestScore = Math.min(...scores);
    const worstScore = Math.max(...scores);
    const avgScore = Math.round(scores.reduce((a, b) => a + b, 0) / scores.length);

    const roundResult: RoundResult = {
      round,
      timestamp: new Date().toISOString(),
      backends: scored,
      bestScore,
      worstScore,
      avgScore,
      uniqueFpjsHashes: fpjsHashes.size,
      uniqueThumbmarkHashes: tmHashes.size,
      allCoherent: scored.every(r => r.coherence?.coherent)
    };

    history.push(roundResult);

    // Print results
    log.info(`\n  ┌─────────────────────────────┬────────┬──────────┬───────────┐`);
    log.info(`  │ Backend                     │ Score  │ FPJS     │ Coherent  │`);
    log.info(`  ├─────────────────────────────┼────────┼──────────┼───────────┤`);
    for (const r of scored) {
      const name = r.backend.padEnd(27);
      const score = String(r.internalScore).padStart(4);
      const fpjs = (r.fpjsHash?.substring(0, 8) || 'FAIL').padEnd(8);
      const coh = r.coherence?.coherent ? '✅ YES' : `❌ ${r.coherence?.issues?.length || '?'}`;
      log.info(`  │ ${name} │ ${score}   │ ${fpjs} │ ${coh.padEnd(9)} │`);
    }
    log.info(`  └─────────────────────────────┴────────┴──────────┴───────────┘`);
    log.info(`\n  📊 Best: ${bestScore} | Worst: ${worstScore} | Avg: ${avgScore}`);
    log.info(`  🔑 Unique FPJS: ${fpjsHashes.size} | Unique TM: ${tmHashes.size}`);

    // List issues per backend
    for (const r of scored) {
      if (r.coherence?.issues?.length > 0) {
        log.info(`\n  ⚠️  ${r.backend} issues:`);
        for (const issue of r.coherence.issues) {
          log.info(`     • ${issue}`);
        }
      }
    }

    // Broadcast to dashboard
    broadcastAudit({
      round,
      scored: scored.map(s => ({
        backend: s.backend,
        score: s.internalScore,
        fpjsHash: s.fpjsHash?.substring(0, 12),
        thumbmarkHash: s.thumbmarkHash?.substring(0, 12),
        coherent: s.coherence?.coherent,
        issues: s.coherence?.issues || [],
        durationMs: s.durationMs,
        key_signals: {
          webdriver: s.signals.webdriver,
          timezone: s.signals.timezone,
          platform: s.signals.platform,
          webglRenderer: s.signals.webgl?.renderer?.substring(0, 40),
          pluginCount: s.signals.pluginCount,
        }
      })),
      bestScore,
      worstScore,
      avgScore,
      uniqueHashes: { fpjs: fpjsHashes.size, thumbmark: tmHashes.size },
      allCoherent: roundResult.allCoherent,
      historyScores: history.map(h => ({ round: h.round, best: h.bestScore, avg: h.avgScore, worst: h.worstScore })),
    });

    // Save round results to file
    const resultsFile = path.join(__dirname, '..', `audit-results-round-${round}.json`);
    fs.writeFileSync(resultsFile, JSON.stringify(roundResult, null, 2));

    // Check improvement
    if (avgScore < bestOverallScore) {
      bestOverallScore = avgScore;
      consecutiveNoImprovement = 0;
      log.info(`\n  🎯 NEW BEST avg score: ${avgScore} (improved!)`);
    } else {
      consecutiveNoImprovement++;
      log.info(`\n  📈 No improvement (${consecutiveNoImprovement} rounds flat). Best avg: ${bestOverallScore}`);
    }

    // Check convergence — if all backends score 0 or plateau for 5 rounds, we're done
    if (bestScore === 0 && worstScore === 0) {
      log.info(`\n  🏆 PERFECT SCORE ACHIEVED! All backends at 0.`);
      break;
    }

    if (consecutiveNoImprovement >= 10) {
      log.info(`\n  🛑 Plateau reached after ${round} rounds. Best avg: ${bestOverallScore}`);
      log.info(`  Final scores: ${scored.map(s => `${s.backend}=${s.internalScore}`).join(', ')}`);
      break;
    }

    // Brief cooldown between rounds
    log.info(`\n  ⏳ Cooldown 5s before next round...`);
    await new Promise(r => setTimeout(r, 5000));
  }

  // ── Final Summary ──
  log.info(`\n${'═'.repeat(60)}`);
  log.info(`  📊 FINAL IMPROVEMENT REPORT`);
  log.info(`${'═'.repeat(60)}`);
  log.info(`  Total rounds: ${round}`);
  log.info(`  Best average score achieved: ${bestOverallScore}`);

  if (history.length > 1) {
    const first = history[0]!;
    const last = history[history.length - 1]!;
    log.info(`  First round avg: ${first.avgScore} → Last round avg: ${last.avgScore}`);
    log.info(`  Improvement: ${first.avgScore - last.avgScore} points`);
  }

  // Save complete history
  const historyFile = path.join(__dirname, '..', 'audit-history.json');
  fs.writeFileSync(historyFile, JSON.stringify(history, null, 2));
  log.info(`\n  📁 Full history saved to audit-history.json`);

  broadcastAudit({
    type: 'complete',
    totalRounds: round,
    bestAvg: bestOverallScore,
    history: history.map(h => ({ round: h.round, best: h.bestScore, avg: h.avgScore, worst: h.worstScore })),
  });

  // Cleanup
  if (auditServer) auditServer.close();
  process.exit(0);
}

runImprovementLoop().catch((e) => {
  log.error(`Fatal: ${e instanceof Error ? e.message : String(e)}`);
  if (auditServer) auditServer.close();
  process.exit(1);
});