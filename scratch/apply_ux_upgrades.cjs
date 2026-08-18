const fs = require('fs');

// 1. Fix HTML: Tooltips, Bad IDs, Empty States, Hero Banner Collapse
let html = fs.readFileSync('public/index.html', 'utf8');

// Bad IDs
html = html.replace('<label class="cyber-switch"><input type="checkbox" id="adv"><span class="cyber-slider"></span></label> \n                📱 Emulate Mobile Device (Android OS + Touch Viewport)',
'<label class="cyber-switch"><input type="checkbox" id="advEmulateMobile"><span class="cyber-slider"></span></label> \n                📱 Emulate Mobile Device (Android OS + Touch Viewport)');

html = html.replace('<label class="cyber-switch"><input type="checkbox" id="adv"><span class="cyber-slider"></span></label>\n              <span>🔄 Rotate backend on fingerprint detection</span>',
'<label class="cyber-switch"><input type="checkbox" id="advRotateOnFP"><span class="cyber-slider"></span></label>\n              <span>🔄 Rotate backend on fingerprint detection</span>');

html = html.replace('<label class="cyber-switch"><input type="checkbox" id="adv"><span class="cyber-slider"></span></label>\n              <span>🔥 Only burn session on Perm Disabled</span>',
'<label class="cyber-switch"><input type="checkbox" id="advBurnOnlyOnPermDisabled"><span class="cyber-slider"></span></label>\n              <span>🔥 Only burn session on Perm Disabled</span>');

// Tooltips on advanced settings
const tooltipAdd = (search, tooltip) => {
    html = html.replace(search, search + ` <span class="cyber-tooltip" title="${tooltip}">(?)</span>`);
};
tooltipAdd('<span>HttpCloak (Mask CDP)</span>', 'Actively intercepts network traffic to strip headless Chromium signatures and CDP metadata before it hits WAFs.');
tooltipAdd('<span>Stealth JS Override</span>', 'Injects Apify fingerprint-injector scripts into the JS runtime context to override navigator properties.');
tooltipAdd('<span>Bypass WAF</span>', 'Strips the entire HTTP layer. Use strictly with Cloudflare/Datadome targets.');
tooltipAdd('<span>Cache Injection</span>', 'Passes cookies and trust tokens between sessions to build session resilience.');
tooltipAdd('<span>Record Video</span>', 'Captures a full WebM video stream of the session for forensic review.');

// Hero Banner Collapser
html = html.replace('<div class="nav-right">',
  `<div class="nav-right">
      <button class="btn btn-ghost btn-sm" onclick="toggleHeroBanner()" title="Toggle Hero Banner View">👁️ BANNER</button>`);

// Empty states injection points
html = html.replace('<tbody id="credentialList"></tbody>', '<tbody id="credentialList"></tbody>');

fs.writeFileSync('public/index.html', html, 'utf8');

// 2. Fix JS: Tooltips logic, Empty States logic
let js = fs.readFileSync('public/js/app.js', 'utf8');

if (!js.includes('function toggleHeroBanner()')) {
  js += `\n    function toggleHeroBanner() {
      const b = document.getElementById('heroBanner');
      if(b) {
         if (b.style.display === 'none') b.style.display = 'block';
         else b.style.display = 'none';
      }
    }\n`;
}

// Add empty state to credentials
js = js.replace("tbody.innerHTML = list.map(r => {", 
`if (list.length === 0) {
    tbody.innerHTML = '<tr><td colspan="6"><div class="cyber-empty-state">No credentials loaded matching filters. Awaiting telemetry or drop a CSV...</div></td></tr>';
    return;
}
tbody.innerHTML = list.map(r => {`);

// Add empty state to results
js = js.replace("g.innerHTML = filtered.map(r => {", 
`if (filtered.length === 0) {
    g.innerHTML = '<div class="cyber-empty-state" style="grid-column: 1 / -1;">No resulted credentials found.</div>';
    return;
}
g.innerHTML = filtered.map(r => {`);

// Clearer Action context on LAUNCH button
js = js.replace("document.getElementById('bsTotal').textContent = total;",
`document.getElementById('bsTotal').textContent = total;
  const btn = document.getElementById('btnStart');
  if (btn) btn.innerHTML = '▶ LAUNCH (' + untested + ' QUEUED)';
`);

fs.writeFileSync('public/js/app.js', js, 'utf8');

// 3. Fix CSS: Tooltip & Empty State styling
let css = fs.readFileSync('public/css/style.css', 'utf8');

if (!css.includes('.cyber-tooltip')) {
  css += `\n
  /* ═══════ UX UPGRADES ═══════ */
  .cyber-tooltip {
    display: inline-block;
    background: rgba(6, 182, 212, 0.1);
    color: var(--cyan);
    border-radius: 50%;
    width: 14px;
    height: 14px;
    line-height: 14px;
    text-align: center;
    font-size: 9px;
    cursor: help;
    font-family: 'JetBrains Mono', monospace;
    margin-left: 6px;
    border: 1px solid rgba(6, 182, 212, 0.3);
  }
  .cyber-tooltip:hover {
    background: rgba(6, 182, 212, 0.3);
  }
  .cyber-empty-state {
    padding: 40px 20px;
    text-align: center;
    color: var(--text3);
    font-family: 'JetBrains Mono', monospace;
    font-size: 11px;
    border: 1px dashed var(--border);
    border-radius: 8px;
    background: rgba(0,0,0,0.2);
    letter-spacing: 1px;
  }
  `;
}
fs.writeFileSync('public/css/style.css', css, 'utf8');

console.log("UX Upgrades applied.");
