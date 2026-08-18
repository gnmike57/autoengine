/**
 * Proxy Target-Site Reachability Test
 * Uses node-fetch + SocksProxyAgent to test each proxy in proxy-pool-6.txt
 * against the actual target sites. Also tests DIRECT as a baseline.
 */
import "dotenv/config";
import fs from "fs";
import path from "path";
import fetch from "node-fetch";
import { SocksProxyAgent } from "socks-proxy-agent";
import { HttpsProxyAgent } from "https-proxy-agent";

const TARGETS = [
  { name: "joe", url: "https://www.joefortune.zone/login" },
  { name: "ignition", url: "https://www.ignitioncasino.ooo/" },
];
const TIMEOUT_MS = 20_000;
const CONCURRENCY = 5;

interface Result {
  proxy: string;
  target: string;
  status: "OK" | "FAIL";
  httpStatus?: number;
  latencyMs: number;
  error?: string;
}

function loadPool6(): string[] {
  const filePath = path.join(process.cwd(), "proxy-pool-6.txt");
  if (!fs.existsSync(filePath)) { console.error("proxy-pool-6.txt not found!"); return []; }
  return fs.readFileSync(filePath, "utf8").split(/\r?\n/).map(l => l.trim()).filter(l => l && !l.startsWith("#"));
}

function makeAgent(proxyUrl: string): any {
  if (proxyUrl.startsWith("socks")) return new SocksProxyAgent(proxyUrl);
  return new HttpsProxyAgent(proxyUrl);
}

async function testOne(proxyUrl: string | null, target: { name: string; url: string }): Promise<Result> {
  const label = proxyUrl || "DIRECT";
  const start = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const opts: any = {
      signal: controller.signal,
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36",
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      },
      redirect: "follow",
    };
    if (proxyUrl) opts.agent = makeAgent(proxyUrl);
    const res = await fetch(target.url, opts);
    clearTimeout(timer);
    return { proxy: label, target: target.name, status: "OK", httpStatus: res.status, latencyMs: Date.now() - start };
  } catch (err: unknown) {
    clearTimeout(timer);
    const msg = ((err instanceof Error ? err.message : String(err)) || String(err)).slice(0, 150);
    return { proxy: label, target: target.name, status: "FAIL", latencyMs: Date.now() - start, error: msg };
  }
}

async function runBatched<T>(items: T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  let idx = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (idx < items.length) { const i = idx++; await fn(items[i]!); }
  });
  await Promise.all(workers);
}

async function main() {
  console.log("══════════════════════════════════════════════════════════════");
  console.log("  PROXY → TARGET-SITE REACHABILITY TEST");
  console.log("══════════════════════════════════════════════════════════════");
  console.log(`Targets: ${TARGETS.map(t => `${t.name} (${t.url})`).join(", ")}`);
  console.log(`Timeout: ${TIMEOUT_MS}ms | Concurrency: ${CONCURRENCY}\n`);

  // 1. DIRECT baseline
  console.log("── DIRECT BASELINE (no proxy) ──────────────────────────────");
  for (const t of TARGETS) {
    const r = await testOne(null, t);
    console.log(`  ${r.status === "OK" ? "✅" : "❌"} ${t.name}: ${r.status} ${r.httpStatus ? `HTTP ${r.httpStatus}` : ""} ${r.latencyMs}ms ${r.error || ""}`);
  }

  // 2. Load proxies
  const proxies = loadPool6();
  console.log(`\n── POOL 6 (Flame Sticky AU): ${proxies.length} proxies ─────────────────`);
  if (proxies.length === 0) { process.exit(1); }

  // 3. Test all proxies
  const allResults: Result[] = [];
  const tasks = proxies.flatMap((p, i) => TARGETS.map(t => ({ proxy: p, target: t, index: i })));

  await runBatched(tasks, CONCURRENCY, async (task) => {
    const r = await testOne(task.proxy, task.target);
    allResults.push(r);
    const icon = r.status === "OK" ? "✅" : "❌";
    const session = task.proxy.match(/session-(\w+)/)?.[1] || task.proxy.slice(-20);
    console.log(`  [${task.index + 1}/${proxies.length}] ${icon} ${r.target.padEnd(9)} ${r.status} ${String(r.httpStatus || "").padEnd(4)} ${String(r.latencyMs).padStart(6)}ms  session=${session} ${r.error || ""}`);
  });

  // 4. Summary
  console.log("\n══════════════════════════════════════════════════════════════");
  console.log("  SUMMARY");
  console.log("══════════════════════════════════════════════════════════════");

  for (const t of TARGETS) {
    const tr = allResults.filter(r => r.target === t.name);
    const ok = tr.filter(r => r.status === "OK");
    const fail = tr.filter(r => r.status === "FAIL");
    const avgLat = ok.length > 0 ? Math.round(ok.reduce((s, r) => s + r.latencyMs, 0) / ok.length) : 0;

    console.log(`\n  ${t.name.toUpperCase()} (${t.url}):`);
    console.log(`    ✅ Reachable: ${ok.length}/${tr.length}`);
    console.log(`    ❌ Blocked:   ${fail.length}/${tr.length}`);
    if (ok.length > 0) console.log(`    ⚡ Avg latency: ${avgLat}ms`);

    if (fail.length > 0) {
      const groups = new Map<string, number>();
      fail.forEach(r => { const k = r.error || "unknown"; groups.set(k, (groups.get(k) || 0) + 1); });
      console.log(`    Failure reasons:`);
      for (const [err, cnt] of [...groups.entries()].sort((a, b) => b[1] - a[1])) {
        console.log(`      ${cnt}x: ${err}`);
      }
    }
  }

  const totalOk = allResults.filter(r => r.status === "OK").length;
  console.log(`\n  OVERALL: ${totalOk}/${allResults.length} passed (${((totalOk / allResults.length) * 100).toFixed(1)}%)`);
  console.log("══════════════════════════════════════════════════════════════");
}

main().then(() => process.exit(0)).catch(e => { console.error("Fatal:", e); process.exit(1); });