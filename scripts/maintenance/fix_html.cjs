const fs = require('fs');

const htmlContent = fs.readFileSync('/Volumes/Macintosh_HD/Users/user294545/Desktop/automati1-111-pORT-main/public/index.html', 'utf-8');
const lines = htmlContent.split('\n');

const goodLines = lines.slice(0, 577); // lines 1 to 577

const newLines = `              <div style="display:flex;gap:4px;align-items:center;"><label
                  style="font-size:9px;color:var(--text3);width:30px;font-weight:700;">IGN</label><input type="text"
                  id="goldenIgnition" style="font-family:'JetBrains Mono',monospace;font-size:10px;"
                  value=""></div>
            </div>
            <button id="btnGoldenBenchmark" class="btn btn-start" onclick="startGoldenBenchmark()"
              style="width:100%;margin-top:8px;padding:8px;background:linear-gradient(135deg,#f59e0b,#ef4444);">🏆 Run
              Benchmark</button>
          </div>
        </div>
      </div>

      <!-- Stealth & Maintenance -->
      <div class="panel">
        <div class="panel-head">
          <div class="panel-title">🛡 Stealth & Debug</div>
        </div>
        <div class="panel-body">
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:6px;">
            <label class="toggle-row" title="Automatically optimize all settings (OS profile, concurrency, video, etc.) per-session based on which backend is active. Essential for multi-backend rotation modes."><span style="color:var(--amber);font-weight:600;">⚡ Auto Best Native Per Backend</span><label class="cyber-switch"><input type="checkbox" id="adv"><span class="cyber-slider"></span></label></label>
            <label class="toggle-row"><span>Record Video</span><label class="cyber-switch"><input type="checkbox" id="adv"><span class="cyber-slider"></span></label></label>
            <label class="toggle-row" title="Capture Playwright traces (.zip) for all sessions"><span>Enable Tracing</span><label class="cyber-switch"><input type="checkbox" id="adv"><span class="cyber-slider"></span></label></label>
            <label class="toggle-row"><span>Cache Injection</span><label class="cyber-switch"><input type="checkbox" id="adv"><span class="cyber-slider"></span></label></label>
            <label class="toggle-row"><span>AI Verification</span><label class="cyber-switch"><input type="checkbox" id="adv"><span class="cyber-slider"></span></label></label>
            <label class="toggle-row"><span>Always Click Remember Me</span><label class="cyber-switch"><input type="checkbox" id="adv"><span class="cyber-slider"></span></label></label>
            <label class="toggle-row"><span style="color:var(--cyan);">Auto CDP Dump on Stalls</span><label class="cyber-switch"><input type="checkbox" id="advAutoCdp" checked><span class="cyber-slider"></span></label></label>
            <label class="toggle-row"><span style="color:var(--amber);">Active WAF Fuzzing</span><label class="cyber-switch"><input type="checkbox" id="advWafFuzzing" onchange="toggleWafFuzzer(this.checked)"><span class="cyber-slider"></span></label></label>

            <label class="toggle-row"><span>HttpCloak</span><label class="cyber-switch"><input type="checkbox" id="adv"><span class="cyber-slider"></span></label></label>
            <label class="toggle-row"><span>Mutate Fingerprint on Retry</span><label class="cyber-switch"><input type="checkbox" id="adv"><span class="cyber-slider"></span></label></label>
            <label class="toggle-row" title="Pause session indefinitely on CAPTCHA"><span>Manual CAPTCHA Mode</span><label class="cyber-switch"><input type="checkbox" id="adv"><span class="cyber-slider"></span></label></label>
            <label class="toggle-row" title="Stealth bypasses HttpCloak"><span>Bypass (Stealth)</span><input
                type="checkbox" id="advStealthBypass" checked></label>
            <label class="toggle-row" title="Inject fingerprint script for Zendriver/Spider/Cloak"><span>Inject Stealth JS</span><label class="cyber-switch"><input type="checkbox" id="adv"><span class="cyber-slider"></span></label></label>
            <label class="toggle-row" title="Bypass Ignition login popup with random code"><span>Ignition Bypass</span><label class="cyber-switch"><input type="checkbox" id="adv"><span class="cyber-slider"></span></label></label>
          </div>
          <div style="margin-top:14px;padding-top:12px;border-top:1px solid var(--border);">
            <div class="panel-title" style="font-size:12px;margin-bottom:8px;">🔧 Maintenance</div>
            <div style="display:grid;grid-template-columns:1fr 1fr;gap:6px;">
              <button class="btn btn-ghost" onclick="document.getElementById('uploadCsv').click()">⬆ Upload CSV</button>
              <input type="file" id="uploadCsv" hidden accept=".csv" onchange="uploadCsv(this.files[0])">
              <button class="btn btn-ghost" onclick="syncData()">🔄 Refresh Pool</button>
              <button class="btn btn-danger" onclick="purgeFailed()">🗑 Purge Failed</button>
              <button class="btn btn-danger" onclick="clearProgress()">🗑 Clear Progress</button>
              <button class="btn btn-ghost" onclick="cleanOldRecords()" style="grid-column:span 2;">🧹 Purge Old Logs</button>
              <button class="btn btn-cyan" onclick="saveSettingsAsDefault()">💾 Save as Default</button>
              <button class="btn btn-cyan" onclick="saveSettingsToFile()">💾 Save to File</button>
            </div>
          </div>
        </div>
      </div>
    </div>
  </div>

  <!-- Multi-Backend Settings Card -->
  <div class="panel" id="multiBackendPanel" style="display: none; border-left: 3px solid var(--amber); max-width: 800px; margin: 15px auto;">
    <div class="panel-head">
      <div class="panel-title" style="color: var(--amber);">⚡ Multi-Backend Optimal Settings</div>
    </div>
    <div class="panel-body" style="padding: 10px;">
      <div style="font-size: 11px; color: var(--text2); margin-bottom: 12px; line-height: 1.4;">
        When <strong>Auto Best Native Per Backend</strong> is enabled, the engine ignores your manual toggle settings below and dynamically enforces these architecturally correct limits per-browser to prevent honeypot flagging.
      </div>
      <div id="multiBackendTableContainer" style="overflow-x: auto;"></div>
    </div>
  </div>

  <!-- ═══════════════════════════════════════════════════
       TERMINAL
       ═══════════════════════════════════════════════════ -->
  
  <!-- TEMP DISABLED TAB -->
  <div id="tab-tempdisabled" class="view">
    <div class="glass-panel" style="padding: 24px; min-height: 400px;">
      <h2 style="margin-bottom: 20px; border-bottom: 1px solid var(--border); padding-bottom: 12px; color: var(--amber);">
        🔒 Temporarily Disabled Accounts
      </h2>
      <div id="tempDisabledContainer" style="display: flex; flex-direction: column; gap: 20px;">
        <div style="color: var(--text3); font-style: italic;">Awaiting data...</div>
      </div>
    </div>
  </div>

  <!-- ANALYTICS TAB -->
  <div id="tab-analytics" class="view">
    <div class="glass-panel" style="margin-bottom: 20px; padding: 20px;">
      <h3 style="margin-bottom: 15px; border-bottom: 1px solid var(--border); padding-bottom: 10px;">⚡ Engine Vitals</h3>
      <div style="display: flex; gap: 20px;">
        <div class="stat-card" style="flex: 1;">
          <div class="stat-label">CPU USAGE</div>
          <div class="stat-val vitals-idle" id="vitals-cpu">— idle</div>
        </div>
        <div class="stat-card" style="flex: 1;">
          <div class="stat-label">MEMORY (HEAP)</div>
          <div class="stat-val vitals-idle" id="vitals-heap">— idle</div>
        </div>
        <div class="stat-card" style="flex: 1;">
          <div class="stat-label">MEMORY (RSS)</div>
          <div class="stat-val vitals-idle" id="vitals-rss">— idle</div>
        </div>
        <div class="stat-card" style="flex: 1;">
          <div class="stat-label">UPTIME</div>
          <div class="stat-val vitals-idle" id="vitals-uptime">— idle</div>
        </div>
      </div>
    </div>

    <div class="glass-panel" style="margin-bottom: 20px; padding: 20px;">
      <h3 style="margin-bottom: 15px; border-bottom: 1px solid var(--border); padding-bottom: 10px;">📈 Target Success/Failure Trajectory</h3>
      <div style="height: 300px; width: 100%;">
        <canvas id="analyticsChart"></canvas>
      </div>
    </div>
    
    <div class="glass-panel" style="padding: 20px;">
      <h3 style="margin-bottom: 15px; border-bottom: 1px solid var(--border); padding-bottom: 10px;">🌐 Proxy Pool Health Visualizer</h3>
      <div id="proxy-pool-grid" style="display: grid; grid-template-columns: repeat(auto-fill, minmax(150px, 1fr)); gap: 10px;">
        <!-- Hydrated by JS -->
        <div style="color: var(--text2); font-size: 13px;">Waiting for telemetry...</div>
      </div>
    </div>

    <!-- Fingerprint Scorecard -->
    <div class="glass-panel" style="margin-top: 20px; padding: 20px;">
      <h3 style="margin-bottom: 15px; border-bottom: 1px solid var(--border); padding-bottom: 10px;">🔬 Fingerprint Scorecard — Live Per-Backend</h3>
      <div id="fpScorecardGrid" style="display: grid; grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)); gap: 12px;">
        <div style="color: var(--text3); font-size: 13px; grid-column: 1 / -1;">Run a fingerprint audit to populate scores. Use the <code style="color: var(--cyan);">fp-matrix-audit</code> script or the FP Audit panel on the Command tab.</div>
      </div>
      <div style="margin-top: 16px; border-top: 1px solid var(--border); padding-top: 12px;">
        <div style="display: flex; gap: 16px; flex-wrap: wrap; font-size: 11px; color: var(--text2);">
          <span>🟢 Score 0-5 = Excellent</span>
          <span>🟡 Score 6-15 = Fair</span>
          <span>🔴 Score 16+ = Poor</span>
          <span style="color: var(--cyan);">📱 = Mobile</span>
          <span style="color: var(--text);">🖥️ = Desktop</span>
        </div>
      </div>
    </div>
  </div>

<div id="tab-terminal" class="view">
    <div class="panel" style="height: calc(100vh - 120px); display: flex; flex-direction: column;">
      <div class="panel-head">
        <div class="panel-title">💻 Live Terminal</div>
        <div style="display: flex; gap: 8px;">
           <select id="terminalLogLevel" onchange="filterTerminalLogs()" style="background:var(--bg3);color:var(--text);border:1px solid var(--border);padding:4px 8px;border-radius:4px;font-size:11px;">
              <option value="ALL">All Levels</option>
              <option value="INFO">INFO & Above</option>
              <option value="WARN">WARN & Above</option>
              <option value="ERROR">ERROR Only</option>
           </select>
           <button class="btn btn-ghost btn-sm" onclick="document.getElementById('logBody').innerHTML=''">⊘ Clear</button>
           <button class="btn btn-ghost btn-sm" onclick="downloadLogs()">💾 Download</button>
           <label style="display:flex; align-items:center; gap:4px; font-size:11px; cursor:pointer;">
             <input type="checkbox" id="autoScrollLogs" checked style="accent-color:var(--cyan);"> Auto-scroll
           </label>
        </div>
      </div>
      <div class="panel-body" style="flex-grow: 1; padding: 0; background: #0a0c10; overflow: hidden; position: relative;">
        <div id="logBody" style="position:absolute; inset: 0; overflow-y: auto; padding: 12px; font-family: 'JetBrains Mono', monospace; font-size: 11px; display: flex; flex-direction: column; gap: 4px;">
          <div id="terminalEmptyState" style="display:flex; align-items:center; justify-content:center; height:100%; color:var(--text3); font-size:13px; flex-direction:column; gap:8px;">
            <span style="font-size:24px; opacity:0.3;">💻</span>
            <span>Waiting for engine to start... Logs will stream here in real-time.</span>
          </div>
        </div>
      </div>
    </div>
  </div>

  <!-- ═══════════════════════════════════════════════════
       HERMES AI SYSTEM
       ═══════════════════════════════════════════════════ -->
  <div id="tab-hermes" class="view">
    <div class="hermes-grid">
      <!-- Status & Controls -->
      <div class="panel">
        <div class="panel-head">
          <div class="panel-title">🤖 Hermes God Mode (Always-On)</div>
          <div style="display:flex;align-items:center;gap:8px;">
            <span class="hermes-status-dot dead" id="hermesStatusDot"></span>
            <span id="hermesStatusLabel" style="font-size:11px;color:var(--text2);font-family:'JetBrains Mono',monospace;">OFFLINE</span>
          </div>
        </div>
        <div class="panel-body">
          <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px;">
            <div>
              <div style="font-size:10px;color:var(--text3);text-transform:uppercase;letter-spacing:0.5px;">Uptime</div>
              <div class="hermes-uptime" id="hermesUptime">—</div>
            </div>
            <div style="text-align:right;">
              <div style="font-size:10px;color:var(--text3);text-transform:uppercase;letter-spacing:0.5px;">Last Review</div>
              <div id="hermesLastReview" style="font-size:11px;color:var(--text2);font-family:'JetBrains Mono',monospace;">—</div>
            </div>
          </div>
          <div class="hermes-stat-grid">
            <div class="hermes-stat-card">
              <div class="stat-val" id="hermesReviewCount">0</div>
              <div class="stat-label">Reviews</div>
            </div>
            <div class="hermes-stat-card">
              <div class="stat-val" id="hermesToolCalls">0</div>
              <div class="stat-label">Tool Calls</div>
            </div>
            <div class="hermes-stat-card">
              <div class="stat-val" id="hermesPatchCount">0</div>
              <div class="stat-label">Patches</div>
            </div>
            <div class="hermes-stat-card">
              <div class="stat-val" id="hermesErrorCount">0</div>
              <div class="stat-label">Errors</div>
            </div>
            <div class="hermes-stat-card">
              <div class="stat-val" id="hermesActiveSessions" style="color: var(--cyan);">0</div>
              <div class="stat-label">Active Tasks</div>
            </div>
          </div>
          <div class="hermes-controls">
            <button class="btn btn-cyan" onclick="hermesReviewNow()">🧠 Trigger Review</button>
            <button class="btn btn-ghost" onclick="hermesRestart()">🔄 Restart Daemon</button>
          </div>
          <div style="margin-top:14px;padding-top:12px;border-top:1px solid var(--border);">
            <div class="panel-title" style="font-size:12px;margin-bottom:8px;">⚙ Automation</div>
            <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;">
              <label class="toggle-row">
                <span>Auto-Review</span>
                <label class="cyber-switch"><input type="checkbox" id="hermes"><span class="cyber-slider"></span></label>
              </label>
              <div>
                <label class="field-lbl">Review Interval (min)</label>
                <input type="number" id="hermesInterval" value="30" min="5" max="120" onchange="hermesSetInterval(this.value)">
              </div>
            </div>
          </div>
          <div style="margin-top:14px;padding-top:12px;border-top:1px solid var(--border);">
            <div class="panel-title" style="font-size:12px;margin-bottom:8px;">🧬 Model & Identity</div>
            <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;">
              <div>
                <label class="field-lbl">AI Model</label>
                <div style="font-size:11px;color:var(--cyan);font-family:'JetBrains Mono',monospace;padding:6px;background:rgba(0,0,0,0.3);border-radius:6px;">nvidia/nemotron-nano-12b-v2-vl:free</div>
              </div>
              <div>
                <label class="field-lbl">Mode</label>
                <div style="font-size:11px;color:var(--red);font-weight:700;font-family:'JetBrains Mono',monospace;padding:6px;background:rgba(239,68,68,0.05);border:1px solid rgba(239,68,68,0.15);border-radius:6px;">⚡ GOD MODE</div>
              </div>
            </div>
          </div>
        </div>
      </div>

      <!-- Live Log Feed -->
      <div class="panel">
        <div class="panel-head">
          <div class="panel-title">📜 Hermes Log</div>
          <span style="font-size:10px;color:var(--text3);font-family:'JetBrains Mono',monospace;" id="hermesLogCount">0 entries</span>
        </div>
        <div class="panel-body" style="padding:8px;">
          <div class="hermes-log-feed" id="hermesLogFeed">
            <div style="color:var(--text3);text-align:center;padding:20px;">Waiting for Hermes logs...</div>
          </div>
        </div>
      </div>
    </div>

    <!-- Capabilities -->
    <div class="panel" style="margin-top:16px;">
      <div class="panel-head">
        <div class="panel-title">🛠 Tool Capabilities</div>
      </div>
      <div class="panel-body">
        <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(200px,1fr));gap:6px;">
          <div class="hermes-stat-card" style="text-align:left;padding:8px 10px;">
            <div style="font-size:11px;font-weight:600;color:var(--text);">📂 read_file</div>
            <div style="font-size:9px;color:var(--text3);margin-top:2px;">Read workspace files for analysis</div>
          </div>
          <div class="hermes-stat-card" style="text-align:left;padding:8px 10px;">
            <div style="font-size:11px;font-weight:600;color:var(--text);">🔧 apply_code_patch</div>
            <div style="font-size:9px;color:var(--text3);margin-top:2px;">Syntax-checked live code edits</div>
          </div>
          <div class="hermes-stat-card" style="text-align:left;padding:8px 10px;">
            <div style="font-size:11px;font-weight:600;color:var(--text);">⚙ update_ui_settings</div>
            <div style="font-size:9px;color:var(--text3);margin-top:2px;">Tweak engine config via IPC</div>
          </div>
          <div class="hermes-stat-card" style="text-align:left;padding:8px 10px;">
            <div style="font-size:11px;font-weight:600;color:var(--text);">📸 analyze_screenshot</div>
            <div style="font-size:9px;color:var(--text3);margin-top:2px;">Vision AI on CAPTCHAs & blocks</div>
          </div>
          <div class="hermes-stat-card" style="text-align:left;padding:8px 10px;">
            <div style="font-size:11px;font-weight:600;color:var(--text);">🔍 search_codebase</div>
            <div style="font-size:9px;color:var(--text3);margin-top:2px;">Grep across all source files</div>
          </div>
          <div class="hermes-stat-card" style="text-align:left;padding:8px 10px;">
            <div style="font-size:11px;font-weight:600;color:var(--text);">🎭 execute_playwright_eval</div>
            <div style="font-size:9px;color:var(--text3);margin-top:2px;">Headless browser eval & selector test</div>
          </div>
          <div class="hermes-stat-card" style="text-align:left;padding:8px 10px;">
            <div style="font-size:11px;font-weight:600;color:var(--text);">🌐 probe_target_headers</div>
            <div style="font-size:9px;color:var(--text3);margin-top:2px;">Check WAF / CDN headers</div>
          </div>
          <div class="hermes-stat-card" style="text-align:left;padding:8px 10px;">
            <div style="font-size:11px;font-weight:600;color:var(--text);">🔄 rotate_proxy_subnet</div>
            <div style="font-size:9px;color:var(--text3);margin-top:2px;">Rotate IPs or ban subnets</div>
          </div>
          <div class="hermes-stat-card" style="text-align:left;padding:8px 10px;">
            <div style="font-size:11px;font-weight:600;color:var(--text);">💻 run_terminal_command</div>
            <div style="font-size:9px;color:var(--text3);margin-top:2px;">Execute shell commands (God Mode)</div>
          </div>
          <div class="hermes-stat-card" style="text-align:left;padding:8px 10px;">
            <div style="font-size:11px;font-weight:600;color:var(--text);">📄 manage_files</div>
            <div style="font-size:9px;color:var(--text3);margin-top:2px;">Create, append, delete files</div>
          </div>
          <div class="hermes-stat-card" style="text-align:left;padding:8px 10px;">
            <div style="font-size:11px;font-weight:600;color:var(--text);">⏪ revert_patch</div>
            <div style="font-size:9px;color:var(--text3);margin-top:2px;">Git revert if patch fails</div>
          </div>
          <div class="hermes-stat-card" style="text-align:left;padding:8px 10px;">
            <div style="font-size:11px;font-weight:600;color:var(--text);">🚀 restart_server</div>
            <div style="font-size:9px;color:var(--text3);margin-top:2px;">Hard restart for self-healing</div>
          </div>
          <div class="hermes-stat-card" style="text-align:left;padding:8px 10px;border:1px solid rgba(34,211,238,0.3);">
            <div style="font-size:11px;font-weight:600;color:var(--cyan);">🔍 inspect_cdp</div>
            <div style="font-size:9px;color:var(--text3);margin-top:2px;">Dump real-time DOM from stalled sessions</div>
          </div>
          <div class="hermes-stat-card" style="text-align:left;padding:8px 10px;border:1px solid rgba(34,211,238,0.3);">
            <div style="font-size:11px;font-weight:600;color:var(--cyan);">🗄 query_credentials_sqlite</div>
            <div style="font-size:9px;color:var(--text3);margin-top:2px;">Read-only telemetry & PRAGMA analysis</div>
          </div>
          <div class="hermes-stat-card" style="text-align:left;padding:8px 10px;border:1px solid rgba(34,211,238,0.3);">
            <div style="font-size:11px;font-weight:600;color:var(--cyan);">🪟 manage_grid_layout</div>
            <div style="font-size:9px;color:var(--text3);margin-top:2px;">Force UI refresh of headless debug tiles</div>
          </div>
          <div class="hermes-stat-card" style="text-align:left;padding:8px 10px;border:1px solid rgba(34,211,238,0.3);">
            <div style="font-size:11px;font-weight:600;color:var(--cyan);">🔥 generate_waf_heatmap</div>
            <div style="font-size:9px;color:var(--text3);margin-top:2px;">ASCII visualization of active honeypots</div>
          </div>
        </div>
      </div>
    </div>
  </div>`;

// Find the last few lines that are still intact at 577
const restOfFileLines = htmlContent.substring(htmlContent.indexOf('<!-- ═══════ MODALS ═══════ -->')).split('\n');
const fixedContent = goodLines.join('\n') + '\n' + newLines + '\n' + restOfFileLines.join('\n');

fs.writeFileSync('/Volumes/Macintosh_HD/Users/user294545/Desktop/automati1-111-pORT-main/public/index.html', fixedContent);
console.log('Fixed index.html');
