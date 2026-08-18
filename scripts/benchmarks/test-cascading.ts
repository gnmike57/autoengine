import "dotenv/config";
import { createSession } from "./backends/index.js";
import { globalTiler } from "./browser-tiler.js";
import { ConfigStore } from "./config-store.js";
import { execSync } from "child_process";
import fs from "fs";
import { cleanPreviousZombies } from "./process-cleaner.js";

async function runTest(windowsToLaunch: number) {
  console.log(`\n\n=== MULTI-BACKEND CASCADING TEST | Windows: ${windowsToLaunch} ===`);
  
  const config = ConfigStore.load();
  config.tilingLayout = "cascading"; // Test new cascading mode
  ConfigStore.save(config);

  globalTiler.reconfigure(windowsToLaunch);
  
  const sessions: Awaited<ReturnType<typeof createSession>>[] = [];
  try {
    const backends = ["cloak-headed", "cloak-headed", "cloak-headed"];
    
    // Spawn concurrently now that Mutex is gone and C# is <10ms!
    const promises = [];
    for (let i = 0; i < windowsToLaunch; i++) {
      const backendToUse = backends[i % backends.length] as any;
      console.log(`Launching window ${i + 1} with backend: ${backendToUse}...`);
      
      const p = createSession({
        backend: backendToUse,
        headless: false,
        recordVideo: false,
        email: `test-multi-${i}@proxy-test.local`,
        fingerprintSeed: Date.now() + i,
        proxy: undefined
      }).then(session => {
        sessions.push(session);
        console.log(`Window ${i + 1} (${backendToUse}) launched.`);
      });
      promises.push(p);
    }
    
    await Promise.all(promises);
    
    console.log(`✅ All ${windowsToLaunch} windows launched and cascaded concurrently. Taking screenshot...`);
    
    const psScript = `
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
$Screen = [System.Windows.Forms.SystemInformation]::VirtualScreen
$Bitmap = New-Object System.Drawing.Bitmap $Screen.Width, $Screen.Height
$Graphics = [System.Drawing.Graphics]::FromImage($Bitmap)
$Graphics.CopyFromScreen($Screen.Left, $Screen.Top, 0, 0, $Bitmap.Size)
$Bitmap.Save("C:\\Users\\home\\.gemini\\antigravity-ide\\brain\\684483ea-47ca-435c-89d5-dc09f1269d0e\\artifacts\\os-screenshot-cascading.png")
$Graphics.Dispose()
$Bitmap.Dispose()
`;
    fs.writeFileSync("scratch/screenshot-cascading.ps1", psScript);
    execSync("powershell.exe -ExecutionPolicy Bypass -File scratch/screenshot-cascading.ps1");
    
    console.log("✅ Screenshot saved. Keep open for 5s...");
    await new Promise(r => setTimeout(r, 5000));
    
  } finally {
    console.log("Cleaning up...");
    for (const session of sessions) {
      if (session) await session.close();
    }
  }
}

async function main() {
  await cleanPreviousZombies({ label: "test-cascading" });
  await runTest(3);
  console.log("Tests complete.");
  process.exit(0);
}

main().catch(e => {
  console.error("Test failed:", e);
  process.exit(1);
});
