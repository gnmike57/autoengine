const fs = require('fs');
let html = fs.readFileSync('public/index.html', 'utf8');

// 1. Remove the duplicate Execution panel
let exec1 = html.indexOf('<div class="panel-title">⚙ Execution</div>');
let exec2 = html.indexOf('<div class="panel-title">⚙ Execution</div>', exec1 + 10);

if (exec2 > -1) {
    // exec2 starts at `<div class="panel-title">⚙ Execution</div>`
    // Let's find where the duplicate Golden benchmark ends:
    let goldenBtnEnd = html.indexOf('Benchmark</button>\n          </div>\n        </div>\n      </div>', exec2);
    if (goldenBtnEnd > -1) {
        // delete everything from exec2 to the end of the duplicate div
        let cutEnd = goldenBtnEnd + 'Benchmark</button>\n          </div>\n        </div>\n      </div>'.length;
        html = html.substring(0, exec2) +
`            <div><label class="field-lbl">Proxy Rotate URL</label><input type="text" id="advProxyRotateUrl" placeholder="http://api.proxy.com/rotate?session=[session]"></div>
          </div>
          <!-- Golden Benchmark -->
          <div style="margin-top:14px;padding-top:12px;border-top:1px solid var(--border);">
            <div class="panel-title" style="font-size:12px;margin-bottom:8px;">🏆 Golden Benchmark</div>
            <div style="display:grid;grid-template-columns:1fr 1fr;gap:6px;">
              <div style="display:flex;gap:4px;align-items:center;"><label
                  style="font-size:9px;color:var(--text3);width:30px;font-weight:700;">JOE</label><input type="text"
                  id="goldenJoe" style="font-family:'JetBrains Mono',monospace;font-size:10px;"
                  value=""></div>
              <div style="display:flex;gap:4px;align-items:center;"><label
                  style="font-size:9px;color:var(--text3);width:30px;font-weight:700;">IGN</label><input type="text"
                  id="goldenIgnition" style="font-family:'JetBrains Mono',monospace;font-size:10px;"
                  value=""></div>
            </div>
            <button id="btnGoldenBenchmark" class="btn btn-start" onclick="startGoldenBenchmark()"
              style="width:100%;margin-top:8px;padding:8px;background:linear-gradient(135deg,#f59e0b,#ef4444);">🏆 Run
              Benchmark</button>
          </div>
        </div>
      </div>\n` + html.substring(cutEnd);
    }
}

// 2. Fix the stealth/debug IDs
let stealthStr = `<div class="panel-title">🛡 Stealth & Debug</div>
        </div>
        <div class="panel-body">
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:6px;">
            <label class="toggle-row" title="Automatically optimize all settings (OS profile, concurrency, video, etc.) per-session based on which backend is active. Essential for multi-backend rotation modes."><span style="color:var(--amber);font-weight:600;">⚡ Auto Best Native Per Backend</span><label class="cyber-switch"><input type="checkbox" id="adv"><span class="cyber-slider"></span></label></label>
            <label class="toggle-row"><span>Record Video</span><label class="cyber-switch"><input type="checkbox" id="adv"><span class="cyber-slider"></span></label></label>
            <label class="toggle-row" title="Capture Playwright traces (.zip) for all sessions"><span>Enable Tracing</span><label class="cyber-switch"><input type="checkbox" id="adv"><span class="cyber-slider"></span></label></label>
            <label class="toggle-row"><span>Cache Injection</span><label class="cyber-switch"><input type="checkbox" id="adv"><span class="cyber-slider"></span></label></label>
            <label class="toggle-row"><span>AI Verification</span><label class="cyber-switch"><input type="checkbox" id="adv"><span class="cyber-slider"></span></label></label>
            <label class="toggle-row"><span>Use HttpCloak (TLS Proxy)</span><label class="cyber-switch"><input type="checkbox" id="adv"><span class="cyber-slider"></span></label></label>
            <label class="toggle-row"><span>Stealth Bypass HttpCloak</span><label class="cyber-switch"><input type="checkbox" id="adv"><span class="cyber-slider"></span></label></label>
            <label class="toggle-row"><span>Inject Stealth JS Plugins</span><label class="cyber-switch"><input type="checkbox" id="adv"><span class="cyber-slider"></span></label></label>
            <label class="toggle-row" title="Skip the Cloudflare verification if possible"><span>Ignition Verif Bypass</span><label class="cyber-switch"><input type="checkbox" id="adv"><span class="cyber-slider"></span></label></label>`;

let newStealthStr = `<div class="panel-title">🛡 Stealth & Debug</div>
        </div>
        <div class="panel-body">
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:6px;">
            <label class="toggle-row" title="Automatically optimize all settings (OS profile, concurrency, video, etc.) per-session based on which backend is active. Essential for multi-backend rotation modes."><span style="color:var(--amber);font-weight:600;">⚡ Auto Best Native Per Backend</span><label class="cyber-switch"><input type="checkbox" id="advAutoOptimize"><span class="cyber-slider"></span></label></label>
            <label class="toggle-row"><span>Record Video</span><label class="cyber-switch"><input type="checkbox" id="advRecordVideo"><span class="cyber-slider"></span></label></label>
            <label class="toggle-row" title="Capture Playwright traces (.zip) for all sessions"><span>Enable Tracing</span><label class="cyber-switch"><input type="checkbox" id="advEnableTracing"><span class="cyber-slider"></span></label></label>
            <label class="toggle-row"><span>Cache Injection</span><label class="cyber-switch"><input type="checkbox" id="advCacheInjection"><span class="cyber-slider"></span></label></label>
            <label class="toggle-row"><span>AI Verification</span><label class="cyber-switch"><input type="checkbox" id="advEnableVerification"><span class="cyber-slider"></span></label></label>
            <label class="toggle-row"><span>Use HttpCloak (TLS Proxy)</span><label class="cyber-switch"><input type="checkbox" id="advUseHttpCloak"><span class="cyber-slider"></span></label></label>
            <label class="toggle-row"><span>Stealth Bypass HttpCloak</span><label class="cyber-switch"><input type="checkbox" id="advStealthBypass"><span class="cyber-slider"></span></label></label>
            <label class="toggle-row"><span>Inject Stealth JS Plugins</span><label class="cyber-switch"><input type="checkbox" id="advInjectStealthJS"><span class="cyber-slider"></span></label></label>
            <label class="toggle-row" title="Skip the Cloudflare verification if possible"><span>Ignition Verif Bypass</span><label class="cyber-switch"><input type="checkbox" id="advIgnitionVerifBypass"><span class="cyber-slider"></span></label></label>`;

html = html.replace(stealthStr, newStealthStr);

// A little hack in case my previous replace_file_content already replaced some of them.
// Let's just do a regex replace over the Stealth & Debug panel manually.
let panelStartIndex = html.indexOf('<div class="panel-title">🛡 Stealth & Debug</div>');
if (panelStartIndex > -1) {
    let sub = html.substring(panelStartIndex, panelStartIndex + 2000);
    // Replace ids
    sub = sub.replace('id="adv"></span></label></label>\n            <label class="toggle-row"><span>Record Video', 'id="advAutoOptimize"></span></label></label>\n            <label class="toggle-row"><span>Record Video');
    sub = sub.replace('Record Video</span><label class="cyber-switch"><input type="checkbox" id="adv">', 'Record Video</span><label class="cyber-switch"><input type="checkbox" id="advRecordVideo">');
    sub = sub.replace('Enable Tracing</span><label class="cyber-switch"><input type="checkbox" id="adv">', 'Enable Tracing</span><label class="cyber-switch"><input type="checkbox" id="advEnableTracing">');
    sub = sub.replace('Cache Injection</span><label class="cyber-switch"><input type="checkbox" id="adv">', 'Cache Injection</span><label class="cyber-switch"><input type="checkbox" id="advCacheInjection">');
    sub = sub.replace('AI Verification</span><label class="cyber-switch"><input type="checkbox" id="adv">', 'AI Verification</span><label class="cyber-switch"><input type="checkbox" id="advEnableVerification">');
    sub = sub.replace('Use HttpCloak (TLS Proxy)</span><label class="cyber-switch"><input type="checkbox" id="adv">', 'Use HttpCloak (TLS Proxy)</span><label class="cyber-switch"><input type="checkbox" id="advUseHttpCloak">');
    sub = sub.replace('Stealth Bypass HttpCloak</span><label class="cyber-switch"><input type="checkbox" id="adv">', 'Stealth Bypass HttpCloak</span><label class="cyber-switch"><input type="checkbox" id="advStealthBypass">');
    sub = sub.replace('Inject Stealth JS Plugins</span><label class="cyber-switch"><input type="checkbox" id="adv">', 'Inject Stealth JS Plugins</span><label class="cyber-switch"><input type="checkbox" id="advInjectStealthJS">');
    sub = sub.replace('Ignition Verif Bypass</span><label class="cyber-switch"><input type="checkbox" id="adv">', 'Ignition Verif Bypass</span><label class="cyber-switch"><input type="checkbox" id="advIgnitionVerifBypass">');
    
    html = html.substring(0, panelStartIndex) + sub + html.substring(panelStartIndex + 2000);
}

fs.writeFileSync('public/index.html', html, 'utf8');
console.log('Fixed index.html');
