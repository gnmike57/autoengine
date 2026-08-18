const fs = require('fs');

// 1. Append function to app.js
const appJsCode = `
// Added WAF Fuzzer and CDP Toggle Controls
function toggleWafFuzzer(active) {
  fetch('/api/waf/fuzzer', {
    method: 'POST',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({ active })
  }).then(res => res.json())
  .then(data => {
     console.log('WAF Fuzzer toggled:', data);
  })
  .catch(e => console.error('Failed to toggle fuzzer:', e));
}
`;
fs.appendFileSync('/Volumes/Macintosh_HD/Users/user294545/Desktop/automati1-111-pORT-main/public/js/app.js', appJsCode);

// 2. Add endpoint to server.ts
const serverPath = '/Volumes/Macintosh_HD/Users/user294545/Desktop/automati1-111-pORT-main/src/server/server.ts';
let serverCode = fs.readFileSync(serverPath, 'utf8');

const endpointCode = `
// WAF Fuzzer Endpoint
app.post("/api/waf/fuzzer", express.json(), (req, res) => {
    try {
        const { active } = req.body;
        if (active) {
            const { spawn } = require("child_process");
            const p = spawn("npx", ["tsx", ".agents/sidecars/fuzzer.ts"], { detached: true, stdio: "ignore" });
            p.unref();
            res.json({ status: "started" });
        } else {
            require("child_process").exec("pkill -f fuzzer.ts", (err) => {});
            res.json({ status: "stopped" });
        }
    } catch(e) {
        res.status(500).json({ error: String(e) });
    }
});
`;

serverCode = serverCode.replace('app.get("/events"', endpointCode + '\napp.get("/events"');
fs.writeFileSync(serverPath, serverCode);

console.log('Appended UI controls and API endpoint.');
