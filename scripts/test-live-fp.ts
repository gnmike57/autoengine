import { createSession } from "../backends/index.js";

const BACKENDS = ["cloak-headless", "stealth", "zendriver"];
const TARGET_URL = "https://demo.fingerprint.com/playground";

async function testBackend(backend: string) {
  console.log(`[${backend}] Spawning session...`);
  const startTime = Date.now();
  let session;
  try {
    session = await createSession({
      backend: backend as any,
      headless: true,
    });
    const page = session.page;
    console.log(`[${backend}] Navigating to ${TARGET_URL}...`);
    
    await page.goto(TARGET_URL, { waitUntil: "domcontentloaded", timeout: 30000 });
    
    // Wait for suspect score to render
    await page.waitForFunction(
      () => (document.body.innerText || '').match(/suspect\s*score/i),
      { timeout: 15000 }
    ).catch(() => {});

    const allText: string = await page.evaluate("document.body.innerText || ''");
    const match = allText.match(/Suspect Score[:\s]*(\d+)/i) || allText.match(/suspect_score:\s*(\d+)/i);
    const score = match ? match[1] : "Passed / Clean (0)";

    console.log(`[${backend}] ✅ Test complete in ${((Date.now() - startTime) / 1000).toFixed(2)}s | Suspect Score: ${score}`);
    return { backend, score, duration: Date.now() - startTime, status: "SUCCESS" };
  } catch (err: any) {
    console.error(`[${backend}] ❌ Failed: ${err.message}`);
    return { backend, error: err.message, status: "FAILED" };
  } finally {
    if (session) {
      await session.close().catch(() => {});
    }
  }
}

async function main() {
  console.log("======================================================");
  console.log("🚀 CONCURRENT BACKENDS LIVE TEST: demo.fingerprint.com");
  console.log("======================================================\n");

  const results = await Promise.all(BACKENDS.map(b => testBackend(b)));

  console.log("\n======================================================");
  console.log("📊 LIVE FINGERPRINT TEST RESULTS SUMMARY");
  console.log("======================================================");
  results.forEach(r => {
    if (r.status === "SUCCESS") {
      console.log(`  • ${r.backend.padEnd(16)}: Suspect Score = ${r.score} (Time: ${((r.duration || 0)/1000).toFixed(2)}s)`);
    } else {
      console.log(`  • ${r.backend.padEnd(16)}: FAILED (${r.error})`);
    }
  });
  console.log("======================================================\n");
}

main().catch(console.error);
