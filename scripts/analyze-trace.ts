import AdmZip from 'adm-zip'; // Easy sync unzipper

async function main() {
  const tracePath = process.argv[2];
  if (!tracePath || !tracePath.endsWith('.zip')) {
    console.error("Usage: npx tsx scripts/analyze-trace.ts path/to/trace.zip");
    process.exit(1);
  }

  const zip = new AdmZip(tracePath);
  const zipEntries = zip.getEntries();
  
  const actionsEntry = zipEntries.find(e => e.entryName === 'trace.actions');
  if (!actionsEntry) {
    console.error("Could not find trace.actions inside the zip file.");
    process.exit(1);
  }

  console.log(`\n=== ⏱ Playwright Trace Timeline Analyzer ===\nFile: ${tracePath}\n`);

  const actionsText = actionsEntry.getData().toString('utf8');
  const lines = actionsText.split('\n').filter(l => l.trim() !== '');

  const events: any[] = [];
  let baseTime = -1;

  for (const line of lines) {
    try {
      const parsed = JSON.parse(line);
      if (parsed.startTime) {
        if (baseTime === -1) baseTime = parsed.startTime;
        events.push(parsed);
      }
    } catch { /* intentional */ }
  }

  // Sort by start time just in case
  events.sort((a, b) => a.startTime - b.startTime);

  let lastEndTime = baseTime;

  for (const ev of events) {
    const startMs = ev.startTime - baseTime;
    const duration = ev.endTime - ev.startTime;
    
    // Calculate idle time between this action and the previous action's end
    const idleBefore = ev.startTime - lastEndTime;
    if (idleBefore > 50) {
      console.log(`\x1b[90m  | (Idle / Sleep for ${idleBefore.toFixed(1)}ms)\x1b[0m`);
    }

    const startSec = (startMs / 1000).toFixed(3);
    const method = ev.metadata?.method || ev.type;
    const target = ev.metadata?.params?.selector || ev.metadata?.params?.url || "";
    
    if (method === 'goto') {
      console.log(`\x1b[34m[${startSec}s]\x1b[0m 🚀 Navigation: ${target} (${duration.toFixed(1)}ms)`);
    } else if (method === 'click') {
      console.log(`\x1b[32m[${startSec}s]\x1b[0m 🖱 Click: ${target} (${duration.toFixed(1)}ms)`);
    } else if (method === 'fill') {
      console.log(`\x1b[33m[${startSec}s]\x1b[0m ⌨ Fill: ${target} = "${ev.metadata?.params?.value}" (${duration.toFixed(1)}ms)`);
    } else if (method === 'waitForSelector') {
      console.log(`\x1b[36m[${startSec}s]\x1b[0m ⏳ Wait for Selector: ${target} (${duration.toFixed(1)}ms)`);
    } else if (method === 'evaluate') {
      console.log(`\x1b[35m[${startSec}s]\x1b[0m 📜 Evaluate Script (${duration.toFixed(1)}ms)`);
    } else if (method === 'waitForFunction') {
      console.log(`\x1b[36m[${startSec}s]\x1b[0m ⏳ Wait for Function (${duration.toFixed(1)}ms)`);
    } else if (method === 'mouse.move') {
      const x = ev.metadata?.params?.x;
      const y = ev.metadata?.params?.y;
      console.log(`\x1b[37m[${startSec}s]\x1b[0m ↖ Mouse Move to (${x}, ${y}) (${duration.toFixed(1)}ms)`);
    } else if (method === 'mouse.down' || method === 'mouse.up') {
      console.log(`\x1b[37m[${startSec}s]\x1b[0m ↖ Mouse ${method.split('.')[1].toUpperCase()} (${duration.toFixed(1)}ms)`);
    } else {
      console.log(`\x1b[90m[${startSec}s]\x1b[0m ⚙ ${method} (${duration.toFixed(1)}ms)`);
    }

    lastEndTime = Math.max(lastEndTime, ev.endTime);
  }

  console.log(`\n============================================`);
  console.log(`Total Elapsed Time: ${((lastEndTime - baseTime) / 1000).toFixed(3)}s`);
}

main().catch(console.error);