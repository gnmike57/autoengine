const fs = require('fs');

// 1. Add Start Batch button to index.html
const indexPath = '/Volumes/Macintosh_HD/Users/user294545/Desktop/automati1-111-pORT-main/public/index.html';
let indexHtml = fs.readFileSync(indexPath, 'utf8');

const startBatchBtn = `
      <div style="margin-top:20px; text-align:center;">
          <button id="startBatchBtn" onclick="startAutonomousBatch()" style="padding:15px 30px; font-size:18px; background:var(--green); color:#1a1a1a; border:none; border-radius:8px; font-weight:bold; cursor:pointer; box-shadow: 0 0 15px rgba(34, 197, 94, 0.5);">🚀 START BATCH (E2E AUTONOMOUS)</button>
      </div>
`;
// Insert near the top of the command center panel, after the header
const targetInsertion = `<div class="panel header-panel">
    <h1>🕸️ Spider-Grid / Command Centre</h1>`;
if (indexHtml.includes(targetInsertion)) {
    indexHtml = indexHtml.replace(targetInsertion, targetInsertion + startBatchBtn);
}
fs.writeFileSync(indexPath, indexHtml);

// 2. Add startAutonomousBatch to app.js
const appJsPath = '/Volumes/Macintosh_HD/Users/user294545/Desktop/automati1-111-pORT-main/public/js/app.js';
let appJs = fs.readFileSync(appJsPath, 'utf8');
const appJsAddition = `
window.startAutonomousBatch = function() {
    fetch('/api/orchestrator/start', { method: 'POST' })
    .then(res => res.json())
    .then(data => {
         alert('🚀 Master Orchestrator Daemon started! God Mode activated.');
    })
    .catch(e => alert('Failed to start orchestrator: ' + e));
};
`;
fs.appendFileSync(appJsPath, appJsAddition);

// 3. Add API endpoint to server.ts
const serverPath = '/Volumes/Macintosh_HD/Users/user294545/Desktop/automati1-111-pORT-main/src/server/server.ts';
let serverCode = fs.readFileSync(serverPath, 'utf8');

const endpointCode = `
// Master Orchestrator Endpoint
app.post("/api/orchestrator/start", (_req, res) => {
    try {
        const { globalOrchestrator } = require("../orchestrator.js");
        globalOrchestrator.startBatch();
        res.json({ status: "Orchestrator online" });
    } catch(e) {
        res.status(500).json({ error: String(e) });
    }
});
`;

serverCode = serverCode.replace('app.get("/events"', endpointCode + '\napp.get("/events"');
fs.writeFileSync(serverPath, serverCode);

console.log("Connected GUI to Master Orchestrator");
