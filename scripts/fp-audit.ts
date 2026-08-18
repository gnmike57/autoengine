/**
 * Consolidated FP Audit Tool (Phase 4b)
 * 
 * Tests backends across dimensions:
 * 1. Network: Direct vs Proxy-Routed
 * 2. Fingerprint Strategies
 * 3. 26-vector dual SDK matrix (local)
 * 4. demo.fingerprint.com (Live Score)
 * 5. bot.sannysoft.com (Bot detection)
 */

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createSession, type SessionOpts } from '../backends/index.js';
import { createLogger } from '../src/core/logger.js';
import { ConfigStore } from '../src/core/config-store.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const log = createLogger('fp-audit');
const appConfig = ConfigStore.load();

// Prevent Playwright internal crashes from killing the audit
process.on('uncaughtException', (err) => {
  log.warn(`[Uncaught Exception] ${err.message || String(err)}`);
});
process.on('unhandledRejection', (reason) => {
  log.warn(`[Unhandled Rejection] ${reason instanceof Error ? reason.message : String(reason)}`);
});

// CLI flags
const MOBILE_MODE = process.argv.includes('--mobile');

// Backends to audit
const ALL_BACKENDS: Array<{ name: string; opts: Partial<SessionOpts> }> = [
  { name: 'cloak-headless', opts: { backend: 'cloak-headless', headless: true } },
  { name: 'stealth', opts: { backend: 'stealth', headless: true } },
  { name: 'zendriver', opts: { backend: 'zendriver', headless: true } },
];

const targetBackend = process.argv[2];
const BACKENDS = targetBackend && !targetBackend.startsWith('--')
  ? ALL_BACKENDS.filter(b => b.name === targetBackend)
  : ALL_BACKENDS;

const FP_STRATEGIES = [
  { name: 'optimal', label: 'Optimal (auto per backend)' },
  { name: 'native-only', label: 'Native Only (zero JS)' },
  { name: 'full-stealth', label: 'Full Stealth (max JS)' },
];

const MODES = [
  { name: 'direct', useProxy: false },
  { name: 'proxy-routed', useProxy: true },
];

// ── Audit Server (Local dual-SDK) ──
let auditServer: http.Server | null = null;
async function startAuditServer(): Promise<string> {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      if (req.url === '/' || req.url === '/index.html') {
        const html = fs.readFileSync(path.join(__dirname, '../tests/dual-sdk-audit.html'), 'utf-8');
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(html);
      } else if (req.url === '/fp.js') {
        try {
          const js = fs.readFileSync(path.join(__dirname, '../node_modules/@fingerprintjs/fingerprintjs/dist/fp.min.js'), 'utf-8');
          res.writeHead(200, { 'Content-Type': 'application/javascript' });
          res.end(js);
        } catch { res.writeHead(404); res.end(); }
      } else if (req.url === '/thumbmark.js' || req.url === '/thumbmark.mjs') {
        try {
          const js = fs.readFileSync(path.join(__dirname, '../node_modules/@thumbmarkjs/thumbmarkjs/dist/thumbmark.umd.js'), 'utf-8');
          res.writeHead(200, { 'Content-Type': 'application/javascript' });
          res.end(js);
        } catch { res.writeHead(404); res.end(); }
      } else {
        res.writeHead(404); res.end();
      }
    });
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address() as any;
      auditServer = server;
      resolve(`http://127.0.0.1:${addr.port}`);
    });
  });
}

// ── SannySoft Evaluator ──
async function runSannySoftTest(page: any): Promise<{ pass: boolean; failedTests: string[] }> {
  try {
    await page.goto("https://bot.sannysoft.com/", { waitUntil: "networkidle", timeout: 30000 });
    await new Promise((r) => setTimeout(r, 2000));
    
    const results = await page.evaluate(() => {
      const rows = document.querySelectorAll("table tr");
      const failed: string[] = [];
      rows.forEach(row => {
        const cells = row.querySelectorAll("td");
        if (cells.length >= 2) {
          const test = cells[0]?.textContent?.trim() || "";
          const result = cells[1]?.textContent?.trim() || "";
          const cls = cells[1]?.className || "";
          if (cls.includes("failed")) failed.push(`${test}: ${result}`);
        }
      });
      return failed;
    }).catch(() => ['Extraction Failed']);
    
    return { pass: results.length === 0, failedTests: results };
  } catch (e: any) {
    return { pass: false, failedTests: [e.message] };
  }
}

interface AuditResult {
  backend: string;
  mode: string;
  strategy: string;
  localScore: number;
  fpComScore: number | null;
  sannySoftPass: boolean;
  issues: string[];
  durationMs: number;
  profileDrift: string[];
}

async function runCell(backendDef: any, mode: any, strategy: string, auditUrl: string): Promise<AuditResult> {
  const startTime = Date.now();
  const cellName = `${backendDef.name} × ${mode.name} × ${strategy}`;
  
  if (mode.useProxy) {
    const poolPath = path.join(process.cwd(), `proxy-pool-${appConfig.proxyPool || 'default'}.txt`);
    if (!fs.existsSync(poolPath)) {
      return {
        backend: backendDef.name, mode: mode.name, strategy,
        localScore: -1, fpComScore: -1, sannySoftPass: false,
        issues: ['SKIPPED: No proxy pool configured (file missing)'],
        durationMs: 0, profileDrift: []
      };
    }
  }

  // Enforce env for direct mode
  if (!mode.useProxy) {
    process.env.EXTERNAL_PROXY_POOL = 'none';
    process.env.PRIMARY_PROXY_URL = '';
  } else {
    delete process.env.EXTERNAL_PROXY_POOL;
    delete process.env.PRIMARY_PROXY_URL;
  }

  let session: any;
  let profileDrift: string[] = [];

  try {
    session = await createSession({
      ...backendDef.opts,
      email: `audit_${Date.now()}@example.com`,
      liveTest: false,
      spiderRecoveryBypassBurnedSeed: true, // Non-advancing phase 4a
      osProfile: MOBILE_MODE ? 'android' : 'windows',
      proxyPool: mode.useProxy ? 'default' : 'none',
      fpStrategy: strategy,
      emulateMobile: MOBILE_MODE,
    });
  } catch (e: any) {
    return {
      backend: backendDef.name, mode: mode.name, strategy,
      localScore: 99, fpComScore: null, sannySoftPass: false,
      issues: [`Launch Failed: ${e.message}`],
      durationMs: Date.now() - startTime,
      profileDrift
    };
  }

  const issues: string[] = [];
  let localScore = 99;
  let fpComScore: number | null = null;
  let sannySoftPass = false;

  try {
    const page = session.page;
    page.on("pageerror", (err: any) => log.warn(`[Page Error] ${err}`));
    page.on("requestfailed", (req: any) => log.warn(`[Request Failed] ${req.url()} - ${req.failure()?.errorText}`));

    // 1. Local dual-SDK matrix
    await page.goto(auditUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForFunction(
      () => (window as any).__auditResult?.suspectScore !== undefined,
      { timeout: 15000 }
    ).catch(() => {});
    
    const result = await page.evaluate(() => (window as any).__auditResult);
    localScore = result?.suspectScore ?? 99;
    
    if (result?.coherence?.issues?.length) {
      issues.push(...result.coherence.issues);
    }

    // Capture metadata drift (AI Profile vs actual)
    // We assume checkAiFingerprint validated the payload correctly, but here we can flag if session metadata failed to attach
    if (result?.scrapflyVectors) {
      const hw = result.scrapflyVectors.hardware;
      if (hw?.platform && hw.platform.toLowerCase().includes('mac') && !MOBILE_MODE) {
        // Just an example check
        // Real drift is complex to compute here without full profile context
      }
    }

    // 2. demo.fingerprint.com
    try {
      await page.goto("https://demo.fingerprint.com/playground", { waitUntil: "domcontentloaded", timeout: 20000 });
      await page.waitForFunction(
        () => (document.body.innerText || '').match(/suspect\s*score/i),
        { timeout: 10000 }
      ).catch(() => {});
      const allText: string = await page.evaluate("document.body.innerText || ''");
      const match = allText.match(/Suspect Score[:\s]*(\d+)/i) || allText.match(/suspect_score:\s*(\d+)/i);
      if (match?.[1]) fpComScore = parseInt(match[1]);
    } catch (e) {
      issues.push("FP.com timeout");
    }

    // 3. SannySoft
    const sanny = await runSannySoftTest(page);
    sannySoftPass = sanny.pass;
    if (!sanny.pass) {
      issues.push(`SannySoft Failed: ${sanny.failedTests.join(', ')}`);
    }

  } catch (e: any) {
    issues.push(`Test Error: ${e.message}`);
  } finally {
    await session.close().catch(() => {});
  }

  return {
    backend: backendDef.name, mode: mode.name, strategy,
    localScore, fpComScore, sannySoftPass,
    issues, durationMs: Date.now() - startTime, profileDrift
  };
}

async function main() {
  const auditUrl = await startAuditServer();
  console.log(`\n======================================================`);
  console.log(` 🔬 CONSOLIDATED FP AUDIT RUNNER`);
  console.log(`======================================================`);
  console.log(` Audit server : ${auditUrl}`);
  console.log(` Mobile Mode  : ${MOBILE_MODE ? '✅ ON' : '❌ OFF'}`);
  console.log(`======================================================\n`);

  const results: AuditResult[] = [];

  for (const backend of BACKENDS) {
    for (const mode of MODES) {
      console.log(`\n🖥️  Testing: ${backend.name} | Mode: ${mode.name.toUpperCase()}`);
      
      // Parallelize Chromium backends, sequential for Stealth
      if (backend.name.startsWith('stealth')) {
        for (const strategy of FP_STRATEGIES) {
          const res = await runCell(backend, mode, strategy.name, auditUrl);
          results.push(res);
          console.log(`   -> [${strategy.name}] Local: ${res.localScore}, Live: ${res.fpComScore ?? 'N/A'}, Sanny: ${res.sannySoftPass ? '✅' : '❌'} (${res.issues.length} issues)`);
        }
      } else {
        const promises = FP_STRATEGIES.map(s => runCell(backend, mode, s.name, auditUrl));
        const batch = await Promise.all(promises);
        results.push(...batch);
        for (const res of batch) {
          console.log(`   -> [${res.strategy}] Local: ${res.localScore}, Live: ${res.fpComScore ?? 'N/A'}, Sanny: ${res.sannySoftPass ? '✅' : '❌'} (${res.issues.length} issues)`);
        }
      }
    }
  }

  // Print final matrix
  console.log(`\n======================================================`);
  console.log(` 📊 FINAL UNIFIED AUDIT MATRIX`);
  console.log(`======================================================`);
  console.table(results.map(r => ({
    Backend: r.backend,
    Mode: r.mode,
    Strategy: r.strategy,
    'Local Score': r.localScore,
    'Live Score': r.fpComScore ?? 'N/A',
    'SannySoft': r.sannySoftPass ? 'PASS' : 'FAIL',
    'Issues': r.issues.length > 0 ? r.issues[0] + (r.issues.length > 1 ? '...' : '') : 'None'
  })));

  const reportPath = path.join(process.cwd(), 'fp-audit-report.json');
  fs.writeFileSync(reportPath, JSON.stringify(results, null, 2));
  console.log(`\n📁 Full report saved to: ${reportPath}`);

  if (auditServer) auditServer.close();
  process.exit(0);
}

main().catch(e => {
  console.error(e);
  if (auditServer) auditServer.close();
  process.exit(1);
});
