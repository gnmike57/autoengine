import fs from "fs";
import { createSession } from "../backends/index.js";
import "dotenv/config";

const PROXY_FILE = "proxy-pool-6.txt";
const JOE_URL = "https://www.joefortune.zone/login";
const CONCURRENCY = 15;
const TIMEOUT_MS = 25000;

async function testProxy(proxyUrl: string): Promise<boolean> {
  console.log(`[VERIFY] Testing proxy: ${proxyUrl.split("@")[1] || proxyUrl}`);
  let handle;
  try {
    const url = new URL(proxyUrl);
    const proxyEntry = {
      server: `${url.protocol}//${url.hostname}:${url.port}`,
      username: decodeURIComponent(url.username),
      password: decodeURIComponent(url.password),
      protocol: url.protocol.replace(':', '')
    };

    handle = await createSession({
      backend: "stealth",
      headless: true,
      email: "proxy-test@test.local",
      proxy: proxyEntry as any,
      proxyPool: "off",
      cleanSession: true,
      recordVideo: false,
      enableCacheInjection: false,
      liveTest: false,
      useHttpCloak: true,
      stealthBypassHttpCloak: true,
    });
  } catch (err: unknown) {
    console.log(`[VERIFY] ❌ Failed to create session for ${proxyUrl.split("@")[1]}: ${err instanceof Error ? err.message : String(err)}`);
    return false;
  }

  const page = handle.page;
  let success = false;
  try {
    await page.goto(JOE_URL, { timeout: TIMEOUT_MS, waitUntil: "domcontentloaded" });
    await page.locator("#username").fill("proxy-test@test.local");
    await page.locator("#password").fill("DummyPassword123!");
    await page.locator("#password").press("Enter");
    
    // Wait for POST response
    await page.waitForResponse(r => r.request().method() === "POST" && r.url().includes("login"), { timeout: 8000 });
    
    // Wait for error message (this confirms POST succeeded and WAF allowed it)
    await page.waitForFunction(() => {
      const body = document.body.innerText.toLowerCase();
      return body.includes("incorrect") || body.includes("invalid") || body.includes("wrong");
    }, { timeout: 8000 });
    success = true;
    console.log(`[VERIFY] ✅ SUCCESS: ${proxyUrl.split("@")[1]} bypassed WAF POST filter.`);
  } catch (err: unknown) {
    console.log(`[VERIFY] ❌ FAIL/TIMEOUT: ${proxyUrl.split("@")[1]} - POST request dropped or timed out.`);
    success = false;
  } finally {
    await handle.close().catch(() => {});
  }
  
  return success;
}

async function main() {
  const proxies = fs.readFileSync(PROXY_FILE, "utf-8")
    .split("\n")
    .map(p => p.trim())
    .filter(p => p.length > 0);
  
  const uniqueProxies = [...new Set(proxies)];
  console.log(`[VERIFY] Loaded ${uniqueProxies.length} unique proxies from ${PROXY_FILE}.`);
  console.log(`[VERIFY] Starting deep POST verification with concurrency ${CONCURRENCY}...`);

  const successfulProxies: string[] = [];
  
  // Simple concurrency queue
  let i = 0;
  const workers = Array.from({ length: CONCURRENCY }, async () => {
    while (i < uniqueProxies.length) {
      const proxy = uniqueProxies[i++]!;
      const ok = await testProxy(proxy);
      if (ok) successfulProxies.push(proxy);
    }
  });
  
  await Promise.all(workers);
  
  console.log(`\n[VERIFY] Complete. ${successfulProxies.length}/${uniqueProxies.length} proxies passed the deep verification.`);
  
  if (successfulProxies.length > 0) {
    fs.writeFileSync(PROXY_FILE, successfulProxies.join("\n") + "\n");
    console.log(`[VERIFY] Overwrote ${PROXY_FILE} with ${successfulProxies.length} working proxies.`);
  } else {
    console.log(`[VERIFY] ⚠ ZERO proxies passed! Did not overwrite file to prevent total pool destruction.`);
  }
  process.exit(0);
}

main().catch(console.error);
