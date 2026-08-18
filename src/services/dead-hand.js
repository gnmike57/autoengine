const { execSync } = require('child_process');

const parentPid = parseInt(process.argv[2], 10);
if (!parentPid || isNaN(parentPid)) {
  console.error('[DeadHand] Invalid parent PID.');
  process.exit(1);
}

console.log(`[DeadHand] Monitoring parent PID ${parentPid} for ungraceful exits...`);

setInterval(() => {
  try {
    // process.kill(pid, 0) throws if the process does not exist.
    process.kill(parentPid, 0);
  } catch (e) {
    console.log(`[DeadHand] Parent Node process ${parentPid} died. Initiating mass cleanup...`);
    // Kill ALL browser backend processes — chrome, camoufox (Firefox-based), CloakBrowser
    const targets = process.platform === 'win32'
      ? [
          'taskkill /F /IM chrome.exe /T',
          'taskkill /F /IM camoufox.exe /T',
          'taskkill /F /IM CloakBrowser.exe /T',
        ]
      : [
          'pkill -9 -f chrome',
          'pkill -9 -f camoufox',
          'pkill -9 -f CloakBrowser',
        ];
    for (const cmd of targets) {
      try { execSync(cmd, { stdio: 'ignore' }); } catch { /* no processes found */ }
    }
    console.log(`[DeadHand] Cleanup complete. Exiting.`);
    process.exit(0);
  }
}, 5000);
