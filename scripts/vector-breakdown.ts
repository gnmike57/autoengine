// Single quick test to get detailed per-vector scoring breakdown
import { createSession, type SessionOpts } from '../backends/index.js';
import * as http from 'http';
import * as fs from 'fs';
import * as path from 'path';

async function main() {
  // Start audit server  
  const auditHtml = fs.readFileSync(path.join(import.meta.dirname, '../tests/dual-sdk-audit.html'), 'utf-8');
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(auditHtml);
  });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as any).port;
  const url = `http://127.0.0.1:${port}`;
  
  console.log(`Audit server on ${url}`);
  
  const opts: SessionOpts = { backend: 'cloak-headless', headless: true, proxyPool: 'none' };
  const session = await createSession(opts);
  
  try {
    await session.page.goto(url, { waitUntil: 'networkidle', timeout: 30000 });
    
    // Wait for audit to complete
    await session.page.waitForFunction(() => (window as any).__AUDIT_DONE === true, { timeout: 30000 });
    
    const result = await session.page.evaluate(() => (window as any).__AUDIT_RESULT);
    
    console.log('\n=== PER-VECTOR BREAKDOWN ===');
    let total = 0;
    for (const [name, data] of Object.entries(result.vectors) as any) {
      const pts = data.passed ? 0 : (data.weight || 1) * 3;
      total += pts;
      const status = data.passed ? '✅' : `❌ +${pts}`;
      console.log(`${status}  ${name.padEnd(25)} w=${data.weight}  ${data.detail}`);
    }
    console.log(`\n=== COHERENCE ===`);
    if (result.coherence?.issues?.length) {
      for (const issue of result.coherence.issues) {
        console.log(`⚠️  +3  ${issue}`);
        total += 3;
      }
    } else {
      console.log('✅ All coherent');
    }
    console.log(`\nTOTAL SUSPECT SCORE: ${total}`);
    console.log(`\nmaxTouchPoints: ${result.scrapflyVectors?.hardware?.maxTouchPoints}`);
    console.log(`pluginCount from keySignals: ${result.keySignals?.pluginCount}`);
  } finally {
    await session.close().catch(() => {});
    server.close();
  }
}

main().catch(e => { console.error(e); process.exit(1); });
