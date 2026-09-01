
    const VIEW_TITLES = { liveview: '📡 Command', dashboard: '📊 Dashboard', credentials: '🔑 Credentials', results: '🏆 Results', settings: '⚙ Settings', hermes: '🤖 Hermes', terminal: '💻 Terminal', analytics: '📊 Analytics' };

    // --- Feature 5: Persistent UI State ---
    function saveUIState() {
      const state = {
        credDisplayToggle: document.getElementById('credDisplayToggle')?.value,
        credSearchBox: document.getElementById('credSearchBox')?.value,
        filterOutcome: document.getElementById('filterOutcome')?.value,
      };
      const inputs = document.querySelectorAll('#tab-settings input, #tab-settings select');
      inputs.forEach(el => {
        if (el.id) {
          state[el.id] = el.type === 'checkbox' ? el.checked : el.value;
        }
      });
      localStorage.setItem('automati_ui_state', JSON.stringify(state));
    }

    function saveSettingsAsDefault() {
      saveUIState();
      const state = localStorage.getItem('automati_ui_state');
      localStorage.setItem('automati_default_cfg', state);
      
      const config = getUIConfig();
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: "save-app-config", config }));
      }
      
      showCyberToast('💾 Settings saved as default to app-config.json!');
    }

    function saveSettingsToFile() {
      const config = getUIConfig();
      const dataStr = "data:text/json;charset=utf-8," + encodeURIComponent(JSON.stringify(config, null, 2));
      const downloadAnchorNode = document.createElement('a');
      downloadAnchorNode.setAttribute("href", dataStr);
      downloadAnchorNode.setAttribute("download", "automati-config.json");
      document.body.appendChild(downloadAnchorNode);
      downloadAnchorNode.click();
      downloadAnchorNode.remove();
      showCyberToast('💾 Settings downloaded to file!');
    }

    function loadUIState() {
      try {
        let str = localStorage.getItem('automati_ui_state');
        if (!str) {
          str = localStorage.getItem('automati_default_cfg');
        }
        if (!str) return;
        const state = JSON.parse(str);
        
        let changed = false;
        Object.entries(state).forEach(([id, val]) => {
          const el = document.getElementById(id);
          if (el) {
            // Only fire change if it's actually different, to prevent infinite loops
            if (el.type === 'checkbox') {
              if (el.checked !== val) { el.checked = val; el.dispatchEvent(new Event('change')); changed = true; }
            } else {
              if (el.value !== val) { el.value = val; el.dispatchEvent(new Event('change')); changed = true; }
            }
          }
        });
        
        if (state.credDisplayToggle) renderCredentialsTab();
      } catch (e) {}
    }

    // --- Command Palette Logic ---
    const COMMANDS = [
      { name: 'Run Engine', action: startAutomation, hint: 'Start processing selected credentials' },
      { name: 'Stop Engine', action: stopAutomation, hint: 'Halt all browser tasks safely' },
      { name: 'Clear Progress', action: clearProgress, hint: 'Wipe all test history' },
      { name: 'Purge Failed', action: purgeFailed, hint: 'Remove blocked/permdisabled entries' },
      { name: 'Clean Old Logs', action: cleanOldRecords, hint: 'Clear app.log and screenshots' },
      { name: 'Go to Command', action: () => switchTab('liveview'), hint: 'View active tests' },
      { name: 'Go to Dashboard', action: () => switchTab('dashboard'), hint: 'View statistics' },
      { name: 'Go to Credentials', action: () => switchTab('credentials'), hint: 'Manage inputs' },
      { name: 'Go to Results', action: () => switchTab('results'), hint: 'View successful hits' },
      { name: 'Go to Settings', action: () => switchTab('settings'), hint: 'Configure engine' },
      { name: 'Go to Terminal', action: () => switchTab('terminal'), hint: 'View real-time app.log' },
      { name: 'Go to Hermes', action: () => switchTab('hermes'), hint: 'Ask AI agent' },
      { name: 'Go to Galaxy', action: () => switchTab('galaxy'), hint: 'UFO Galaxy integration' },
    ];
    let filteredCmds = [], cmdIndex = 0;
    function toggleCmdPalette() {
      const bg = document.getElementById('cmdPaletteBg');
      if (bg.classList.contains('active')) {
        bg.classList.remove('active');
      } else {
        bg.classList.add('active');
        document.getElementById('cmdPaletteInput').value = '';
        renderCmdPalette();
        document.getElementById('cmdPaletteInput').focus();
      }
    }
    function renderCmdPalette(q = '') {
      const list = document.getElementById('cmdPaletteList');
      q = q.toLowerCase();
      filteredCmds = COMMANDS.filter(c => c.name.toLowerCase().includes(q) || c.hint.toLowerCase().includes(q));
      cmdIndex = 0;
      list.innerHTML = filteredCmds.map((c, i) => `
        <div class="cmd-item ${i === 0 ? 'selected' : ''}" onclick="executeCmd(${i})">
          <span>${c.name}</span>
          <span class="hint">${c.hint}</span>
        </div>
      `).join('');
    }
    function handleCmdPaletteKey(e) {
      if (e.key === 'Escape') return toggleCmdPalette();
      const tilingEl = document.getElementById('advTilingLayout');
      if (tilingEl) tilingEl.addEventListener('change', (e) => {
        ws.send(JSON.stringify({ type: 'set-tiling-layout', data: { value: e.target.value } }));
        saveUIState();
      });

      document.getElementById('advEnableVerification').addEventListener('change', (e) => {
        // ...
      });

      if (e.key === 'ArrowDown') { e.preventDefault(); cmdIndex = Math.min(cmdIndex + 1, filteredCmds.length - 1); updateCmdSelection(); return; }
      if (e.key === 'ArrowUp') { e.preventDefault(); cmdIndex = Math.max(cmdIndex - 1, 0); updateCmdSelection(); return; }
      if (e.key === 'Enter') { e.preventDefault(); executeCmd(cmdIndex); return; }
      renderCmdPalette(e.target.value);
    }
    function updateCmdSelection() {
      const items = document.querySelectorAll('#cmdPaletteList .cmd-item');
      items.forEach((it, i) => it.classList.toggle('selected', i === cmdIndex));
      items[cmdIndex]?.scrollIntoView({ block: 'nearest' });
    }
    function executeCmd(i) {
      const cmd = filteredCmds[i];
      if (cmd) {
        cmd.action();
        toggleCmdPalette();
      }
    }

    document.addEventListener('keydown', (e) => {
      if (e.ctrlKey && e.key === 'k') {
        e.preventDefault();
        toggleCmdPalette();
      }
      if (e.target.matches('input, select, textarea')) return;
      if (e.key === 'Escape') {
        const lb = document.getElementById('ssLightbox');
        if (lb && lb.style.display === 'flex') closeLightbox();
      }
    });

    document.addEventListener('change', (e) => {
      if (e.target.matches('input, select, textarea')) {
        saveUIState();
      }
    });

    function getUIConfig() {
      return {
        targets: [
          document.getElementById('targetJoe')?.checked ? 'joe' : null,
          document.getElementById('targetIgnition')?.checked ? 'ignition' : null
        ].filter(Boolean),
        concurrency: parseInt(document.getElementById('advConcurrency')?.value || '1'),
        proxyPool: document.getElementById('advProxyPool')?.value || 'auto',
        backend: document.getElementById('backendSelect')?.value || 'stealth',
        tilingLayout: document.getElementById('advTilingLayout')?.value || 'grid-2x2',
        inputMode: document.getElementById('advInputMode')?.value || 'instant',
        fpStrategy: document.getElementById('advFpStrategy')?.value || 'auto',
        recordVideo: document.getElementById('advRecordVideo')?.checked || false,
        enableTracing: document.getElementById('advEnableTracing')?.checked || false,
        enableCacheInjection: document.getElementById('advCacheInjection')?.checked || false,
        enableVerification: document.getElementById('advEnableVerification')?.checked || false,
        injectStealthJS: document.getElementById('advInjectStealthJS')?.checked ?? true,
        postLoadDelay: 0,
        maxRetries: parseInt(document.getElementById('advMaxRetries')?.value || '2') || 2,
        parallelSites: document.getElementById('advTestingMode')?.value === 'parallel',
        mutateOnRetry: document.getElementById('advMutateOnRetry')?.checked || false,
        proxyRotateUrl: document.getElementById('advProxyRotateUrl')?.value || '',
        manualCaptchaMode: document.getElementById('advManualCaptchaMode')?.checked || false,
        emulateMobile: document.getElementById('advEmulateMobile')?.checked || false
      };
    }

    function updateTilingVisibility(val) {
      const container = document.getElementById('tilingLayoutContainer');
      const layoutSelect = document.getElementById('advTilingLayout');
      if (!container || !layoutSelect) return; // elements removed in UI redesign
      const isHeaded = val && (val.includes('headed') || val === 'spider-local' || val === 'rotate-backends');
      if (isHeaded) {
        layoutSelect.disabled = false;
        container.classList.remove('disabled');
        container.style.opacity = '1';
      } else {
        layoutSelect.disabled = true;
        container.classList.add('disabled');
        container.style.opacity = '0.4';
      }

      // Re-enforce compatibility rules after preset application
      enforceSettingsCompatibility();
    }
    // Initialize state
    setTimeout(() => updateTilingVisibility(document.getElementById('backendSelect').value), 100);
    let ws, credentials = [], rows = [], isRunning = false, isPaused = false, selectedEmails = new Set(), targets = ['joe', 'ignition'];
    const latestScreenshots = {}, screenshotFeeds = {};
    /* ── Server capability flags (populated on init) ── */
    let serverCaps = { disabledBackends: [], hasSpiderKey: false, hasSpiderLocalKey: false, hasVerificationKey: false };
    const alertAudio = new Audio("data:audio/wav;base64,UklGRvQHAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YdAHAACAq9Dt/P3v066DWDIUBAIOKU14o8rp+/7y2baLYDgZBgELI0Zwm8Tk+P72372TaD8eCAEIHj9ok73f9v745MSbcEYjCwEGGThgi7bZ8v776cqjeE0pDgIEFDJYg67T7/387dCrf1QvEgMCECxRfKfN6/v98dayh1w1FgQBDSZJdJ/H5vn+9Ny5j2Q7GwcBCSBCbJfA4ff/9+HAl2xCIAkBBxs7ZI+53PT++ebHn3RJJg0BBBY1XIey1vH9++vNp3xRLBACAxIvVICr0O38/e/TroNYMhQEAg4pTXijyun7/vLZtotgOBkGAQ==");

    let commandQueue = [];
    let isWsConnected = false;
    function sendWsMessage(msgObj) {
      if (isWsConnected && ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify(msgObj));
      } else {
        commandQueue.push(msgObj);
        addLog('WARN', 'Offline: queued command ' + msgObj.type);
      }
    }

    function flushCommandQueue() {
      if (commandQueue.length > 0) {
        addLog('INFO', `Flushing ${commandQueue.length} queued command(s)`);
        while (commandQueue.length > 0) {
          const msg = commandQueue.shift();
          ws.send(JSON.stringify(msg));
        }
      }
    }

    let reconnectDelay = 1000;
    
    // Set up Server-Sent Events (SSE) ONCE (outside connect to prevent leaks on WS reconnect)
    const sse = new EventSource('/events');
    sse.onmessage = (e) => {
      try {
        const m = JSON.parse(e.data);
        handleMessage(m);
      } catch(err) {
        console.error("SSE parse error", err);
      }
    };
    sse.onerror = (err) => {
      console.error("SSE Error:", err);
    };

    function connect() { 
      const p = location.protocol === 'https:' ? 'wss' : 'ws'; 
      ws = new WebSocket(`${p}://${location.host}`); 
      
      ws.onopen = () => {
        isWsConnected = true;
        reconnectDelay = 1000;
        addLog('INFO', 'Connected to WebSocket'); 
        flushCommandQueue();
        sendWsMessage({ type: 'get-state' });
        sendWsMessage({ type: 'get-config' });
      };
      
      ws.onmessage = (e) => { 
        const m = JSON.parse(e.data); 
        handleMessage(m);
      }; 
      
      ws.onclose = () => {
        isWsConnected = false;
        setTimeout(connect, reconnectDelay);
        reconnectDelay = Math.min(reconnectDelay * 2, 30000); // Backoff to 30s
      };
    }

    function handleMessage(m) {
      switch (m.type) { 
        case 'init': handleInit(m.data); break; 
        case 'engine-paused-state': handleEnginePausedState(m.data); break;
        case 'row-update': handleRowUpdate(m.data); break; 
        case 'log': addLog(m.data.level, m.data.message); break; 
        case 'vitals': handleVitals(m.data); break; 
        case 'started': setRunningState(true); checkAnalysisButton(m.data); { const bp = document.getElementById('batchSummaryPanel'); if (bp) bp.style.display = 'block'; } break; 
        case 'complete': setRunningState(false); addLog('INFO', 'Run complete'); break; 
        case 'stopping': setRunningState(false); addLog('INFO', 'Stopping...'); break; 
        case 'experimental-stats': renderAnalysisStats(m.data); sendWsMessage({ type: 'get-recommended-settings' }); break; 
        case 'rotation-stats': renderAnalysisStats(m.data); break;
        case 'rotation-backend-eliminated':
          if (m.data) {
            addLog('WARN', `🔄 [${m.data.mode}] Eliminating backend: ${m.data.backend} (Blocks: ${m.data.blocks}/${m.data.threshold}, Fails: ${m.data.fails}/${m.data.threshold})`);
          }
          break;
        case 'rotation-report':
          if (m.data) {
            addLog('ERR', `🔄🔴 ROTATION REPORT: All ${m.data.totalBackendsTested} backends eliminated in ${m.data.mode} after ${m.data.totalAttempts} attempts`);
            if (m.data.backends) {
              for (const b of m.data.backends) {
                const status = b.attempts === 0 ? '⚪ UNTESTED' : (b.decisive > 0 ? '🟢 HAD SUCCESSES' : '🔴 ELIMINATED');
                addLog('INFO', `  🔄 ${b.backend}: ${status} — ${b.attempts} attempts, ${b.decisive} decisive, ${b.blocks} blocks, ${b.fails} fails (${b.successRate}% success)`);
              }
            }
            if (m.data.recommendations) {
              for (const rec of m.data.recommendations) {
                addLog('WARN', `  🔄 ${rec}`);
              }
            }
            if (m.data.backends && typeof renderAnalysisStats === 'function') {
              renderAnalysisStats(m.data.backends);
            }
          }
          break;
        case 'rotation-auto-fixes':
          if (m.data && m.data.fixes) {
            addLog('WARN', `⚡ AUTO-FIX: Applying ${m.data.fixes.length} remediation strategies for ${m.data.mode}...`);
            for (const fix of m.data.fixes) {
              addLog('INFO', `  🔧 ${fix}`);
            }
          }
          break;
        case 'darwin-report': {
          // Display Darwin diagnostic report
          if (m.data) {
            addLog('ERR', `🦎🔴 DARWIN REPORT: All ${m.data.totalBackendsTested} backends eliminated after ${m.data.totalAttempts} total attempts (${Math.round((m.data.totalDurationMs || 0) / 1000)}s total)`);
            // Show per-backend results
            if (m.data.backends) {
              for (const b of m.data.backends) {
                const status = b.attempts === 0 ? '⚪ UNTESTED' : (b.decisive > 0 ? '🟢 HAD SUCCESSES' : '🔴 ELIMINATED');
                addLog('INFO', `  🦎 ${b.backend}: ${status} — ${b.attempts} attempts, ${b.decisive} decisive, ${b.blocks} blocks, ${b.fails} fails (${b.successRate}% success, avg ${b.avgDurationMs}ms)`);
              }
            }
            // Show recommendations
            if (m.data.recommendations) {
              for (const rec of m.data.recommendations) {
                addLog('WARN', `  🦎 ${rec}`);
              }
            }
            // Also render in analysis stats if handler exists
            if (m.data.backends && typeof renderAnalysisStats === 'function') {
              renderAnalysisStats(m.data.backends);
            }
          }
          break;
        }
        case 'concurrency': case 'concurrency-reset': if (m.data && m.data.value !== undefined) { const el = document.getElementById('advConcurrency'); if (el) el.value = m.data.value; if (m.data.message) addLog('INFO', m.data.message); } break; 
        case 'input-mode': if (m.data && m.data.value !== undefined) { const el = document.getElementById('advInputMode'); if (el) el.value = m.data.value; } break; 
        case 'config-sync':
        case 'config': if (m.data && m.data.config) { const c = m.data.config; if (c.concurrency !== undefined) { const el = document.getElementById('advConcurrency'); if (el) el.value = c.concurrency; } if (c.proxyPool !== undefined) { const el = document.getElementById('advProxyPool'); if (el) el.value = c.proxyPool; } if (c.mode !== undefined) { const el = document.getElementById('advInputMode'); if (el) el.value = c.mode; } if (c.backend !== undefined) { const el = document.getElementById('backendSelect'); if (el) el.value = c.backend; } if (c.fpStrategy !== undefined) { const el = document.getElementById('advFpStrategy'); if (el) el.value = c.fpStrategy; } if (c.useHttpCloak !== undefined) { const h = document.getElementById('advUseHttpCloak'); if (h) h.checked = c.useHttpCloak; } if (c.stealthBypassHttpCloak !== undefined) { const b = document.getElementById('advStealthBypass'); if (b) b.checked = c.stealthBypassHttpCloak; } if (c.injectStealthJS !== undefined) { const s = document.getElementById('advInjectStealthJS'); if (s) s.checked = c.injectStealthJS; } if (c.enableCacheInjection !== undefined) { const ci = document.getElementById('advCacheInjection'); if (ci) ci.checked = c.enableCacheInjection; } if (c.emulateMobile !== undefined) { const em = document.getElementById('advEmulateMobile'); if (em) em.checked = c.emulateMobile; } if (c.mullvadSessionMode !== undefined) { const el = document.getElementById('advMullvadMode'); if (el) el.value = c.mullvadSessionMode; } if (c._optimalPreviewBackend && c._isMultiBackend) { addLog('INFO', '🔧 Multi-backend mode: UI shows optimal settings for ' + c._optimalPreviewBackend + '. Each backend auto-applies its own optimal config at launch.'); } else if (c._optimalPreviewBackend) { addLog('INFO', '⚡ Auto-applied optimal settings for ' + c._optimalPreviewBackend); } } enforceSettingsCompatibility(); break; 
        case 'tiling-layout': {
          const el = document.getElementById("advTilingLayout");
          if (el) el.value = m.data.value;
          break;
        }
        case 'cache-injection': if (m.data && m.data.value !== undefined) { const el = document.getElementById('advCacheInjection'); if (el) el.checked = m.data.value; } break; 
        case 'record-video': if (m.data && m.data.value !== undefined) { const el = document.getElementById('advRecordVideo'); if (el) el.checked = m.data.value; } break; 
        case 'enable-tracing': if (m.data && m.data.value !== undefined) { const el = document.getElementById('advEnableTracing'); if (el) el.checked = m.data.value; } break; 
        case 'post-load-delay': break; /* advPostLoadDelay element removed (deprecated) */
        case 'enable-verification': if (m.data && m.data.value !== undefined) { const el = document.getElementById('advEnableVerification'); if (el) el.checked = m.data.value; } break; 
        case 'credentials': if (m.data && m.data.credentials) { credentials = m.data.credentials; renderTable(); updateStats(); renderQueue(); } break; 
        case 'rows-deleted': if (m.data && m.data.emails) { const d = new Set(m.data.emails.map(e => e.toLowerCase())); const nc = [], nr = []; for (let i = 0; i < credentials.length; i++) { if (!d.has(credentials[i].email.toLowerCase())) { nc.push(credentials[i]); nr.push(rows[i]); } else { selectedEmails.delete(credentials[i].email); } } credentials = nc; rows = nr; renderTable(); updateStats(); updateSelectedCount(); addLog('INFO', m.data.message || 'Rows deleted'); } break; 
        case 'screenshot': if (m.data) handleScreenshotEvent(m.data); if (m.data && m.data.message) addLog('INFO', m.data.message); break; 
        case 'screenshot-error': case 'ai-verification': case 'screenshot-queue-pressure': if (m.data && m.data.message) addLog(m.type === 'screenshot-error' ? 'ERR' : 'INFO', m.data.message); break; 
        case 'benchmark-update': if (m.data) renderRaceLeaderboard(m.data); break; 
        case 'hermes-status': updateHermesUI(m.data); break; 
        case 'hermes-alert': if (m.data) { addLog('ERR', `[HERMES ${m.data.level}] ${m.data.message}`); updateHermesUI({ ...hermesData, alerts: (hermesData.alerts || 0) + 1 }); } break; 
        case 'observer-stats': if (m.data) { handleObserverStats(m.data); } break;
        case 'observer-batch-analysis': if (m.data) { handleObserverBatchAnalysis(m.data); } break;
        case 'observer-proposals': if (m.data) { handleObserverProposals(m.data); } break;
        case 'tempdisabled-categories': handleTempDisabled(m.data); break;
        case 'proxy-health-update': updateSocks5Badge(m.data); break;
        case 'batch-stats': handleBatchStats(m.data); break;
        case 'concurrency-live': handleConcurrencyLive(m.data); break;
        case 'recommended-settings': if (m.data) addLog('INFO', `⚡ Recommended settings: backend=${m.data.backend}, concurrency=${m.data.concurrency}`); break;
        case 'fp-audit-update': handleFpAudit(m.data); break;
        case 'error': addLog('ERR', m.data.message || 'Unknown error'); break; 
      }
    }

    function handleFpAudit(data) {
      if (!data) return;
      const panel = document.getElementById('fpAuditPanel');
      if (panel) panel.style.display = '';
      
      // Round
      const roundEl = document.getElementById('fpRound');
      if (roundEl) roundEl.textContent = data.round || '?';

      // Backend cards
      const grid = document.getElementById('fpAuditGrid');
      if (grid && data.scored) {
        grid.innerHTML = data.scored.map(s => {
          const cls = s.score <= 5 ? 'fp-good' : s.score <= 15 ? 'fp-warn' : 'fp-bad';
          const cohBadge = s.coherent 
            ? '<span class="fp-coherent-badge ok">COHERENT</span>'
            : '<span class="fp-coherent-badge fail">' + (s.issues?.length || 0) + ' ISSUES</span>';
          const issuesHtml = s.issues?.length 
            ? '<div class="fp-issues-list">' + s.issues.map(i => '• ' + i).join('<br>') + '</div>' 
            : '';
          return `<div class="fp-backend-card ${cls}">
            <div class="fp-backend-name">${s.backend}</div>
            <div class="fp-score-row">
              <div class="fp-score-val">${s.score}</div>
              ${cohBadge}
            </div>
            <div class="fp-hash-row">FPJS: <span>${s.fpjsHash || 'FAIL'}</span></div>
            <div class="fp-hash-row">TM: <span>${s.thumbmarkHash || 'FAIL'}</span></div>
            ${issuesHtml}
          </div>`;
        }).join('');
      }

      // Summary
      if (data.bestScore !== undefined) {
        const b = document.getElementById('fpBest');
        const a = document.getElementById('fpAvg');
        const w = document.getElementById('fpWorst');
        const u = document.getElementById('fpUnique');
        const c = document.getElementById('fpCoherent');
        if (b) b.textContent = data.bestScore;
        if (a) a.textContent = data.avgScore;
        if (w) w.textContent = data.worstScore;
        if (u) u.textContent = (data.uniqueHashes?.fpjs || 0) + ' / ' + (data.uniqueHashes?.thumbmark || 0);
        if (c) { c.textContent = data.allCoherent ? 'ALL ✅' : 'ISSUES ⚠️'; c.className = data.allCoherent ? 'fp-sum-good' : 'fp-sum-val'; }
      }

      // History sparkline
      const histBar = document.getElementById('fpHistoryBar');
      if (histBar && data.historyScores) {
        const maxScore = Math.max(...data.historyScores.map(h => h.worst), 30);
        histBar.innerHTML = data.historyScores.slice(-30).map(h => {
          const pct = Math.max(4, Math.round((h.avg / maxScore) * 100));
          const color = h.avg <= 5 ? 'var(--green)' : h.avg <= 15 ? 'var(--amber)' : 'var(--red)';
          return `<div class="fp-history-col" style="height:${pct}%;background:${color};" title="R${h.round}: avg=${h.avg}"></div>`;
        }).join('');
      }

      addLog('INFO', `[FP-AUDIT] Round ${data.round}: best=${data.bestScore} avg=${data.avgScore} worst=${data.worstScore}`);

      // ── Analytics Tab: Fingerprint Scorecard ──
      if (data.scored) {
        const grid = document.getElementById('fpScorecardGrid');
        if (grid) {
          grid.innerHTML = data.scored.map(s => {
            const score = s.score ?? 99;
            const fpcom = s.fpComScore;
            const bgColor = score <= 5 ? 'rgba(63,185,80,0.15)' : score <= 15 ? 'rgba(210,153,34,0.15)' : 'rgba(248,81,73,0.15)';
            const borderColor = score <= 5 ? 'rgba(63,185,80,0.4)' : score <= 15 ? 'rgba(210,153,34,0.4)' : 'rgba(248,81,73,0.4)';
            const scoreColor = score <= 5 ? '#3fb950' : score <= 15 ? '#d29922' : '#f85149';
            const emoji = score <= 5 ? '🟢' : score <= 15 ? '🟡' : '🔴';
            const isMobile = s.mobile ? '📱' : '🖥️';
            const cohIcon = s.coherent ? '✅' : '⚠️';
            const fpComHtml = fpcom !== null && fpcom !== undefined ? `<div style="font-size:10px;color:var(--text2);margin-top:4px;">FP.com Suspect: <b style="color:${fpcom <= 10 ? '#3fb950' : fpcom <= 30 ? '#d29922' : '#f85149'}">${fpcom}</b></div>` : '';
            const barPct = Math.min(100, Math.max(2, score * 2));

            return `<div style="background:${bgColor};border:1px solid ${borderColor};border-radius:8px;padding:12px;transition:all 0.2s;">
              <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px;">
                <span style="font-size:12px;font-weight:600;color:var(--text);">${isMobile} ${s.backend}</span>
                <span style="font-size:11px;color:var(--text3);">${s.strategy || 'optimal'}</span>
              </div>
              <div style="display:flex;align-items:baseline;gap:6px;margin-bottom:4px;">
                <span style="font-size:24px;font-weight:700;color:${scoreColor};">${score}</span>
                <span style="font-size:10px;color:var(--text3);">local score</span>
                <span style="font-size:14px;margin-left:auto;">${emoji}</span>
              </div>
              <div style="height:4px;background:rgba(255,255,255,0.1);border-radius:2px;overflow:hidden;margin-bottom:6px;">
                <div style="height:100%;width:${100 - barPct}%;background:${scoreColor};border-radius:2px;transition:width 0.3s;"></div>
              </div>
              ${fpComHtml}
              <div style="display:flex;gap:8px;font-size:9px;color:var(--text3);margin-top:4px;">
                <span>FPJS: ${s.fpjsHash ? s.fpjsHash.substring(0, 8) : 'FAIL'}</span>
                <span>TM: ${s.thumbmarkHash ? s.thumbmarkHash.substring(0, 8) : 'FAIL'}</span>
                <span>${cohIcon}</span>
              </div>
            </div>`;
          }).join('');
        }
      }
    }

    function handleConcurrencyLive(data) {
      if (!data || data.value === undefined) return;
      // Update the settings panel input to reflect actual live value
      const el = document.getElementById('advConcurrency');
      if (el) el.value = data.value;
      // Update the gauge in the config strip
      renderConcGauge(data.active || 0, data.value, data.throttled || false);
      // Update batch summary concurrency if visible
      const bsEl = document.getElementById('bsLiveConc');
      if (bsEl) bsEl.textContent = String(data.value);
      if (data.reason) {
        addLog('INFO', `⚡ Concurrency auto-adjusted to ${data.value} (${data.reason})`);
      }
    }

    let _lastConcMax = 0;
    function renderConcGauge(active, max, throttled) {
      _lastConcMax = max;
      const text = document.getElementById('concGaugeText');
      const bar = document.getElementById('concGaugeBar');
      const gauge = document.getElementById('concGauge');
      if (!text || !bar) return;
      text.textContent = active + '/' + max;
      gauge.classList.toggle('throttled', throttled);
      let html = '';
      for (let i = 0; i < max; i++) {
        const cls = i < active ? 'filled' : 'empty';
        html += '<span class="conc-gauge-seg ' + cls + '"></span>';
      }
      bar.innerHTML = html;
    }

    function handleBatchStats(d) {
      if (!d) return;
      const panel = document.getElementById('batchSummaryPanel');
      if (panel) panel.style.display = 'block';
      // Update stat boxes
      const set = (id, v) => { const el = document.getElementById(id); if (el) el.textContent = String(v ?? 0); };
      set('bsTotal', d.total);
      set('bsCompleted', d.completed);
      set('bsActive', d.active);
      set('bsQueued', d.queued);
      set('bsSuccess', d.success);
      set('bsBlocked', d.blocked);
      set('bs2FA', d.twofa);
      set('bsFail', d.fail);
      // Elapsed time
      const mins = Math.floor((d.elapsed || 0) / 60);
      const secs = (d.elapsed || 0) % 60;
      set('bsElapsed', mins > 0 ? `${mins}m${secs}s` : `${secs}s`);
      // Live concurrency with mismatch highlighting
      const concEl = document.getElementById('bsLiveConc');
      const concMeta = document.getElementById('bsConcurrencyMeta');
      if (concEl) {
        const live = d.liveConcurrency ?? d.targetConcurrency;
        const target = d.targetConcurrency;
        const mismatch = live !== target;
        concEl.textContent = mismatch ? `${live} / ${target}` : String(live);
        if (concMeta) concMeta.className = mismatch ? 'batch-meta conc-mismatch' : 'batch-meta';
      }
      // Rate (completed per minute)
      const elapsedMin = (d.elapsed || 1) / 60;
      const rate = d.completed > 0 ? (d.completed / elapsedMin).toFixed(1) : '0';
      set('bsRate', `${rate}/min`);
      // Progress bar
      const pct = d.total > 0 ? Math.round((d.completed / d.total) * 100) : 0;
      set('bsProgress', `${pct}%`);
      const bar = document.getElementById('bsProgressBar');
      if (bar) bar.style.width = `${pct}%`;
    }

    function updateSocks5Badge(proxies) {
      const badge = document.getElementById('socks5Badge');
      if (!badge) return;
      const isSocks5Active = proxies && proxies.some(p => p.server && p.server.startsWith('socks5://'));
      if (isSocks5Active) {
        badge.style.display = 'flex';
      } else {
        badge.style.display = 'none';
      }
    }

    let tempDisabledData = [];
    function handleTempDisabled(categories) {
      tempDisabledData = categories;
      renderTempDisabled();
    }
    
    function renderTempDisabled() {
      const container = document.getElementById('tempDisabledContainer');
      if (!container) return;
      if (!tempDisabledData || tempDisabledData.length === 0) {
        container.innerHTML = '<div style="color: var(--text3); font-style: italic;">No temporarily disabled accounts found.</div>';
        return;
      }
      
      let html = '';
      tempDisabledData.forEach(cat => {
        html += `
          <div style="background: rgba(0,0,0,0.4); border: 1px solid rgba(251, 191, 36, 0.2); border-radius: 8px; overflow: hidden;">
            <div style="background: rgba(251, 191, 36, 0.1); padding: 10px 15px; border-bottom: 1px solid rgba(251, 191, 36, 0.15); display: flex; justify-content: space-between; align-items: center;">
              <strong style="color: var(--amber); font-family: 'Outfit';">${cat.error}</strong>
              <span class="badge" style="background: var(--amber); color: #000; font-weight: bold; border-radius: 12px; padding: 2px 8px; font-size: 11px;">${cat.count}</span>
            </div>
            <div style="padding: 10px;">
              <table style="width: 100%; border-collapse: collapse; font-size: 12px; font-family: 'JetBrains Mono', monospace;">
                <thead>
                  <tr style="color: var(--text3); border-bottom: 1px solid var(--border); text-align: left;">
                    <th style="padding: 6px;">Email</th>
                    <th style="padding: 6px;">Target Site</th>
                    <th style="padding: 6px;">Timestamp</th>
                  </tr>
                </thead>
                <tbody>
        `;
        cat.results.forEach(r => {
          const dateStr = new Date(r.timestamp + 'Z').toLocaleString();
          html += `
            <tr style="border-bottom: 1px solid rgba(255,255,255,0.02);">
              <td style="padding: 6px; color: var(--text);">${r.email}</td>
              <td style="padding: 6px; color: var(--cyan);">${r.target_site}</td>
              <td style="padding: 6px; color: var(--text2);">${dateStr}</td>
            </tr>
          `;
        });
        html += `
                </tbody>
              </table>
            </div>
          </div>
        `;
      });
      container.innerHTML = html;
    }

    function handleRowUpdate(d) { const gi = rows.findIndex(r => r.email === d.email); if (gi !== -1) { rows[gi] = d; renderRowInPlace(gi); } trackTempDisabled(d.email, d); updateStats(); pushSuccessRateDataPoint(); updateCostDashboard(); if (d.email && d.recordingUrl && screenshotFeeds[d.email.toLowerCase()]) renderLiveView(); const rt = document.getElementById('tab-results'); if (rt && rt.classList.contains('active')) renderResults(); const ct = document.getElementById('tab-credentials'); if (ct && ct.classList.contains('active')) renderCredentialsTab(); if (document.hidden && d.sites) { if (Object.values(d.sites).some(s => s.outcome === 'permdisabled' || s.outcome === 'noaccount')) alertAudio.play().catch(() => { }); } }

    function handleScreenshotEvent(s) { if (!s || !s.email) return; const k = s.email.toLowerCase(); let url = ''; if (s.base64) url = `data:image/png;base64,${s.base64}`; else if (s.relativePath) { let p = s.relativePath.replace(/^\.?\//, ''); if (!p.startsWith('screenshots/')) p = 'screenshots/' + p.replace(/^.*?screenshots\//, ''); url = '/' + p; } if (!screenshotFeeds[k]) screenshotFeeds[k] = []; screenshotFeeds[k].push({ url, timestamp: s.timestamp || new Date().toISOString(), target: s.target || '', label: s.label || '', email: s.email, backend: s.backend, proxyPool: s.proxyPool, inputMode: s.inputMode, bypass: s.bypass, cloak: s.cloak, concurrency: s.concurrency }); if (screenshotFeeds[k].length > 20) screenshotFeeds[k].shift(); latestScreenshots[k] = { url }; renderLiveView(); }

    function renderLiveView() {
      const g = document.getElementById('liveviewGrid'); if (!g) return;
      g.innerHTML = '';
      // Collect all emails that have screenshots OR are currently testing
      const activeEmails = new Set(Object.keys(screenshotFeeds));
      rows.forEach(r => { if (r.status === 'testing') activeEmails.add(r.email.toLowerCase()); });
      if (!activeEmails.size) { g.innerHTML = '<div class="cyber-empty-state">[SYS.OP] AWAITING TELEMETRY...</div>'; updateLiveViewActiveCount(); return; }
      activeEmails.forEach(ek => {
        const feed = screenshotFeeds[ek] || [];
        const sampleShot = feed.length ? feed[feed.length - 1] : null;
        const em = sampleShot ? sampleShot.email : rows.find(r => r.email.toLowerCase() === ek)?.email || ek;
        const ri = credentials.findIndex(c => c.email.toLowerCase() === ek);
        const rw = ri !== -1 ? rows[ri] : null;
        const status = rw ? (rw.status || 'pending') : 'pending';
        const recUrl = rw && rw.recordingUrl ? rw.recordingUrl : '';
        const isDone = status === 'done';
        const hasSuccess = rw && rw.sites && Object.values(rw.sites).some(s => s.outcome === 'success');
        // Build unified chronologically grouped shots
        const groupedShots = [];
        const map = new Map();
        
        feed.forEach(s => {
          let site = 'other';
          if (s.target === 'joe') site = 'joe';
          else if (s.target === 'ignition' || s.target === 'ign') site = 'ign';
          
          let baseLabel = (s.label || '').replace(/^(joe|ignition|ign):/, '');
          
          if (!map.has(baseLabel)) {
            const entry = { label: baseLabel, idx: groupedShots.length };
            map.set(baseLabel, entry);
            groupedShots.push(entry);
          }
          groupedShots[map.get(baseLabel).idx][site] = s;
        });

        const carouselId = `carousel_${ek}_unified`;
        if (groupedShots.length) {
          carouselData[carouselId] = groupedShots;
        }

        const buildFlipFeed = () => {
          if (!groupedShots.length) return `<div class="feed-site-empty">⏳ awaiting...</div>`;
          return groupedShots.map((g, idx) => {
            const front = g.joe || g.other || g.ign; // fallback
            const back = g.ign || (g.joe && g.other); // If joe is front, ign is back
            
            const hasBoth = back && back !== front;
            const bothClass = hasBoth ? 'has-both' : '';
            
            const backHTML = hasBoth ? `
              <div class="feed-shot-layer layer-back">
                <img src="${ea(back.url)}" alt="">
                <div class="feed-thumbnail-label">IGN: ${ea(g.label)}</div>
              </div>
            ` : '';
            
            return `
            <div class="feed-shot-card ${bothClass}" data-carousel="${carouselId}" data-idx="${idx}" onclick="openDualLightbox('${carouselId}',${idx})" title="${ea(g.label)}">
              <div class="feed-shot-layer layer-front">
                <img src="${ea(front.url)}" alt="">
                <div class="feed-thumbnail-label">${front === g.ign ? 'IGN' : 'JOE'}: ${ea(g.label)}</div>
              </div>
              ${backHTML}
            </div>`;
          }).join('');
        };

        const joeSite = rw && rw.sites ? rw.sites['joe'] : null;
        const ignSite = rw && rw.sites ? (rw.sites['ignition'] || rw.sites['ign']) : null;
        const el = document.createElement('div');
        el.className = 'credential-feed-row' + (hasSuccess ? ' row-success' : '') + (isDone && !hasSuccess ? ' row-done' : '');
        const joeOutcome = joeSite ? joeSite.outcome : '—';
        const ignOutcome = ignSite ? ignSite.outcome : '—';
        
        const headerHTML = `<div class="feed-site-col unified-col" style="flex: 1; border-right: none;">
          <div class="feed-site-header" style="justify-content: flex-start; gap: 12px; flex-wrap: wrap;">
            <div class="feed-site-detail" style="display:flex; flex-wrap:wrap; gap:6px;">
              <span class="feed-site-name unified" style="color:var(--cyan); letter-spacing: 2px;">SYNC TIMELINE</span>
              <span class="badge badge-${co(joeOutcome)}">J: ${joeOutcome}</span>
              <span class="badge badge-${co(ignOutcome)}">I: ${ignOutcome}</span>
              ${sampleShot?.backend ? `<span class="badge badge-pending" style="opacity:0.8; font-family: monospace;">${ea(sampleShot.backend)}</span>` : ''}
              ${sampleShot?.proxyPool ? `<span class="badge badge-pending" style="opacity:0.8; font-family: monospace;">proxy:${ea(sampleShot.proxyPool)}</span>` : ''}
              ${sampleShot?.concurrency ? `<span class="badge badge-pending" style="opacity:0.8; font-family: monospace;">c${ea(sampleShot.concurrency)}</span>` : ''}
              ${rw?.runContext?.ipAddress ? `<span class="badge badge-pending" style="background:rgba(255,255,255,0.05); color:#a0aab2; border-color:rgba(255,255,255,0.1); font-family:monospace;" title="Assigned IP Address">IP: ${ea(rw.runContext.ipAddress)}</span>` : ''}
              ${rw?.runContext?.deviceType ? `<span class="badge badge-pending" style="background:rgba(255,255,255,0.05); color:#a0aab2; border-color:rgba(255,255,255,0.1);" title="Device Type">📱 ${ea(rw.runContext.deviceType)}</span>` : ''}
              ${rw?.runContext?.fingerprintInfo ? `<span class="badge badge-pending" style="background:rgba(255,255,255,0.05); color:#a0aab2; border-color:rgba(255,255,255,0.1);" title="Fingerprint Details">🔍 ${ea(rw.runContext.fingerprintInfo)}</span>` : ''}
              ${rw?.aiVerified?.verified ? `<span class="badge" style="background:rgba(16,185,129,0.15); color:#10b981; border:1px solid rgba(16,185,129,0.3);" title="Vertex AI Video Verified">✨ AI Verified</span>` : ''}
              ${sampleShot?.inputMode ? `<span class="badge badge-pending" style="opacity:0.8; font-family: monospace;" title="Input Mode Settings">⚙️ ${ea(sampleShot.inputMode)}</span>` : ''}
            </div>
            <div style="flex-grow: 1;"></div>
            ${recUrl ? `<button class="feed-site-rec-btn" onclick="openVideoModal(${ja(recUrl)},${ja(em)})">🎬 VOD</button>` : ''}
          </div>
          <div class="feed-site-screenshots">${buildFlipFeed()}</div>
        </div>`;

        const pulseClass = isDone ? 'done' : (status === 'testing' ? '' : 'idle');
        const statusLabel = status.toUpperCase() + (isDone ? '' : ' [IN-FLIGHT]');
        el.innerHTML = `<div class="feed-row-header"><div class="feed-row-pulse ${pulseClass}"></div><div class="feed-row-email" title="${ea(em)}">${ea(em)}</div><div class="feed-row-status"><span>${ea(statusLabel)}</span></div><div class="feed-row-actions">${recUrl ? `<button class="btn btn-start btn-sm" onclick="openVideoModal(${ja(recUrl)},${ja(em)})">▶ VOD</button>` : ''}<button class="btn btn-ghost btn-sm" onclick="retestCredential('${ea(em)}',${ri})">🔄</button></div></div><div class="feed-row-body" style="position:relative;">${headerHTML}<div class="screenshot-overlay">[Terminal Logs]\n...${ea(statusLabel)}\nWaiting for stream events...</div></div>`;
        g.prepend(el);
        // Auto-scroll each screenshot strip
        el.querySelectorAll('.feed-site-screenshots').forEach(sc => { sc.scrollLeft = sc.scrollWidth; });
      });
      updateLiveViewActiveCount();
      
      // Update Effective Configuration Matrix
      const matrixEl = document.getElementById('effectiveConfigPreview');
      if (matrixEl) {
        const backend = document.getElementById('backendSelect')?.value || 'stealth';
        const isRotate = backend.startsWith('rotate');
        const isStealth = backend.startsWith('stealth');
        const isCurl = false;
        const httpCloakSupported = backend !== 'spider-local' && backend !== 'spider-rest' && !backend.startsWith('stealth');
        const httpCloakOn = document.getElementById('advUseHttpCloak')?.checked || false;
        const isHeadless = !backend.includes('headed') && backend !== 'spider-local' && backend !== 'rotate-backends';

        let summary = `[ACTIVE BACKEND]: ${backend.toUpperCase()}` + '\n';
        if (isRotate) summary += `[WARNING]: UI selections for proxies, stealth, and mode will be OVERRIDDEN per-session by the ${backend} rotation engine!` + '\n';
        
        summary += '\n--- DEPENDENCIES ---\n';
        summary += `HttpCloak: ${httpCloakSupported ? (httpCloakOn ? 'ENABLED' : 'DISABLED') : 'LOCKED (Unsupported)'}` + '\n';
        summary += `JS Stealth Injection: ${!isStealth && !isCurl && backend !== 'spider-rest' ? (document.getElementById('advInjectStealthJS')?.checked ? 'ENABLED' : 'DISABLED') : 'LOCKED (Unsupported / Native Camoufox)'}` + '\n';
        
        summary += '\n--- PERFORMANCE ---\n';
        const concurrency = document.getElementById('advConcurrency')?.value || 1;
        summary += `Concurrency: ${concurrency} threads` + '\n';
        if (concurrency > 10 && !isHeadless) summary += `[RISK]: ${concurrency} headed instances may cause out-of-memory crashes.` + '\n';
        
        matrixEl.textContent = summary;
      }

      syncConfigStrip();
    }

    function clearAllLiveViewSlots() { for (const k in screenshotFeeds) delete screenshotFeeds[k]; renderLiveView(); }
    function updateLiveViewActiveCount() { const c = Object.keys(screenshotFeeds).length; const el = document.getElementById('liveviewActiveCount'); if (el) el.textContent = String(c); }

    function syncConfigStrip() {
      const set = (id, val) => { const el = document.getElementById(id); if (el) el.textContent = val || '—'; };
      set('cfgBackend', document.getElementById('backendSelect')?.value);
      set('cfgProxy', document.getElementById('advProxyPool')?.value);
      // Render concurrency gauge instead of flat text
      const concVal = parseInt(document.getElementById('advConcurrency')?.value || '5');
      renderConcGauge(0, concVal, false);
      set('cfgInput', document.getElementById('advInputMode')?.value);
      set('cfgFpStrategy', document.getElementById('advFpStrategy')?.value);
      const targets = [];
      if (document.getElementById('targetJoe')?.checked) targets.push('Joe');
      if (document.getElementById('targetIgnition')?.checked) targets.push('Ign');
      set('cfgTargets', targets.join(' + ') || 'None');
      set('cfgVideo', document.getElementById('advRecordVideo')?.checked ? 'ON' : 'OFF');
      set('cfgMode', document.getElementById('advTestingMode')?.value === 'parallel' ? 'Parallel' : 'Sequential');
    }

    function switchTab(id) {
  document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
  document.querySelectorAll('.nav-item').forEach(t => t.classList.remove('active'));
  document.querySelectorAll('.nav-tab').forEach(t => t.classList.remove('active'));
  const tabEl = document.getElementById('tab-' + id);
  if (tabEl) tabEl.classList.add('active');
  document.querySelectorAll('.nav-item').forEach(n => {
    if (n.getAttribute('data-tab') === id) n.classList.add('active');
  });
  document.querySelectorAll('.nav-tab').forEach(n => {
    if (n.getAttribute('onclick')?.includes(id)) n.classList.add('active');
  });
  if (id === 'results') renderResults();
  if (id === 'liveview') renderLiveView();
  if (id === 'credentials') renderCredentialsTab();
  if (id === 'tempdisabled' && typeof renderTempDisabledTab === 'function') renderTempDisabledTab();
  if (id === 'analytics') { if (typeof updateAnalyticsChart === 'function') updateAnalyticsChart(); }
}

    function renderTable() { const b = document.getElementById('credentialList'); if (!b) return; b.innerHTML = credentials.map((_, i) => buildRowHTML(i)).join(''); applyVisibilityFilter(); syncMasterSelectState(); }
    function applyVisibilityFilter() { const q = (document.getElementById('credFilter')?.value || '').toLowerCase(); const of = (document.getElementById('filterOutcome')?.value || 'all'); const tb = document.getElementById('credentialList'); if (!tb) return; let vc = 0; Array.from(tb.children).forEach((tr, i) => { if (!credentials[i]) { tr.style.display = 'none'; return; } const em = !q || credentials[i].email.toLowerCase().includes(q); let om = true; if (of !== 'all') { const r = rows[i]; if (r && r.sites) om = Object.values(r.sites).map(s => s.outcome).includes(of); else om = of === 'queued' || of === 'N/A'; } const v = em && om; tr.style.display = v ? '' : 'none'; if (v) vc++; }); updateFilterCount(vc); }
    function updateFilterCount(v) { const el = document.getElementById('filterCount'); if (!el) return; el.textContent = `${v}/${credentials.length}`; el.classList.toggle('highlight', v !== credentials.length); }
    function buildRowHTML(i) { const c = credentials[i], r = rows[i], em = c.email; const oc = r ? Object.entries(r.sites).map(([n, s]) => `<span class="badge badge-${co(s.outcome)}">${n}</span>`).join(' ') : '—'; const rc = r && r.recordingUrl ? r.recordingUrl : ''; const rb = rc ? `<button class="rec-btn" onclick="openVideoModal(${JSON.stringify(rc)},${JSON.stringify(em)})">🎬</button>` : `<button class="rec-btn disabled">🎬</button>`; return `<tr id="row-${i}" data-email="${ea(em)}"><td><input type="checkbox" onchange="toggleRow('${em}',this.checked)" ${selectedEmails.has(em) ? 'checked' : ''}></td><td class="hide-on-mobile">${i + 1}</td><td style="font-size:11px;">${em}</td><td class="hide-on-mobile">${r ? r.currentBatch + 1 : 1}/${r ? r.totalBatches : '?'}</td><td>${oc}</td><td style="display:flex;gap:3px;align-items:center;"><button class="btn btn-ghost btn-sm" onclick="liveTest('${em}')">Test</button>${rb}<button class="retest-btn" id="retest-${i}" onclick="retestCredential('${ea(em)}',${i})">🔄</button></td></tr>`; }

    function co(o) { return o ? String(o).replace(/[^A-Za-z0-9]/g, '') : 'queued'; }
    function ea(s) { return String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
    function ja(s) { return JSON.stringify(s == null ? '' : s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }

    function cyberCopy(t, l) { if (!t) return; navigator.clipboard?.writeText(String(t)).then(() => showCyberToast(`${l || 'Value'} copied`), () => showCyberToast('Copy failed')); }
    function toggleRunMode(m) { if (!ws || ws.readyState !== WebSocket.OPEN) { showCyberToast('Not connected'); return; } ws.send(JSON.stringify({ type: 'set-mode', mode: m })); showCyberToast(`Mode: ${m}`); }
    function showCyberToast(msg, type) { let t = document.getElementById('cyberToast'); if (!t) { t = document.createElement('div'); t.id = 'cyberToast'; t.className = 'cyber-toast'; document.body.appendChild(t); } t.textContent = msg; t.classList.remove('toast-success'); if (type === 'success') t.classList.add('toast-success'); t.classList.add('visible'); clearTimeout(t._t); t._t = setTimeout(() => t.classList.remove('visible'), 1800); }

    let currentVideoUrl = '', currentVideoAbsPath = '';
    function openVideoModal(r, em) { const b = document.getElementById('videoModalBackdrop'), p = document.getElementById('videoModalPlayer'), t = document.getElementById('videoModalTitle'), pl = document.getElementById('videoPathPill'); let u = r; if (!/^https?:\/\//i.test(u) && !u.startsWith('/')) u = '/' + u.replace(/^\.?\//, ''); if (!u.startsWith('/recordings/') && u.includes('recordings/')) u = '/' + u.replace(/^\/+/, '').replace(/^.*?recordings\//, 'recordings/'); currentVideoUrl = u; currentVideoAbsPath = r; t.textContent = `${em || ''} — ${r.split('/').pop() || 'rec.webm'}`.trim(); pl.textContent = r; p.src = u; p.load(); b.classList.add('active'); setTimeout(() => { try { p.play(); } catch (e) { } }, 50); }
    function closeVideoModal() { const b = document.getElementById('videoModalBackdrop'), p = document.getElementById('videoModalPlayer'); try { p.pause(); } catch (e) { } p.removeAttribute('src'); p.load(); b.classList.remove('active'); }
    function setVideoSize(s) { document.getElementById('videoModal').setAttribute('data-size', s); document.querySelectorAll('.video-size-btn').forEach(b => b.classList.toggle('active', b.textContent.toLowerCase() === s || ({ 'S': 'small', 'M': 'medium', 'L': 'large', 'T': 'theater' }[b.textContent] === s))); }
    function openVideoExternal() { if (currentVideoUrl) window.open(currentVideoUrl, '_blank', 'noopener'); }
    function copyVideoPath() { if (currentVideoAbsPath) navigator.clipboard?.writeText(currentVideoAbsPath).then(() => addLog('INFO', `Copied: ${currentVideoAbsPath}`), () => addLog('WARN', 'Clipboard failed')); }
    document.addEventListener('keydown', (e) => {
      // Close modals on Escape
      if (e.key === 'Escape') {
        const b = document.getElementById('videoModalBackdrop');
        if (b && b.classList.contains('active')) { closeVideoModal(); return; }
        const ko = document.getElementById('kbdOverlay');
        if (ko && ko.classList.contains('visible')) { ko.classList.remove('visible'); return; }
      }
      // Keyboard shortcut overlay: ? key (when not in input)
      if (e.key === '?' && !['INPUT','TEXTAREA','SELECT'].includes(document.activeElement?.tagName)) {
        const ko = document.getElementById('kbdOverlay');
        if (ko) ko.classList.toggle('visible');
        return;
      }
      // Ctrl+digit tab switching
      if (e.ctrlKey && !e.shiftKey && !e.altKey) {
        const tabMap = { '1':'liveview', '2':'dashboard', '3':'credentials', '4':'results', '5':'settings', '6':'terminal', '7':'analytics', '8':'tempdisabled', '9':'hermes' };
        if (tabMap[e.key]) { e.preventDefault(); switchTab(tabMap[e.key]); return; }
        // Ctrl+Enter: toggle engine launch/stop
        if (e.key === 'Enter') {
          e.preventDefault();
          if (isRunning) { sendWsMessage({ type: 'stop' }); }
          else { document.getElementById('btnQuickLaunch')?.click(); }
          return;
        }
        // Ctrl+L: clear terminal
        if (e.key === 'l' || e.key === 'L') {
          e.preventDefault();
          const lb = document.getElementById('logBody');
          if (lb) lb.innerHTML = '';
          return;
        }
        // Ctrl+P: command palette
        if (e.key === 'p' || e.key === 'P') {
          e.preventDefault();
          toggleCmdPalette();
          return;
        }
      }
    });

    let lastStats = [];
    function toggleAnalysisModal() { const m = document.getElementById('analysisModal'), o = document.getElementById('analysisModalOverlay'); if (m.classList.contains('open')) { m.classList.remove('open'); o.classList.remove('open'); } else { m.classList.add('open'); o.classList.add('open'); renderAnalysisStats(lastStats); } }
    function checkAnalysisButton(cfg) { const b = document.getElementById('btnViewAnalysis'); if (b) b.style.display = (cfg.isExperimental || cfg.backend === 'experimental') ? 'inline-flex' : 'none'; }
    function renderAnalysisStats(cfgs) { lastStats = cfgs; if (!cfgs || !Array.isArray(cfgs)) return; const tb = document.getElementById('analysisTbody'); if (!tb) return; tb.innerHTML = ''; cfgs.forEach(c => { const avg = c.totalAttempts > 0 ? (c.totalDurationMs / c.totalAttempts / 1000).toFixed(1) + 's' : '0s'; const st = c.eliminated ? `<span class="badge badge-noaccount">ELIM</span>` : `<span class="badge badge-success">ACTIVE</span>`; let eh = ''; if (c.errors && Object.keys(c.errors).length > 0) eh = Object.entries(c.errors).sort((a, b) => b[1] - a[1]).map(([s, n]) => `<span class="error-chip">${s}:${n}</span>`).join(''); else eh = '<span style="color:var(--text3);font-size:10px">None</span>'; const tr = document.createElement('tr'); if (c.eliminated) { tr.style.opacity = '0.5'; } tr.innerHTML = `<td><strong style="color:#fff">${c.backend}</strong><br><span style="font-size:9px;color:var(--text3)">Pool:${c.proxyPool}</span></td><td>${st}</td><td>${c.totalAttempts}/${c.decisive}</td><td class="mono">${avg}</td><td style="color:${c.blocks >= 2 ? 'var(--red)' : 'inherit'}">${c.blocks}/2</td><td style="color:${c.fails >= 2 ? 'var(--red)' : 'inherit'}">${c.fails}/2</td><td style="max-width:200px;white-space:normal">${eh}</td>`; tb.appendChild(tr); }); }

    function renderRowInPlace(i) { const t = document.getElementById('credentialList'); if (t && t.children[i]) t.children[i].outerHTML = buildRowHTML(i); }
    function renderQueue() { }

    function overrideResultFromUI(email, site, classification) {
      if (!ws || ws.readyState !== WebSocket.OPEN) return;
      ws.send(JSON.stringify({
        type: "define-result",
        data: { email: email, label: site, classification: classification }
      }));
    }

    function renderResults() { const l = document.getElementById('resultsList'); if (!l) return; const res = []; rows.forEach(r => { Object.entries(r.sites).forEach(([n, s]) => { if (s.outcome === 'success' || s.outcome === 'tempdisabled') res.push({ email: r.email, site: n, time: s.timestamp, recordingUrl: r.recordingUrl, attempts: s.attempts, outcome: s.outcome, screenshotUrl: (latestScreenshots[r.email.toLowerCase()] || {}).url || '' }); }); }); document.getElementById('resultsCount').textContent = String(res.length); if (!res.length) { l.innerHTML = '<div class="cyber-empty-state">[ NO RESULTS LOGGED ]</div>'; return; } res.sort((a, b) => (b.time ? new Date(b.time).getTime() : 0) - (a.time ? new Date(a.time).getTime() : 0)); l.innerHTML = res.map(r => { const tm = r.time ? new Date(r.time).toLocaleString() : '—'; const rb = r.recordingUrl ? `<button class="result-play ok" onclick="openVideoModal(${ja(r.recordingUrl)},${ja(r.email)})">▶ Watch</button>` : `<button class="result-play" disabled>No Rec</button>`; const badge = r.outcome === 'success' ? '<span class="result-ok">✓ OK</span>' : '<span class="result-ok" style="background:rgba(251,191,36,0.2);color:var(--amber);border-color:rgba(251,191,36,0.5);">🔒 TEMP DIS</span>'; const actionsHtml = `<div style="display:flex; gap: 5px; margin-top: 10px;"><button class="btn btn-danger btn-sm" style="flex:1;font-size:10px;padding:4px;" onclick="overrideResultFromUI(${ja(r.email)}, ${ja(r.site)}, 'permdisabled')">Perm Disable</button><select class="input" style="flex:1; padding: 2px 5px; height: 24px; font-size: 10px;" onchange="if(this.value) overrideResultFromUI(${ja(r.email)}, ${ja(r.site)}, this.value); this.value=''"><option value="">Correct...</option><option value="success">Success</option><option value="noaccount">No Account</option><option value="tempdisabled">Temp Disabled</option><option value="permdisabled">Perm Disabled</option></select></div>`; return `<div class="result-tile"><div class="result-tile-img">${r.screenshotUrl ? `<img src="${ea(r.screenshotUrl)}" alt="">` : '<div style="height:100%;display:flex;align-items:center;justify-content:center;color:var(--text3);font-size:11px;">No Screenshot</div>'}<div class="result-overlay"><span class="result-id">${ea(r.email)}</span>${badge}</div><div class="cyber-tile-target">${ea(r.site.toUpperCase())}</div><div class="cyber-tile-footer-overlay">${ea(tm)}</div></div><div class="result-body"><div class="result-row"><span class="r-label">Email</span><span class="r-value copyable" onclick="cyberCopy(${ja(r.email)},'Email')">${ea(r.email)}</span></div><div class="result-row"><span class="r-label">Attempts</span><span class="r-value">${r.attempts != null ? r.attempts : '?'}</span></div>${actionsHtml}</div>${rb}</div>`; }).join(''); }

    function updateStats() { 
      let jTotal=0, jSucc=0, j2FA=0, jTemp=0, jPerm=0;
      let iTotal=0, iSucc=0, i2FA=0, iTemp=0, iPerm=0;
      
      rows.forEach(r => {
        let ts = ["joe", "ignition"];
        if (r.target_sites && Array.isArray(r.target_sites)) ts = r.target_sites;
        
        if (ts.includes("joe")) {
          jTotal++;
          const outcome = r.sites && r.sites["joe"] ? r.sites["joe"].outcome : "queued";
          if (outcome === 'success') jSucc++;
          if (outcome === '2FA') j2FA++;
          if (outcome === 'tempdisabled') jTemp++;
          if (outcome === 'permdisabled' || outcome === 'noaccount') jPerm++;
        }
        
        if (ts.includes("ignition")) {
          iTotal++;
          const outcome = r.sites && r.sites["ignition"] ? r.sites["ignition"].outcome : "queued";
          if (outcome === 'success') iSucc++;
          if (outcome === '2FA') i2FA++;
          if (outcome === 'tempdisabled') iTemp++;
          if (outcome === 'permdisabled' || outcome === 'noaccount') iPerm++;
        }
      });
      
      const setStat = (prefix, total, succ, twfa, temp, perm) => {
        // Exclude terminal outcomes to find "Untested". 
        // We consider tempdisabled as NOT untested. It is held for 1 hour then retested.
        const untested = total - (succ + twfa + perm + temp);
        
        const elU = document.getElementById(`stat${prefix}Untested`); if(elU) elU.textContent = untested;
        const elS = document.getElementById(`stat${prefix}Success`); if(elS) elS.textContent = succ;
        const el2 = document.getElementById(`stat${prefix}2FA`); if(el2) el2.textContent = twfa;
        const elT = document.getElementById(`stat${prefix}Tempdisabled`); if(elT) elT.textContent = temp;
        const elP = document.getElementById(`stat${prefix}Permdisabled`); if(elP) elP.textContent = perm;
        
        const bU = document.getElementById(`bar${prefix}Untested`); if(bU) bU.style.width = total ? (untested/total*100)+'%' : '0%';
        const bS = document.getElementById(`bar${prefix}Success`); if(bS) bS.style.width = total ? (succ/total*100)+'%' : '0%';
        const b2 = document.getElementById(`bar${prefix}2FA`); if(b2) b2.style.width = total ? (twfa/total*100)+'%' : '0%';
        const bT = document.getElementById(`bar${prefix}Temp`); if(bT) bT.style.width = total ? (temp/total*100)+'%' : '0%';
        const bP = document.getElementById(`bar${prefix}Perm`); if(bP) bP.style.width = total ? (perm/total*100)+'%' : '0%';
      };
      
      setStat('Joe', jTotal, jSucc, j2FA, jTemp, jPerm);
      setStat('Ign', iTotal, iSucc, i2FA, iTemp, iPerm);
    }

    function filterTerminalLogs() {
      const el = document.getElementById('terminalLogLevel');
      const level = el ? el.value : 'ALL';
      const body = document.getElementById('logBody');
      if (!body) return;
      Array.from(body.children).forEach(line => {
        const isErr = line.querySelector('.ERROR') || line.querySelector('.ERR');
        const isWarn = line.querySelector('.WARN');
        let show = true;
        if (level === 'ERROR' && !isErr) show = false;
        if (level === 'WARN' && !isErr && !isWarn) show = false;
        line.style.display = show ? '' : 'none';
      });
    }

    function addLog(lv, msg) { 
      const b = document.getElementById('logBody'); 
      if (!b) return; 
      const t = new Date().toLocaleTimeString(); 
      const d = document.createElement('div'); 
      d.className = 'log-line'; 
      let color = '#fff';
      if (lv === 'WARN') color = 'var(--amber)';
      if (lv === 'ERROR' || lv === 'ERR') color = 'var(--red)';
      d.innerHTML = `<span style="color:#64748b;">[${t}]</span> <span class="${lv}" style="color:${color};font-weight:bold;">${lv}</span> <span style="color:${color}">${ea(msg)}</span>`; 
      
      const filter = document.getElementById('terminalLogLevel')?.value || 'ALL';
      let show = true;
      if (filter === 'ERROR' && lv !== 'ERROR' && lv !== 'ERR') show = false;
      if (filter === 'WARN' && lv !== 'ERROR' && lv !== 'ERR' && lv !== 'WARN') show = false;
      d.style.display = show ? '' : 'none';

      b.prepend(d); 
      if (b.children.length > 2000) b.lastChild.remove();
      parseCreditLog(msg); 
    }

    function handleVitals(d) {
      const fields = [
        { id: 'vitals-cpu', val: d.load },
        { id: 'vitals-heap', val: d.heap ? d.heap + 'MB' : null },
        { id: 'vitals-rss', val: d.rss ? d.rss + 'MB' : null },
        { id: 'vitals-uptime', val: d.uptime ? d.uptime + 's' : null },
      ];
      for (const f of fields) {
        const el = document.getElementById(f.id);
        if (el && f.val != null) {
          el.classList.remove('vitals-idle');
          el.textContent = f.val;
        }
      }
      // Also update the header bar vitals
      const vc = document.getElementById('vitalsCpu');
      const vr = document.getElementById('vitalsRam');
      if (vc) vc.textContent = d.load;
      if (vr) vr.textContent = d.rss + 'MB';
    }

    function handleInit(d) {
      credentials = d.credentials || [];
      selectedEmails = new Set(credentials.map(c => c.email));
      rows = d.rows || [];
      isRunning = d.isRunning;
      isPaused = !!d.enginePaused;
      updateStats(); renderTable(); renderLiveView(); setRunningState(isRunning);
      if (d.config) {
        const c = d.config;
        // ── Store server capability flags ──
        serverCaps.disabledBackends = Array.isArray(c.disabledBackends) ? c.disabledBackends : [];
        serverCaps.hasSpiderKey = !!c.hasSpiderKey;
        serverCaps.hasSpiderLocalKey = !!c.hasSpiderLocalKey;
        serverCaps.hasVerificationKey = !!c.hasVerificationKey;
        // ── Rebuild backend dropdown (filter disabled, mark unavailable) ──
        rebuildBackendDropdown(c.backend || 'stealth');
        // Core settings — always sync from backend
        if (c.concurrency !== undefined) { const el = document.getElementById('advConcurrency'); if (el) el.value = c.concurrency; }
        if (c.proxyPool !== undefined) {
          // Dynamically rebuild proxy dropdown from server pools
           if (c.proxyPools && Array.isArray(c.proxyPools)) {
            const sel = document.getElementById('advProxyPool');
            if (sel) sel.innerHTML = c.proxyPools.filter(p => p.id !== 'off').map(p => `<option value="${p.id}">${p.label}</option>`).join('');
          }
          const proxyEl = document.getElementById('advProxyPool'); if (proxyEl) proxyEl.value = c.proxyPool;
        }
        if (c.inputMode !== undefined) { const im = document.getElementById('advInputMode'); if (im) im.value = c.inputMode; }
        if (c.fpStrategy !== undefined) { const fp = document.getElementById('advFpStrategy'); if (fp) fp.value = c.fpStrategy; }
        // Target sites — ensure at least one is checked
        if (c.targets) {
          const tj = document.getElementById('targetJoe'); if (tj) tj.checked = c.targets.includes('joe');
          const ti = document.getElementById('targetIgnition'); if (ti) ti.checked = c.targets.includes('ignition');
        }
        { const tj = document.getElementById('targetJoe'); const ti = document.getElementById('targetIgnition'); if (tj && ti && !tj.checked && !ti.checked) {
          tj.checked = true; }
        }
        // Boolean toggles
        if (c.recordVideo !== undefined) { const el = document.getElementById('advRecordVideo'); if (el) el.checked = !!c.recordVideo; }
        if (c.enablePlaywrightTracing !== undefined) { const el = document.getElementById('advEnableTracing'); if (el) el.checked = !!c.enablePlaywrightTracing; }
        if (c.enableCacheInjection !== undefined) { const el = document.getElementById('advCacheInjection'); if (el) el.checked = !!c.enableCacheInjection; }
        if (c.enableVerification !== undefined) { const el = document.getElementById('advEnableVerification'); if (el) el.checked = !!c.enableVerification; }

        if (c.useHttpCloak !== undefined) { const hc = document.getElementById('advUseHttpCloak'); if (hc) hc.checked = !!c.useHttpCloak; }
        if (c.stealthBypassHttpCloak !== undefined) { const sb = document.getElementById('advStealthBypass'); if (sb) sb.checked = !!c.stealthBypassHttpCloak; }
        if (c.emulateMobile !== undefined) { const em = document.getElementById('advEmulateMobile'); if (em) em.checked = !!c.emulateMobile; }
        if (c.injectStealthJS !== undefined) { const js = document.getElementById('advInjectStealthJS'); if (js) js.checked = !!c.injectStealthJS; }
        if (c.ignitionVerifBypass !== undefined) { const ib = document.getElementById('advIgnitionVerifBypass'); if (ib) ib.checked = !!c.ignitionVerifBypass; }
        if (c.rotateOnFingerprint !== undefined) { const rf = document.getElementById('advRotateOnFP'); if (rf) rf.checked = !!c.rotateOnFingerprint; }
        if (c.burnOnlyOnPermDisabled !== undefined) { const bb = document.getElementById('advBurnOnlyOnPermDisabled'); if (bb) bb.checked = !!c.burnOnlyOnPermDisabled; }
        // Numeric settings
        // postLoadDelay deprecated — no UI element to sync
        if (c.maxRetries !== undefined) { const el = document.getElementById('advMaxRetries'); if (el) el.value = c.maxRetries; }
        if (c.proxyRotateUrl !== undefined) { const el = document.getElementById('advProxyRotateUrl'); if (el) el.value = c.proxyRotateUrl; }
        if (c.mutateOnRetry !== undefined) { const mc = document.getElementById('advMutateOnRetry'); if (mc) mc.checked = c.mutateOnRetry; }
        if (c.manualCaptchaMode !== undefined) { const mc = document.getElementById('advManualCaptchaMode'); if (mc) mc.checked = c.manualCaptchaMode; }
        if (c.autoOptimizePerBackend !== undefined) { const ao = document.getElementById('advAutoOptimize'); if (ao) ao.checked = c.autoOptimizePerBackend; }
        // Parallel mode
        if (c.parallelSiteTesting !== undefined) {
          const modeEl = document.getElementById('advTestingMode');
          if (modeEl) modeEl.value = c.parallelSiteTesting ? 'parallel' : 'sequential';
        }
      }
      
      // Load UI State overrides
      loadUIState();

      // ── Enforce all compatibility rules then sync the config strip ──
      enforceSettingsCompatibility();
      syncConfigStrip();
      // ── Hermes status from init ──
      if (d.hermes) updateHermesUI(d.hermes);
    }

    /** Rebuild the backend <select> from the canonical list, hiding disabled
     *  backends and marking unavailable ones (missing API keys). */
    function rebuildBackendDropdown(currentVal) {
      const ALL_BACKENDS = [
        { id: 'stealth',     label: 'Stealth (Headless)',   needsKey: false },
        { id: 'stealth-headed', label: 'Stealth (Headed)', needsKey: false },
        { id: 'stealth-httpcloak', label: 'Stealth (HTTP Cloak)', needsKey: false },
        { id: 'cloak-headless', label: 'Cloak (Headless)', needsKey: false },
        { id: 'cloak-headed',   label: 'Cloak (Headed)',   needsKey: false },
        { id: 'cloak-headless-nocloak', label: 'Cloak (Headless - NoCloak)', needsKey: false },
        { id: 'cloak-headed-nocloak', label: 'Cloak (Headed - NoCloak)', needsKey: false },
        { id: 'zendriver',      label: 'Zendriver (HL)',   needsKey: false },
        { id: 'zendriver-headed', label: 'Zendriver (Headed)', needsKey: false },
        // Spider backends disabled — uncomment to re-enable:
        // { id: 'spider-local',   label: 'Spider Local',     needsKey: 'hasSpiderLocalKey' },
        // { id: 'spider-cloud',   label: 'Spider Cloud',     needsKey: 'hasSpiderKey' },
        // { id: 'spider-rest',    label: 'Spider REST',      needsKey: 'hasSpiderKey' },
        { id: 'curl-api',       label: 'CURL API',         needsKey: false },
        { id: 'rotate-backends', label: '🔄 Rotate All',   needsKey: false },
        { id: 'rotate-backends-headless', label: '🔄 Rotate All Headless', needsKey: false },
        { id: 'stealth-fortress', label: '🛡️ Stealth Fortress', needsKey: false },
        { id: 'speed-blitz', label: '⚡ Speed Blitz', needsKey: false },
        { id: 'headed-recon', label: '🎭 Headed Recon', needsKey: false },
        { id: 'darwin', label: '🦎 Darwin (Natural Selection)', needsKey: false },
        { id: 'golden-benchmark', label: 'Golden Benchmark', needsKey: false },
      ];
      const sel = document.getElementById('backendSelect');
      sel.innerHTML = '';
      let hasSelected = false;
      ALL_BACKENDS.forEach(b => {
        // Skip fully disabled backends (from disabled-backends.json)
        if (serverCaps.disabledBackends.includes(b.id)) return;
        const opt = document.createElement('option');
        opt.value = b.id;
        // Mark backends that are missing required API keys
        if (b.needsKey && !serverCaps[b.needsKey]) {
          opt.textContent = b.label + ' (no key)';
          opt.disabled = true;
          opt.style.color = '#555';
        } else {
          opt.textContent = b.label;
        }
        if (b.id === currentVal && !opt.disabled) {
          opt.selected = true;
          hasSelected = true;
        }
        sel.appendChild(opt);
      });
      // If current backend was disabled/removed, auto-select first available
      if (!hasSelected) {
        const firstEnabled = sel.querySelector('option:not(:disabled)');
        if (firstEnabled) {
          firstEnabled.selected = true;
          // Notify server of the auto-correction
          if (ws && ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: 'set-backend', data: { value: firstEnabled.value } }));
          }
        }
      }
    }

    /** Enforce setting compatibility rules — disable/enable toggles based on
     *  the currently selected backend and server capabilities. */
    function enforceSettingsCompatibility() {
      const backend = document.getElementById('backendSelect')?.value || 'stealth';
      const isCloak = backend.startsWith('cloak');
      const isStealth = backend.startsWith('stealth');
      const isZen = backend.startsWith('zendriver');
      const isSpider = backend.startsWith('spider');
      const isCurl = backend.startsWith('curl');
      const isRotate = backend === 'rotate-backends' || backend === 'rotate-backends-headless' || backend === 'stealth-fortress' || backend === 'speed-blitz' || backend === 'headed-recon' || backend === 'darwin';
      const isBenchmark = backend === 'golden-benchmark';
      const httpCloakOn = !!document.getElementById('advUseHttpCloak')?.checked;

      // Helper: set a toggle-row enabled/disabled with optional reason tooltip
      function setToggle(id, enabled, reason) {
        const el = document.getElementById(id);
        if (!el) return;
        const row = el.closest('.toggle-row');
        if (row) {
          row.classList.toggle('disabled', !enabled);
          row.title = enabled ? '' : (reason || 'Not available with current settings');
        }
        if (!enabled) {
          el.disabled = true;
          // Auto-uncheck disabled toggles to prevent invalid configs
          if (el.type === 'checkbox' && el.checked) {
            el.checked = false;
          }
        } else {
          el.disabled = false;
        }
      }

      // 1. AI Verification — requires API key
      setToggle('advEnableVerification', serverCaps.hasVerificationKey,
        'AI Verification requires GEMINI_API_KEY to be set');

      // 3. Cache Injection — not supported by spider/curl backends
      setToggle('advCacheInjection', !isSpider && !isCurl,
        'Cache injection is not supported with Spider/CURL backends');

      // 4. Record Video — not supported by REST/CURL (no browser page)
      setToggle('advRecordVideo', !isCurl && backend !== 'spider-rest',
        'Video recording requires a browser session');

      // 5. Bypass (Stealth) — only meaningful when HttpCloak is ON and Stealth backend is used
      setToggle('advStealthBypass', httpCloakOn && isStealth,
        'Bypass only applies when HttpCloak is enabled and Stealth is active');

      // 6. HttpCloak — available on stealth/cloak/zendriver backends
      const httpCloakSupported = isStealth || isCloak || isRotate || isBenchmark || backend.startsWith('zendriver') || backend === 'spider-local';
      setToggle('advUseHttpCloak', httpCloakSupported,
        'HttpCloak is only supported with Stealth/Zendriver/Cloak backends');
      // Note: presets handle the default checked state — no auto-tick needed here

      // 7. Rotate on FP — needs a browser-based backend
      setToggle('advRotateOnFP', !isCurl && backend !== 'spider-rest',
        'Backend rotation requires a browser session');

      // 8. Fingerprint Strategy Constraints — presets handle the value,
      //    enforce just disables the dropdown for backends with fixed strategies.
      const fpEl = document.getElementById('advFpStrategy');
      if (fpEl) {
        const isApiBackend = isCurl || backend === 'spider-rest';
        const fpDisabled = isApiBackend || isStealth;

        fpEl.disabled = fpDisabled;
        const fpParent = fpEl.closest('div');
        if (fpParent) {
          fpParent.classList.toggle('disabled', fpDisabled);
          fpParent.title = isStealth ? 'Stealth uses native C++ spoofing (preset: none)' :
                           (isApiBackend ? 'Not configurable on API backends' : '');
        }
      }

      // 9. Input Mode — Hard-locked to 'instant' (strict-no-human-typing rule)
      const inputEl = document.getElementById('advInputMode');
      if (inputEl) {
        inputEl.disabled = true; // Always disabled
        if (inputEl.value !== 'instant') {
          inputEl.value = 'instant';
          if (ws && ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: 'set-input-mode', data: { value: 'instant' } }));
          }
        }
        const inputParent = inputEl.closest('div');
        if (inputParent) {
          inputParent.classList.add('disabled');
          inputParent.title = 'Strict rule: No human typing simulation allowed';
        }
      }

      // 10. Target Sites <-> Display View constraints
      const targetJoe = document.getElementById('targetJoe')?.checked;
      const targetIgnition = document.getElementById('targetIgnition')?.checked;
      const displayToggle = document.getElementById('credDisplayToggle');
      if (displayToggle) {
        const opts = Array.from(displayToggle.options);
        opts.forEach(opt => { opt.disabled = false; opt.style.color = ''; }); // reset
        if (!targetJoe) {
           const bothOpt = opts.find(o => o.value === 'both');
           const joeOpt = opts.find(o => o.value === 'joe');
           if (bothOpt) { bothOpt.disabled = true; bothOpt.style.color = '#555'; }
           if (joeOpt) { joeOpt.disabled = true; joeOpt.style.color = '#555'; }
           if (displayToggle.value !== 'ignition') {
             displayToggle.value = 'ignition';
             if (typeof renderCredentialsTab === 'function') renderCredentialsTab();
           }
        }
        if (!targetIgnition) {
           const bothOpt = opts.find(o => o.value === 'both');
           const ignOpt = opts.find(o => o.value === 'ignition');
           if (bothOpt) { bothOpt.disabled = true; bothOpt.style.color = '#555'; }
           if (ignOpt) { ignOpt.disabled = true; ignOpt.style.color = '#555'; }
           if (displayToggle.value !== 'joe') {
             displayToggle.value = 'joe';
             if (typeof renderCredentialsTab === 'function') renderCredentialsTab();
           }
        }
      }

      // 11. Sequential vs Parallel Mode (Grey out if only 1 target)
      const testingModeEl = document.getElementById('advTestingMode');
      if (testingModeEl) {
        const isSingleTarget = (targetJoe && !targetIgnition) || (!targetJoe && targetIgnition);
        testingModeEl.disabled = isSingleTarget;
        if (isSingleTarget && testingModeEl.value !== 'sequential') {
          testingModeEl.value = 'sequential'; // Force visual reset to sequential
        }
        const testingModeParent = testingModeEl.closest('div');
        if (testingModeParent) testingModeParent.classList.toggle('disabled', isSingleTarget);
      }
      // 12. Headless constraints (Manual Captcha)
      const isHeadless = !backend.includes('headed') && backend !== 'spider-local' && backend !== 'rotate-backends' && backend !== 'stealth-fortress' && backend !== 'darwin';
      setToggle('advManualCaptchaMode', !isHeadless,
        'Manual CAPTCHA solving requires a visible browser window (headed)');

      // 13. Ignition Bypass target constraint
      setToggle('advIgnitionVerifBypass', !!targetIgnition,
        'Ignition Bypass only applies if Ignition is a selected target');

      // 14. Inject Stealth JS
      setToggle('advInjectStealthJS', !isStealth && !isCurl && backend !== 'spider-rest',
        'Stealth JS injection is only for Zendriver/Spider-Local/Cloak');

      // 15. Mutate Fingerprint
      setToggle('advMutateOnRetry', !isCurl && backend !== 'spider-rest',
        'Mutate Fingerprint requires a browser session');

      // 16. Golden Fingerprint Profiles
      const fpStrategy = document.getElementById('advFpStrategy')?.value;
      const isGolden = fpStrategy === 'fp-golden';
      const gJoe = document.getElementById('goldenJoe');
      if (gJoe) {
          gJoe.disabled = !isGolden;
          const p = gJoe.closest('div');
          if (p) p.classList.toggle('disabled', !isGolden);
      }
      const gIg = document.getElementById('goldenIgnition');
      if (gIg) {
          gIg.disabled = !isGolden;
          const p = gIg.closest('div');
          if (p) p.classList.toggle('disabled', !isGolden);
      }

      // Always sync the config strip display
      syncConfigStrip();
    }

    let pendingUploadFile = null;
    function triggerUploadModal() {
      document.getElementById('uploadCsv').click();
    }
    function handleUploadFile(f) {
      if (!f) return;
      pendingUploadFile = f;
      // Show custom modal
      const scope = prompt("Which target is this CSV for?\n\nEnter 'joe' for Joe Fortune\nEnter 'ignition' for Ignition\nEnter 'both' for Both\n\n(Default: both)", "both");
      if (!scope) return;
      let targets = ["joe", "ignition"];
      if (scope.toLowerCase().includes('joe') && !scope.toLowerCase().includes('ignition')) targets = ["joe"];
      if (scope.toLowerCase().includes('ignition') && !scope.toLowerCase().includes('joe')) targets = ["ignition"];
      
      const r = new FileReader(); 
      r.onload = (e) => { 
        ws.send(JSON.stringify({ type: 'upload-csv', data: { name: f.name, content: e.target.result, targets } })); 
        showCyberToast(`Uploading ${f.name} for ${targets.join(', ')}...`); 
      }; 
      r.readAsText(f);
      document.getElementById('uploadCsv').value = ''; // reset
    }

    function deleteSelectedRows() {
      if (selectedEmails.size === 0) return alert('No rows selected');
      const scope = prompt("Remove selected from which target?\n\nEnter 'joe' for Joe Fortune\nEnter 'ignition' for Ignition\nEnter 'both' to completely delete\n\n(Default: both)", "both");
      if (!scope) return;
      let siteScope = 'both';
      if (scope.toLowerCase().includes('joe') && !scope.toLowerCase().includes('ignition')) siteScope = 'joe';
      if (scope.toLowerCase().includes('ignition') && !scope.toLowerCase().includes('joe')) siteScope = 'ignition';

      if (confirm(`Remove ${selectedEmails.size} rows from '${siteScope}'?`)) {
        sendWsMessage({ type: 'delete-rows', data: { emails: Array.from(selectedEmails), siteScope } });
      }
    }
    function clearProgress() { if (confirm('Wipe all progress?')) sendWsMessage({ type: 'clear-progress' }); }
    function purgeFailed() { if (confirm('Purge failed?')) sendWsMessage({ type: 'purge-failed' }); }
    function cleanOldRecords() { if (confirm('Purge old logs?')) sendWsMessage({ type: 'clean-old' }); }

    function startAutomation() { const s = Array.from(selectedEmails); if (!s.length) return alert('Select credentials first'); try { const c = getUIConfig(); c.emails = s; c.targets = [document.getElementById('targetJoe')?.checked ? 'joe' : null, document.getElementById('targetIgnition')?.checked ? 'ignition' : null].filter(Boolean); sendWsMessage({ type: 'start', data: c }); switchTab('liveview'); clearAllLiveViewSlots(); } catch(err) { console.error('startAutomation failed:', err); alert('Launch failed: ' + err.message); } }
    function togglePause() {
      sendWsMessage({ type: 'set-engine-paused', data: { paused: !isPaused } });
    }
    function handleEnginePausedState(data) {
      isPaused = !!data.paused;
      setRunningState(isRunning);
    }
    function stopAutomation() { sendWsMessage({ type: 'stop' }); }
    function startGoldenBenchmark() { const j = document.getElementById('goldenJoe').value.trim(), ig = document.getElementById('goldenIgnition').value.trim(); if (!j && !ig) return alert('Enter at least one golden credential'); if (j) sendWsMessage({ type: 'set-golden-joe', data: { value: j } }); if (ig) sendWsMessage({ type: 'set-golden-ignition', data: { value: ig } }); const c = getUIConfig(); c.backend = 'golden-benchmark'; c.emails = ['golden_benchmark_user']; c.targets = ['joe', 'ignition']; sendWsMessage({ type: 'start', data: c }); switchTab('liveview'); clearAllLiveViewSlots(); showRaceLeaderboard(); }

    function showRaceLeaderboard() {
      let overlay = document.getElementById('raceOverlay');
      if (!overlay) {
        overlay = document.createElement('div');
        overlay.id = 'raceOverlay';
        overlay.style.cssText = 'position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,0.85);z-index:9999;display:flex;align-items:center;justify-content:center;backdrop-filter:blur(6px);';
        const box = document.createElement('div');
        box.id = 'raceBox';
        box.style.cssText = 'background:linear-gradient(135deg,#0f1729,#1a1a2e);border:1px solid rgba(6,182,212,0.3);border-radius:16px;padding:32px;min-width:700px;max-width:900px;box-shadow:0 0 60px rgba(6,182,212,0.15);';
        overlay.appendChild(box);
        document.body.appendChild(overlay);
      }
      overlay.style.display = 'flex';
      const box = document.getElementById('raceBox');
      box.innerHTML = '<div style="text-align:center;color:var(--cyan,#22d3ee);font-size:18px;font-weight:700;letter-spacing:3px;">🏁 BACKEND RACE — INITIALIZING...</div>';
    }

    function renderRaceLeaderboard(data) {
      const overlay = document.getElementById('raceOverlay');
      if (!overlay) showRaceLeaderboard();
      const box = document.getElementById('raceBox');
      if (!box) return;
      const lb = data.leaderboard || [];
      const isComplete = !!data.isComplete;
      const winner = data.winner || null;
      const elapsed = data.raceStartTime ? ((Date.now() - data.raceStartTime) / 1000).toFixed(1) : '—';

      // Dynamically discover which sites are being tested from the leaderboard keys
      const siteNames = [];
      if (lb.length > 0) {
        const sample = lb[0];
        for (const key of Object.keys(sample)) {
          if (key.endsWith('Status') && key !== 'status') {
            siteNames.push(key.replace('Status', ''));
          }
        }
      }
      // Fallback if no sites detected
      if (siteNames.length === 0) siteNames.push('joe');

      const statusIcon = (s) => {
        if (s === 'Racing') return '<span style="color:#facc15;">🏃</span>';
        if (s === 'Success') return '<span style="color:#22c55e;">✅</span>';
        if (s === 'Failed') return '<span style="color:#ef4444;">❌</span>';
        if (s === 'Timeout') return '<span style="color:#f97316;">⏳</span>';
        return '<span style="color:#94a3b8;">—</span>';
      };
      const siteIcon = (s) => {
        if (s === '✅') return '<span style="color:#22c55e;">✅</span>';
        if (s === '❌') return '<span style="color:#ef4444;">❌</span>';
        if (s === '🏃') return '<span style="color:#facc15;">🏃</span>';
        return '<span style="color:#64748b;">⏳</span>';
      };
      const fmtTime = (ms) => ms > 0 ? (ms / 1000).toFixed(1) + 's' : '—';
      const capitalize = (s) => s.charAt(0).toUpperCase() + s.slice(1);

      let headerText = isComplete
        ? (winner ? `🏆 RACE COMPLETE — WINNER: ${winner.toUpperCase()}` : '🏁 RACE COMPLETE — NO WINNER')
        : `🏁 BACKEND RACE — ${elapsed}s elapsed`;

      // Build dynamic site columns for headers
      const siteHeaders = siteNames.map(name => `
        <th style="padding:8px;text-align:center;color:#64748b;font-size:10px;text-transform:uppercase;">${capitalize(name)}</th>
        <th style="padding:8px;text-align:center;color:#64748b;font-size:10px;text-transform:uppercase;">${capitalize(name)} Time</th>
      `).join('');

      let rows = lb.map((b, i) => {
        const isWinner = !!b.winner;
        const rowBg = isWinner ? 'rgba(34,211,238,0.08)' : (i % 2 === 0 ? 'rgba(255,255,255,0.02)' : 'transparent');
        const border = isWinner ? 'border:1px solid rgba(34,211,238,0.4);' : '';

        // Build dynamic site cells
        const siteCells = siteNames.map(name => `
          <td style="padding:10px 8px;text-align:center;">${siteIcon(b[name + 'Status'] || '⏳')}</td>
          <td style="padding:10px 8px;text-align:center;font-family:'JetBrains Mono',monospace;font-size:12px;color:#94a3b8;">${fmtTime(b[name + 'Time'])}</td>
        `).join('');

        return `<tr style="background:${rowBg};${border}">
          <td style="padding:10px 14px;font-weight:700;color:#fff;white-space:nowrap;">
            ${isWinner ? '🏆 ' : ''}${b.backend}
          </td>
          <td style="padding:10px 8px;text-align:center;">${statusIcon(b.status)}</td>
          ${siteCells}
          <td style="padding:10px 8px;text-align:center;font-family:'JetBrains Mono',monospace;font-size:13px;font-weight:700;color:${isWinner ? '#22d3ee' : (b.status === 'Success' ? '#22c55e' : '#94a3b8')};">${fmtTime(b.totalTime)}</td>
        </tr>`;
      }).join('');

      box.innerHTML = `
        <div style="text-align:center;color:${isComplete ? (winner ? '#22d3ee' : '#f97316') : '#facc15'};font-size:16px;font-weight:700;letter-spacing:2px;margin-bottom:20px;">${headerText}</div>
        <table style="width:100%;border-collapse:collapse;font-size:13px;">
          <thead>
            <tr style="border-bottom:1px solid rgba(255,255,255,0.1);">
              <th style="padding:8px 14px;text-align:left;color:#64748b;font-size:10px;text-transform:uppercase;letter-spacing:1px;">Backend</th>
              <th style="padding:8px;text-align:center;color:#64748b;font-size:10px;text-transform:uppercase;">Status</th>
              ${siteHeaders}
              <th style="padding:8px;text-align:center;color:#64748b;font-size:10px;text-transform:uppercase;">Total</th>
            </tr>
          </thead>
          <tbody>${rows}</tbody>
        </table>
        ${isComplete ? '<div style="text-align:center;margin-top:16px;"><button onclick="closeRaceLeaderboard()" style="background:linear-gradient(135deg,#06b6d4,#3b82f6);color:#fff;border:none;padding:10px 32px;border-radius:8px;font-weight:700;cursor:pointer;font-size:13px;letter-spacing:1px;">CLOSE</button></div>' : '<div style="text-align:center;margin-top:12px;color:#64748b;font-size:11px;">Racing... all backends running concurrently</div>'}
      `;

      if (isComplete) {
        setTimeout(() => { const o = document.getElementById('raceOverlay'); if (o) o.style.display = 'none'; }, 15000);
      }
    }

    function closeRaceLeaderboard() { const o = document.getElementById('raceOverlay'); if (o) o.style.display = 'none'; }

    function liveTest(em) { sendWsMessage({ type: 'live-test', data: { email: em } }); }

    function updateSelectedCount() { const el = document.getElementById('selectedCount'); if (el) el.textContent = `${selectedEmails.size} selected`; const bar = document.getElementById('bulkActionBar'); if (bar) { if (selectedEmails.size > 0) { bar.classList.add('visible'); document.getElementById('bulkActionCount').textContent = selectedEmails.size; } else bar.classList.remove('visible'); } }
    function requeueSelected() { if (!isWsConnected) return showCyberToast('Not connected'); Array.from(selectedEmails).forEach(em => { const gi = rows.findIndex(r => r.email === em); if (gi !== -1) { sendWsMessage({ type: 'retest', email: em }); const r = rows[gi]; if (r && r.sites) { Object.keys(r.sites).forEach(s => { r.sites[s].outcome = 'queued'; }); renderRowInPlace(gi); } } }); showCyberToast(`Re-queued ${selectedEmails.size}`); selectedEmails.clear(); updateSelectedCount(); syncMasterSelectState(); }
    function toggleRow(em, ch) { if (ch) selectedEmails.add(em); else selectedEmails.delete(em); updateSelectedCount(); syncMasterSelectState(); }
    const TERMINAL_OUTCOMES = new Set(['success', '2FA', 'noaccount', 'permdisabled']);
    function rowIsTerminal(i) { const r = rows[i]; if (!r || !r.sites) return false; const o = Object.values(r.sites).map(s => s.outcome); return o.length > 0 && o.every(x => TERMINAL_OUTCOMES.has(x)); }
    function applyCredFilter() { applyVisibilityFilter(); syncMasterSelectState(); }
    function visibleCredentialIndices(opts) { const q = (document.getElementById('credFilter')?.value || '').toLowerCase(); const u = !!(opts && opts.untestedOnly); const out = []; for (let i = 0; i < credentials.length; i++) { if (q && !credentials[i].email.toLowerCase().includes(q)) continue; if (u && rowIsTerminal(i)) continue; out.push(i); } return out; }
    function selectFiltered(sel) { const u = !!document.getElementById('optUntestedOnly')?.checked; const idx = visibleCredentialIndices({ untestedOnly: u }); if (sel && !idx.length) { showCyberToast('No match'); return; } if (sel) { for (const i of idx) selectedEmails.add(credentials[i].email); } else selectedEmails.clear(); renderTable(); applyCredFilter(); updateSelectedCount(); syncMasterSelectState(); }
    function selectRandomN(n) { const u = !!document.getElementById('optUntestedOnly')?.checked; const pool = visibleCredentialIndices({ untestedOnly: u }); if (!pool.length) { showCyberToast('None available'); return; } for (let i = pool.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1));[pool[i], pool[j]] = [pool[j], pool[i]]; } const take = Math.min(n, pool.length); selectedEmails.clear(); for (let k = 0; k < take; k++)selectedEmails.add(credentials[pool[k]].email); renderTable(); applyCredFilter(); updateSelectedCount(); syncMasterSelectState(); showCyberToast(`Selected ${take}`); }
    function onMasterSelectToggle(e) { selectFiltered(e.target.checked); }
    function syncMasterSelectState() { const m = document.getElementById('masterSelect'); if (!m) return; const u = !!document.getElementById('optUntestedOnly')?.checked; const v = visibleCredentialIndices({ untestedOnly: u }); if (!v.length) { m.checked = false; m.indeterminate = false; return; } let s = 0; for (const i of v) if (selectedEmails.has(credentials[i].email)) s++; m.checked = s === v.length; m.indeterminate = s > 0 && s < v.length; }
    function setRunningState(r) {
      isRunning = r;
      document.getElementById('btnStart').disabled = r;
      document.getElementById('btnStop').disabled = !r;
      const bql = document.getElementById('btnQuickLaunch');
      if (bql) bql.disabled = r;
      const bp = document.getElementById('btnPause');
      if (bp) {
        bp.disabled = !r;
        if (!r) isPaused = false;
        bp.innerHTML = isPaused ? '▶ RESUME' : '⏸ PAUSE';
      }
      document.getElementById('statusPill').textContent = r ? (isPaused ? 'PAUSED' : 'RUNNING') : 'IDLE';
      const chip = document.getElementById('globalStatusChip');
      if (chip) chip.className = 'status-chip ' + (r ? (isPaused ? 'chip-idle' : 'chip-running') : 'chip-idle');
    }
    function syncData() { ws.send(JSON.stringify({ type: 'sync' })); }

    function bindSettingsEvents() { const binds = [{ id: 'advConcurrency', type: 'set-concurrency', val: el => parseInt(el.value) }, { id: 'advProxyPool', type: 'set-proxy-pool', val: el => el.value }, { id: 'backendSelect', type: 'set-backend', val: el => el.value }, { id: 'advInputMode', type: 'set-input-mode', val: el => el.value }, { id: 'advFpStrategy', type: 'set-fp-strategy', val: el => el.value }, { id: 'advRecordVideo', type: 'set-record-video', val: el => el.checked }, { id: 'advEnableTracing', type: 'set-enable-tracing', val: el => el.checked }, { id: 'advCacheInjection', type: 'set-cache-injection', val: el => el.checked }, { id: 'advEnableVerification', type: 'set-enable-verification', val: el => el.checked }, { id: 'advUseHttpCloak', type: 'update_ui_settings', val: el => el.checked }, { id: 'advStealthBypass', type: 'update_ui_settings', val: el => el.checked }, { id: 'advInjectStealthJS', type: 'update_ui_settings', val: el => el.checked }, { id: 'advIgnitionVerifBypass', type: 'set-ignition-verif-bypass', val: el => el.checked }, { id: 'advPostLoadDelay', type: 'set-post-load-delay', val: el => parseInt(el.value) }, { id: 'advMaxRetries', type: 'set-max-retries', val: el => parseInt(el.value) }, { id: 'goldenJoe', type: 'set-golden-joe', val: el => el.value }, { id: 'goldenIgnition', type: 'set-golden-ignition', val: el => el.value }, { id: 'advRotateOnFP', type: 'set-rotate-on-fingerprint', val: el => el.checked }, { id: 'advBurnOnlyOnPermDisabled', type: 'set-burn-only-perm-disabled', val: el => el.checked }, { id: 'advMutateOnRetry', type: 'set-mutate-on-retry', val: el => el.checked }, { id: 'advProxyRotateUrl', type: 'set-proxy-rotate-url', val: el => el.value }, { id: 'advManualCaptchaMode', type: 'set-manual-captcha-mode', val: el => el.checked }, { id: 'advAutoOptimize', type: 'set-auto-optimize-per-backend', val: el => el.checked }, { id: 'advEmulateMobile', type: 'set-emulate-mobile', val: el => el.checked }, { id: 'advMullvadMode', type: 'set-mullvad-mode', val: el => el.value }]; binds.forEach(b => { const el = document.getElementById(b.id); if (el) el.addEventListener('change', () => { if (ws && ws.readyState === WebSocket.OPEN) { const val = b.val(el); if (b.type === 'update_ui_settings') { const sn = b.id === 'advUseHttpCloak' ? 'useHttpCloak' : b.id === 'advInjectStealthJS' ? 'injectStealthJS' : 'stealthBypassHttpCloak'; ws.send(JSON.stringify({ type: 'update_ui_settings', setting: sn, value: val.toString() })); } else ws.send(JSON.stringify({ type: b.type, data: { value: val } })); /* Re-enforce compatibility after every change */ enforceSettingsCompatibility(); } }); }); }

    // Chart
    const successRateHistory = [], CHART_WINDOW_MS = 30 * 60 * 1000;
    function pushSuccessRateDataPoint() { let t = 0, s = 0; let tj = 0, sj = 0; let ti = 0, si = 0; rows.forEach(r => { Object.entries(r.sites).forEach(([site, x]) => { if (x.outcome && x.outcome !== 'queued' && x.outcome !== 'N/A') { t++; if(site==='joe') tj++; if(site==='ignition') ti++; } if (x.outcome === 'success') { s++; if(site==='joe') sj++; if(site==='ignition') si++; } }); }); const rate = t > 0 ? (s / t * 100) : 0; const rj = tj > 0 ? (sj / tj * 100) : 0; const ri = ti > 0 ? (si / ti * 100) : 0; const now = new Date(); successRateHistory.push({ time: now, rate }); if(!window.siteRateHist) window.siteRateHist = { joe:[], ignition:[] }; window.siteRateHist.joe.push({time:now,rate:rj}); window.siteRateHist.ignition.push({time:now,rate:ri}); const cut = now.getTime() - CHART_WINDOW_MS; while (successRateHistory.length > 0 && successRateHistory[0].time.getTime() < cut) successRateHistory.shift(); while (window.siteRateHist.joe.length > 0 && window.siteRateHist.joe[0].time.getTime() < cut) window.siteRateHist.joe.shift(); while (window.siteRateHist.ignition.length > 0 && window.siteRateHist.ignition[0].time.getTime() < cut) window.siteRateHist.ignition.shift(); const el = document.getElementById('chartCurrentRate'); if (el) el.textContent = rate.toFixed(1) + '%'; drawSuccessRateChart(); if(typeof drawAnalyticsChart === 'function') drawAnalyticsChart(); }
    function drawSuccessRateChart() { const cv = document.getElementById('successRateCanvas'); if (!cv) return; const dpr = window.devicePixelRatio || 1; const rc = cv.getBoundingClientRect(); cv.width = rc.width * dpr; cv.height = rc.height * dpr; const ctx = cv.getContext('2d'); ctx.scale(dpr, dpr); const W = rc.width, H = rc.height, PL = 36, PR = 8, PT = 8, PB = 20; const cW = W - PL - PR, cH = H - PT - PB; ctx.clearRect(0, 0, W, H); ctx.strokeStyle = 'rgba(255,255,255,0.03)'; ctx.lineWidth = 1; for (let p = 0; p <= 100; p += 25) { const y = PT + cH - (p / 100) * cH; ctx.beginPath(); ctx.moveTo(PL, y); ctx.lineTo(PL + cW, y); ctx.stroke(); ctx.fillStyle = 'rgba(148,163,184,0.4)'; ctx.font = '9px "JetBrains Mono",monospace'; ctx.textAlign = 'right'; ctx.fillText(p + '%', PL - 4, y + 3); } const now = Date.now(); ctx.fillStyle = 'rgba(148,163,184,0.35)'; ctx.textAlign = 'center'; ctx.font = '8px "JetBrains Mono",monospace';[0, 10, 20, 30].forEach(m => { const x = PL + ((CHART_WINDOW_MS - m * 60000) / CHART_WINDOW_MS) * cW; ctx.fillText(m === 0 ? 'now' : `-${m}m`, x, H - 2); }); if (successRateHistory.length < 2) { ctx.fillStyle = 'rgba(148,163,184,0.2)'; ctx.font = '10px Inter,sans-serif'; ctx.textAlign = 'center'; ctx.fillText('Waiting…', W / 2, H / 2); return; } const ts = now - CHART_WINDOW_MS; const pts = successRateHistory.map(p => ({ x: PL + ((p.time.getTime() - ts) / CHART_WINDOW_MS) * cW, y: PT + cH - (p.rate / 100) * cH })); const grd = ctx.createLinearGradient(0, PT, 0, PT + cH); grd.addColorStop(0, 'rgba(6,182,212,0.15)'); grd.addColorStop(1, 'rgba(6,182,212,0)'); ctx.fillStyle = grd; ctx.beginPath(); ctx.moveTo(pts[0].x, PT + cH); for (let i = 0; i < pts.length; i++) { if (i === 0) { ctx.lineTo(pts[i].x, pts[i].y); continue; } const pv = pts[i - 1]; const cpx = (pv.x + pts[i].x) / 2; ctx.bezierCurveTo(cpx, pv.y, cpx, pts[i].y, pts[i].x, pts[i].y); } ctx.lineTo(pts[pts.length - 1].x, PT + cH); ctx.closePath(); ctx.fill(); const lg = ctx.createLinearGradient(PL, 0, PL + cW, 0); lg.addColorStop(0, '#dc2626'); lg.addColorStop(1, '#06b6d4'); ctx.strokeStyle = lg; ctx.lineWidth = 2; ctx.lineCap = 'round'; ctx.beginPath(); for (let i = 0; i < pts.length; i++) { if (i === 0) { ctx.moveTo(pts[i].x, pts[i].y); continue; } const pv = pts[i - 1]; const cpx = (pv.x + pts[i].x) / 2; ctx.bezierCurveTo(cpx, pv.y, cpx, pts[i].y, pts[i].x, pts[i].y); } ctx.stroke(); const last = pts[pts.length - 1]; ctx.fillStyle = '#22d3ee'; ctx.shadowColor = 'rgba(34,211,238,0.5)'; ctx.shadowBlur = 5; ctx.beginPath(); ctx.arc(last.x, last.y, 3, 0, Math.PI * 2); ctx.fill(); ctx.shadowBlur = 0; }
    function drawAnalyticsChart() { const cv = document.getElementById('analyticsChart'); if (!cv) return; const dpr = window.devicePixelRatio || 1; const rc = cv.getBoundingClientRect(); cv.width = rc.width * dpr; cv.height = rc.height * dpr; const ctx = cv.getContext('2d'); ctx.scale(dpr, dpr); const W = rc.width, H = rc.height, PL = 36, PR = 8, PT = 24, PB = 20; const cW = W - PL - PR, cH = H - PT - PB; ctx.clearRect(0, 0, W, H); ctx.strokeStyle = 'rgba(255,255,255,0.05)'; ctx.lineWidth = 1; for (let p = 0; p <= 100; p += 25) { const y = PT + cH - (p / 100) * cH; ctx.beginPath(); ctx.moveTo(PL, y); ctx.lineTo(PL + cW, y); ctx.stroke(); ctx.fillStyle = 'rgba(148,163,184,0.4)'; ctx.font = '10px "JetBrains Mono",monospace'; ctx.textAlign = 'right'; ctx.fillText(p + '%', PL - 4, y + 3); } const now = Date.now(); ctx.fillStyle = 'rgba(148,163,184,0.35)'; ctx.textAlign = 'center'; ctx.font = '9px "JetBrains Mono",monospace'; [0, 10, 20, 30].forEach(m => { const x = PL + ((CHART_WINDOW_MS - m * 60000) / CHART_WINDOW_MS) * cW; ctx.fillText(m === 0 ? 'now' : `-${m}m`, x, H - 2); }); if (!window.siteRateHist) return; const ts = now - CHART_WINDOW_MS; const drawLine = (data, color, label, yOffset) => { if (data.length < 2) return; const pts = data.map(p => ({ x: PL + ((p.time.getTime() - ts) / CHART_WINDOW_MS) * cW, y: PT + cH - (p.rate / 100) * cH })); ctx.strokeStyle = color; ctx.lineWidth = 2; ctx.lineCap = 'round'; ctx.beginPath(); for (let i = 0; i < pts.length; i++) { if (i === 0) { ctx.moveTo(pts[i].x, pts[i].y); continue; } const pv = pts[i - 1]; const cpx = (pv.x + pts[i].x) / 2; ctx.bezierCurveTo(cpx, pv.y, cpx, pts[i].y, pts[i].x, pts[i].y); } ctx.stroke(); ctx.fillStyle = color; ctx.textAlign = 'left'; ctx.font = '11px sans-serif'; ctx.fillText(label, PL + 10, yOffset); const last = pts[pts.length - 1]; ctx.beginPath(); ctx.arc(last.x, last.y, 3, 0, Math.PI * 2); ctx.fill(); }; drawLine(window.siteRateHist.joe, '#ef4444', 'Joe Fortune', 12); drawLine(window.siteRateHist.ignition, '#f59e0b', 'Ignition', 24); }
    window.addEventListener('resize', () => { drawSuccessRateChart(); if(typeof drawAnalyticsChart === 'function') drawAnalyticsChart(); });

    let sortedIndices = null;
    function applyCredSort() { const sv = (document.getElementById('filterSort')?.value || 'default'); if (sv === 'default') { sortedIndices = null; renderTable(); return; } const idx = credentials.map((_, i) => i); switch (sv) { case 'email-az': idx.sort((a, b) => credentials[a].email.localeCompare(credentials[b].email)); break; case 'email-za': idx.sort((a, b) => credentials[b].email.localeCompare(credentials[a].email)); break; case 'last-tested': { const gt = i => { const r = rows[i]; if (!r || !r.sites) return 0; let l = 0; Object.values(r.sites).forEach(s => { if (s.timestamp) { const t = new Date(s.timestamp).getTime(); if (t > l) l = t; } }); return l; }; idx.sort((a, b) => gt(b) - gt(a)); break; } case 'outcome': { const O = { 'success': 0, '2FA': 1, 'tempdisabled': 2, 'permdisabled': 3, 'noaccount': 4, 'testing': 5, 'queued': 6 }; const gp = i => { const r = rows[i]; if (!r || !r.sites) return 99; let best = 99; Object.values(r.sites).forEach(s => { const o = O[s.outcome]; if (o !== undefined && o < best) best = o; }); return best; }; idx.sort((a, b) => gp(a) - gp(b)); break; } }sortedIndices = idx; const body = document.getElementById('credentialList'); if (!body) return; body.innerHTML = idx.map(i => buildRowHTML(i)).join(''); applyVisibilityFilter(); syncMasterSelectState(); }

    const costData = { totalSpent: 0, creditsRemaining: null, credentialsTested: 0, sessionCosts: [] };
    function parseCreditLog(msg) { if (typeof msg !== 'string') return; const rm = msg.match(/Credits remaining:\s*([\d,.]+)/i); if (rm) costData.creditsRemaining = parseFloat(rm[1].replace(/,/g, '')); const cm = msg.match(/(?:session\s+)?cost:\s*([\d,.]+)/i); if (cm) { const c = parseFloat(cm[1].replace(/,/g, '')); if (!isNaN(c) && c > 0) { costData.sessionCosts.push(c); costData.totalSpent = costData.sessionCosts.reduce((a, b) => a + b, 0); } } updateCostDashboard(); }
    function updateCostDashboard() { let t = 0, u = 0; rows.forEach(r => { let ht = false; Object.values(r.sites).forEach(s => { if (s.outcome && s.outcome !== 'queued' && s.outcome !== 'N/A') ht = true; }); if (ht) t++; else u++; }); costData.credentialsTested = t; const se = document.getElementById('costTotalSpent'); if (se) se.textContent = costData.totalSpent > 0 ? costData.totalSpent.toFixed(2) : '—'; const re = document.getElementById('costRemaining'); if (re) re.textContent = costData.creditsRemaining !== null ? costData.creditsRemaining.toFixed(1) : '—'; const pe = document.getElementById('costPerCred'); if (pe) { const a = t > 0 ? costData.totalSpent / t : 0; pe.textContent = a > 0 ? a.toFixed(3) : '—'; } const pr = document.getElementById('costProjected'); if (pr) { if (t > 0 && u > 0) { pr.textContent = ((costData.totalSpent / t) * u).toFixed(1); const sub = document.getElementById('costProjectedSub'); if (sub) sub.textContent = `${u} remaining`; } else pr.textContent = '—'; } }

    function retestCredential(em, ri) { if (!isWsConnected) { showCyberToast('Not connected'); return; } const btn = document.getElementById('retest-' + ri); if (btn) { btn.classList.add('loading'); setTimeout(() => btn.classList.remove('loading'), 2500); } sendWsMessage({ type: 'retest', email: em }); const gi = rows.findIndex(r => r.email === em); if (gi !== -1) { const r = rows[gi]; if (r && r.sites) { Object.keys(r.sites).forEach(s => { r.sites[s].outcome = 'queued'; }); renderRowInPlace(gi); } } showCyberToast(`Retest: ${em}`); }

    // ═══ Screenshot Lightbox ═══
    const carouselData = {};
    let lbCarouselId = '', lbIdx = 0;
    function openDualLightbox(cId, idx) {
      const shots = carouselData[cId]; if (!shots || !shots.length) return;
      lbCarouselId = cId; lbIdx = Math.min(idx, shots.length - 1);
      showLightboxSlide();
      document.getElementById('ssLightbox').classList.add('active');
    }
    function closeLightbox() { document.getElementById('ssLightbox').classList.remove('active'); }
    function navLightbox(dir) {
      const shots = carouselData[lbCarouselId]; if (!shots) return;
      lbIdx = (lbIdx + dir + shots.length) % shots.length;
      showLightboxSlide();
    }
    function showLightboxSlide() {
      const shots = carouselData[lbCarouselId]; if (!shots) return;
      const g = shots[lbIdx];
      
      const primary = g.joe || g.ign || g.other;
      const secondary = (primary === g.joe) ? g.ign : null;
      
      document.getElementById('lbImagePrimary').src = primary ? primary.url : '';
      document.getElementById('lbLabelPrimary').textContent = primary ? (primary.target === 'joe' ? 'JOE' : 'IGN') : '';
      
      const secPane = document.getElementById('lbPaneSecondary');
      if (secondary) {
        secPane.style.display = 'flex';
        document.getElementById('lbImageSecondary').src = secondary.url;
        document.getElementById('lbLabelSecondary').textContent = secondary.target === 'joe' ? 'JOE' : 'IGN';
      } else {
        secPane.style.display = 'none';
      }
      
      document.getElementById('lbCaption').textContent = `${primary ? primary.email : ''} — ${g.label || ''}`;
      const lbc = document.getElementById('lbCounter');
      if (lbc) lbc.textContent = `${lbIdx + 1} / ${shots.length}`;
    }
    document.addEventListener('keydown', (e) => {
      const lb = document.getElementById('ssLightbox');
      if (lb && lb.classList.contains('active')) {
        if (e.key === 'Escape') closeLightbox();
        if (e.key === 'ArrowLeft') navLightbox(-1);
        if (e.key === 'ArrowRight') navLightbox(1);
        return;
      }
      const vb = document.getElementById('videoModalBackdrop');
      if (vb && vb.classList.contains('active') && e.key === 'Escape') closeVideoModal();
    });

    // ═══════ CREDENTIALS TAB ENGINE ═══════
    let credPage = 0;
    let credSelected = new Set();
    const TEMP_DISABLED_COOLDOWN_MS = 60 * 60 * 1000; // 60 minutes
    const tempDisabledTimers = {}; // { email: { detectedAt: timestamp, requeued: bool } }
    let credCountdownInterval = null;

    function trackTempDisabled(email, row) {
      if (!row || !row.sites) return;
      const hasTempDisabled = Object.values(row.sites).some(s => s.outcome === 'tempdisabled');
      const key = email.toLowerCase();
      if (hasTempDisabled && !tempDisabledTimers[key]) {
        tempDisabledTimers[key] = { detectedAt: Date.now(), requeued: false };
        addLog('INFO', `⏸ ${email} temp-disabled — 60min countdown started`);
      } else if (!hasTempDisabled && tempDisabledTimers[key]) {
        // No longer tempdisabled, clear timer
        delete tempDisabledTimers[key];
      }
    }

    function checkTempDisabledExpiry() {
      const now = Date.now();
      Object.entries(tempDisabledTimers).forEach(([key, timer]) => {
        if (timer.requeued) return;
        const elapsed = now - timer.detectedAt;
        if (elapsed >= TEMP_DISABLED_COOLDOWN_MS) {
          timer.requeued = true;
          // Find the credential and requeue it
          const idx = credentials.findIndex(c => c.email.toLowerCase() === key);
          if (idx !== -1) {
            const email = credentials[idx].email;
            // Move to top of queue
            if (ws && ws.readyState === 1) {
              ws.send(JSON.stringify({ type: 'force-wake', data: { email: email } }));
            }
            // Reset the row outcomes to queued locally
            if (rows[idx] && rows[idx].sites) {
              Object.keys(rows[idx].sites).forEach(s => { rows[idx].sites[s].outcome = 'queued'; });
              renderRowInPlace(idx);
            }
            addLog('INFO', `✅ ${email} cooldown expired — auto-requeued to top of queue`);
            delete tempDisabledTimers[key];
          }
        }
      });
    }

    function getTempDisabledCountdown(email) {
      const key = email.toLowerCase();
      const timer = tempDisabledTimers[key];
      if (!timer || timer.requeued) return null;
      const elapsed = Date.now() - timer.detectedAt;
      const remaining = Math.max(0, TEMP_DISABLED_COOLDOWN_MS - elapsed);
      if (remaining <= 0) return { text: 'READY', expired: true };
      const mins = Math.floor(remaining / 60000);
      const secs = Math.floor((remaining % 60000) / 1000);
      return { text: `${String(mins).padStart(2,'0')}:${String(secs).padStart(2,'0')}`, expired: false };
    }

    // Start countdown ticker
    function startCredCountdownTicker() {
      if (credCountdownInterval) return;
      credCountdownInterval = setInterval(() => {
        checkTempDisabledExpiry();
        // Only re-render if credentials tab is active and there are active timers
        const ct = document.getElementById('tab-credentials');
        if (ct && ct.classList.contains('active') && Object.keys(tempDisabledTimers).length > 0) {
          renderCredentialsTab();
        }
      }, 1000);
    }

    function getCredOutcome(i, targetFilter = 'both') {
      const r = rows[i];
      if (!r || !r.sites || Object.keys(r.sites).length === 0) return 'queued';
      
      let sitesToProcess = [];
      if (targetFilter === 'joe' && r.sites['joe']) sitesToProcess.push(r.sites['joe']);
      else if (targetFilter === 'ignition' && r.sites['ignition']) sitesToProcess.push(r.sites['ignition']);
      else if (targetFilter === 'both') sitesToProcess = Object.values(r.sites);

      if (sitesToProcess.length === 0) return 'queued';

      const outcomes = sitesToProcess.map(s => s.outcome);
      if (outcomes.includes('success')) return 'success';
      if (outcomes.includes('2FA')) return '2FA';
      if (outcomes.includes('testing')) return 'testing';
      if (outcomes.includes('tempdisabled')) return 'tempdisabled';
      if (outcomes.includes('permdisabled')) return 'permdisabled';
      if (outcomes.includes('blocked')) return 'blocked';
      if (outcomes.includes('noaccount')) return 'noaccount';
      if (outcomes.includes('failed')) return 'failed';
      return 'queued';
    }

    function getCredAttempts(i, targetFilter = 'both') {
      const r = rows[i];
      if (!r || !r.sites) return 0;
      let sitesToProcess = [];
      if (targetFilter === 'joe' && r.sites['joe']) sitesToProcess.push(r.sites['joe']);
      else if (targetFilter === 'ignition' && r.sites['ignition']) sitesToProcess.push(r.sites['ignition']);
      else if (targetFilter === 'both') sitesToProcess = Object.values(r.sites);
      return sitesToProcess.reduce((s, x) => s + (x.attempts || 0), 0);
    }

    function getCredLastTime(i, targetFilter = 'both') {
      const r = rows[i];
      if (!r || !r.sites) return '';
      let sitesToProcess = [];
      if (targetFilter === 'joe' && r.sites['joe']) sitesToProcess.push(r.sites['joe']);
      else if (targetFilter === 'ignition' && r.sites['ignition']) sitesToProcess.push(r.sites['ignition']);
      else if (targetFilter === 'both') sitesToProcess = Object.values(r.sites);

      let latest = '';
      sitesToProcess.forEach(x => { if (x.timestamp && x.timestamp > latest) latest = x.timestamp; });
      return latest;
    }

    function getCredProxy(i) {
      const r = rows[i];
      if (!r) return '';
      return r.proxy || r.lastProxy || '';
    }

    function credPillClass(outcome) {
      const m = { success:'p-success', failed:'p-failed', '2FA':'p-2fa', blocked:'p-blocked', noaccount:'p-noaccount', testing:'p-testing', queued:'p-queued', tempdisabled:'p-tempdisabled', permdisabled:'p-permdisabled' };
      return m[outcome] || 'p-queued';
    }

    function credPillLabel(outcome) {
      const m = { success:'✓ Success', failed:'✗ Failed', '2FA':'🔐 2FA', blocked:'🛡 Blocked', noaccount:'👻 No Account', testing:'⏳ Testing', queued:'📋 Queued', tempdisabled:'⏸ Temp Disabled', permdisabled:'🚫 Perm Disabled' };
      return m[outcome] || outcome;
    }

    function credRowClass(outcome) {
      if (outcome === 'success') return 'row-success';
      if (outcome === 'failed' || outcome === 'permdisabled' || outcome === 'noaccount') return 'row-failed';
      if (outcome === 'testing') return 'row-testing';
      if (outcome === 'tempdisabled') return 'row-tempdisabled';
      return '';
    }

    function credSetSort(col) {
      const el = document.getElementById('credSortBy');
      const dir = document.getElementById('credSortDir');
      if (el.value === col) { dir.value = dir.value === 'asc' ? 'desc' : 'asc'; }
      else { el.value = col; dir.value = 'asc'; }
      renderCredentialsTab();
    }

    function renderCredentialsTab() {
      const displayToggle = document.getElementById('credDisplayToggle')?.value || 'both';
      const testStatus = document.getElementById('credTestStatus')?.value || 'all';

      // Build indexed data
      const items = credentials.map((c, i) => ({
        idx: i, email: c.email,
        outcome: getCredOutcome(i, displayToggle),
        attempts: getCredAttempts(i, displayToggle),
        time: getCredLastTime(i, displayToggle),
        proxy: getCredProxy(i),
        row: rows[i]
      }));

      // Filter
      const q = (document.getElementById('credSearchBox')?.value || '').toLowerCase();
      const of = document.getElementById('credFilterOutcome')?.value || 'all';
      let filtered = items.filter(it => {
        if (q && !it.email.toLowerCase().includes(q) && !it.outcome.toLowerCase().includes(q)) return false;
        if (of !== 'all' && it.outcome !== of) return false;
        
        const isTested = it.outcome !== 'queued' && it.outcome !== 'N/A';
        if (testStatus === 'untested' && isTested) return false;
        if (testStatus === 'resulted' && !isTested) return false;

        return true;
      });

      // Sort
      const sortBy = document.getElementById('credSortBy')?.value || 'index';
      const sortDir = document.getElementById('credSortDir')?.value || 'asc';
      const dir = sortDir === 'desc' ? -1 : 1;
      filtered.sort((a, b) => {
        if (sortBy === 'email') return dir * a.email.localeCompare(b.email);
        if (sortBy === 'outcome') return dir * a.outcome.localeCompare(b.outcome);
        if (sortBy === 'attempts') return dir * (a.attempts - b.attempts);
        if (sortBy === 'time') return dir * (a.time || '').localeCompare(b.time || '');
        return dir * (a.idx - b.idx);
      });

      // Stats
      const total = credentials.length;
      const counts = { queued:0, testing:0, success:0, failed:0, blocked:0, '2FA':0, noaccount:0, tempdisabled:0, permdisabled:0 };
      items.forEach(it => { counts[it.outcome] = (counts[it.outcome] || 0) + 1; });
      const pct = v => total > 0 ? (v / total * 100).toFixed(1) + '%' : '—';
      const setT = (id, val) => { const el = document.getElementById(id); if (el) el.textContent = val; };
      setT('credStatTotal', total);
      setT('credStatTotalPct', `${filtered.length} shown`);
      setT('credStatQueued', counts.queued);
      setT('credStatQueuedPct', pct(counts.queued));
      setT('credStatTesting', counts.testing);
      setT('credStatTestingPct', pct(counts.testing));
      setT('credStatSuccess', counts.success);
      setT('credStatSucc', counts.success);
      setT('credStatSuccPct', pct(counts.success));
      setT('credStatFailed', counts.failed + counts.noaccount);
      setT('credStatFail', counts.failed + counts.noaccount);
      setT('credStatFailPct', pct(counts.failed + counts.noaccount));
      setT('credStatBlocked', counts.blocked + counts.tempdisabled + counts.permdisabled);
      setT('credStatBlock', counts.blocked + counts.tempdisabled + counts.permdisabled);
      setT('credStatBlockPct', pct(counts.blocked + counts.tempdisabled + counts.permdisabled));

      // Pagination
      const pageSize = parseInt(document.getElementById('credPageSize')?.value || '50');
      const totalPages = Math.max(1, Math.ceil(filtered.length / pageSize));
      if (credPage >= totalPages) credPage = totalPages - 1;
      if (credPage < 0) credPage = 0;
      const start = credPage * pageSize;
      const pageItems = filtered.slice(start, start + pageSize);

      // Render table
      const tbody = document.getElementById('credTableBody');
      if (!tbody) return;
      tbody.innerHTML = pageItems.map(it => {
        const sel = credSelected.has(it.email);
        const rc = credRowClass(it.outcome);
        const sc = sel ? 'row-selected' : '';
        const displayToggle = document.getElementById('credDisplayToggle')?.value || 'both';
        const sitePills = it.row && it.row.sites ? Object.entries(it.row.sites)
          .filter(([name]) => displayToggle === 'both' || displayToggle === name)
          .map(([name, s]) =>
            `<span class="cred-pill ${credPillClass(s.outcome)}" title="${name}: ${s.outcome}">${name.charAt(0).toUpperCase()}:${credPillLabel(s.outcome)}</span>`
          ).join('') : `<span class="cred-pill p-queued">📋 Queued</span>`;
        const tm = it.time ? new Date(it.time).toLocaleString() : '—';
        const batch = it.row ? `${(it.row.currentBatch || 0) + 1}/${it.row.totalBatches || '?'}` : '—';
        const proxy = it.proxy ? it.proxy.replace(/^.*@/, '').substring(0, 20) : '—';
        const rec = it.row?.recordingUrl;
        return `<tr class="${rc} ${sc}" data-email="${ea(it.email)}">
          <td><input type="checkbox" ${sel?'checked':''} onchange="credToggleRow('${ea(it.email)}',this.checked)"></td>
          <td style="color:var(--text3);font-size:10px;">${it.idx + 1}</td>
          <td class="email-cell" onclick="cyberCopy('${ea(it.email)}','Email')" title="${ea(it.email)}">${ea(it.email)}${(() => { const cd = getTempDisabledCountdown(it.email); if (!cd) return ''; return cd.expired ? '<span class="cred-countdown expired"><span class="cd-icon">✅</span> READY</span>' : '<span class="cred-countdown"><span class="cd-icon">⏳</span> ' + cd.text + '</span>'; })()}</td>
          <td><div class="cred-outcome-pills">${sitePills}</div></td>
          <td class="cred-attempts">${it.attempts}</td>
          <td class="cred-time">${tm}</td>
          <td style="font-size:10px;color:var(--text2);">${batch}</td>
          <td class="cred-proxy" title="${ea(it.proxy || '')}">${proxy}</td>
          <td><div class="cred-actions">
            <button class="cred-action-btn" onclick="liveTest('${ea(it.email)}')" title="Live Test">🔬</button>
            <button class="cred-action-btn" onclick="retestCredential('${ea(it.email)}',${it.idx})" title="Retest">🔄</button>
            ${rec ? `<button class="cred-action-btn" onclick="openVideoModal(${ja(rec)},${ja(it.email)})" title="Recording">🎬</button>` : ''}
            <button class="cred-action-btn danger" onclick="credDeleteOne('${ea(it.email)}')" title="Remove">🗑</button>
          </div></td>
        </tr>`;
      }).join('');

      // Pagination info
      const endIdx = Math.min(start + pageSize, filtered.length);
      const pageInfo = document.getElementById('credPageInfo');
      if (pageInfo) {
        pageInfo.textContent = `Showing ${start + 1}–${endIdx} of ${filtered.length}` + (filtered.length !== total ? ` (filtered from ${total})` : '');
      }

      // Pagination buttons
      const btnsEl = document.getElementById('credPageBtns');
      let btns = '';
      btns += `<button class="page-btn" onclick="credPage=0;renderCredentialsTab()" ${credPage===0?'disabled':''}>«</button>`;
      btns += `<button class="page-btn" onclick="credPage--;renderCredentialsTab()" ${credPage===0?'disabled':''}>‹</button>`;
      const maxBtns = 7;
      let bStart = Math.max(0, credPage - Math.floor(maxBtns/2));
      let bEnd = Math.min(totalPages, bStart + maxBtns);
      if (bEnd - bStart < maxBtns) bStart = Math.max(0, bEnd - maxBtns);
      for (let p = bStart; p < bEnd; p++) {
        btns += `<button class="page-btn ${p===credPage?'active':''}" onclick="credPage=${p};renderCredentialsTab()">${p+1}</button>`;
      }
      btns += `<button class="page-btn" onclick="credPage++;renderCredentialsTab()" ${credPage>=totalPages-1?'disabled':''}>›</button>`;
      btns += `<button class="page-btn" onclick="credPage=${totalPages-1};renderCredentialsTab()" ${credPage>=totalPages-1?'disabled':''}>»</button>`;
      btnsEl.innerHTML = btns;

      // Bulk bar
      const bulkBar = document.getElementById('credBulkBar');
      if (credSelected.size > 0) {
        bulkBar.style.display = 'flex';
        document.getElementById('credBulkCount').textContent = `${credSelected.size} selected`;
      } else {
        bulkBar.style.display = 'none';
      }
    }

    function credToggleRow(email, checked) {
      if (checked) credSelected.add(email); else credSelected.delete(email);
      renderCredentialsTab();
    }

    function credToggleMasterCheck(checked) {
      if (checked) credentials.forEach(c => credSelected.add(c.email));
      else credSelected.clear();
      renderCredentialsTab();
    }

    function credBulkSelectAll() { credentials.forEach(c => credSelected.add(c.email)); renderCredentialsTab(); }
    function credBulkDeselectAll() { credSelected.clear(); renderCredentialsTab(); }

    function credBulkRetest() {
      if (!credSelected.size) return;
      credSelected.forEach(email => {
        const i = credentials.findIndex(c => c.email === email);
        if (i !== -1) retestCredential(email, i);
      });
      addLog('INFO', `🔄 Retest triggered for ${credSelected.size} credentials`);
    }

    function credBulkExport() {
      const emails = [...credSelected].join('\n');
      navigator.clipboard.writeText(emails).then(() => addLog('INFO', `📋 Copied ${credSelected.size} emails to clipboard`));
    }

    function credBulkDelete() {
      if (!confirm(`Delete ${credSelected.size} credentials?`)) return;
      if (ws && ws.readyState === 1) ws.send(JSON.stringify({ type: 'delete-rows', data: { emails: [...credSelected] } }));
      credSelected.clear();
    }

    function credDeleteOne(email) {
      if (!confirm(`Remove ${email}?`)) return;
      if (ws && ws.readyState === 1) ws.send(JSON.stringify({ type: 'delete-rows', data: { emails: [email] } }));
      credSelected.delete(email);
    }

    function credExportCSV() {
      const header = 'Index,Email,Outcome,Attempts,LastTested,Batch,Proxy';
      const lines = credentials.map((c, i) => {
        const oc = getCredOutcome(i);
        const att = getCredAttempts(i);
        const tm = getCredLastTime(i) || '';
        const r = rows[i];
        const batch = r ? `${(r.currentBatch||0)+1}/${r.totalBatches||'?'}` : '';
        const proxy = getCredProxy(i);
        return `${i+1},"${c.email}",${oc},${att},"${tm}","${batch}","${proxy}"`;
      });
      const csv = [header, ...lines].join('\n');
      const blob = new Blob([csv], { type: 'text/csv' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `credentials-export-${new Date().toISOString().slice(0,10)}.csv`;
      a.click();
      addLog('INFO', `⬇ Exported ${credentials.length} credentials as CSV`);
    }

    function credExportSuccessEmails() {
      const emails = credentials.filter((_, i) => getCredOutcome(i) === 'success').map(c => c.email);
      navigator.clipboard.writeText(emails.join('\n')).then(() => addLog('INFO', `📋 Copied ${emails.length} success emails`));
    }

    function credExportFailedEmails() {
      const failTypes = ['failed', 'noaccount', 'permdisabled', 'blocked'];
      const emails = credentials.filter((_, i) => failTypes.includes(getCredOutcome(i))).map(c => c.email);
      navigator.clipboard.writeText(emails.join('\n')).then(() => addLog('INFO', `📋 Copied ${emails.length} failed emails`));
    }

    /* ═══════ HERMES DASHBOARD FUNCTIONS ═══════ */
    let hermesData = { alive: false, upSince: null, reviewCount: 0, lastReviewAt: null, patchesApplied: 0, toolCalls: 0, errors: 0, autoReviewEnabled: true, autoReviewIntervalMin: 30, recentLogs: [] };

    function updateHermesUI(d) {
      if (!d) return;
      hermesData = Object.assign({}, hermesData, d);
      var dot = document.getElementById('hermesStatusDot');
      var navDot = document.getElementById('hermesNavDot');
      var label = document.getElementById('hermesStatusLabel');
      if (dot) { dot.className = 'hermes-status-dot ' + (d.alive ? 'alive' : 'dead'); }
      if (navDot) { navDot.className = 'hdot ' + (d.alive ? 'on' : 'off'); }
      if (label) { label.textContent = d.alive ? 'ONLINE' : 'OFFLINE'; label.style.color = d.alive ? 'var(--green)' : 'var(--red)'; }
      var setH = function(id, val) { var el = document.getElementById(id); if (el) el.textContent = String(val != null ? val : 0); };
      setH('hermesReviewCount', d.reviewCount);
      setH('hermesToolCalls', d.toolCalls);
      setH('hermesPatchCount', d.patchesApplied);
      setH('hermesErrorCount', d.errors);
      setH('hermesActiveSessions', d.activeSessions || 0);
      var ut = document.getElementById('hermesUptime');
      if (ut && d.upSince) {
        var sec = Math.floor((Date.now() - new Date(d.upSince).getTime()) / 1000);
        var h = Math.floor(sec / 3600), m2 = Math.floor((sec % 3600) / 60), s = sec % 60;
        ut.textContent = h + 'h ' + m2 + 'm ' + s + 's';
      } else if (ut) { ut.textContent = '\u2014'; }
      var lr = document.getElementById('hermesLastReview');
      if (lr) { lr.textContent = d.lastReviewAt ? new Date(d.lastReviewAt).toLocaleTimeString() : '\u2014'; }
      var arEl = document.getElementById('hermesAutoReview');
      if (arEl) arEl.checked = !!d.autoReviewEnabled;
      var intEl = document.getElementById('hermesInterval');
      if (intEl) intEl.value = d.autoReviewIntervalMin || 30;
      if (d.recentLogs && d.recentLogs.length > 0) { renderHermesLog(d.recentLogs); }
    }
    function renderHermesLog(logs) {
      var feed = document.getElementById('hermesLogFeed');
      if (!feed) return;
      var count = document.getElementById('hermesLogCount');
      if (count) count.textContent = logs.length + ' entries';
      feed.innerHTML = logs.map(function(l) {
        var t = new Date(l.ts).toLocaleTimeString();
        return '<div class="hermes-log-entry"><span class="hl-time">' + t + '</span><span class="hl-level ' + l.level + '">' + l.level + '</span><span>' + escHtml(l.msg) + '</span></div>';
      }).join('');
    }
    function escHtml(s) { return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }
    function handleObserverStats(d) {
      var setO = function(id, val) { var el = document.getElementById(id); if (el) el.textContent = String(val != null ? val : 0); };
      setO('observerLlmCalls', d.llmCalls);
      setO('observerInsights', d.insights);
      setO('observerScreenshots', d.screenshots);
      setO('observerAnomalies', d.anomalies);
      setO('observerAvgLatency', d.avgLatency ? d.avgLatency + 'ms' : '\u2014');
      var status = document.getElementById('observerStatus');
      if (status) {
        status.textContent = d.activeSessions > 0 ? 'ACTIVE (' + d.activeSessions + ' sessions)' : 'STANDBY';
        status.style.color = d.activeSessions > 0 ? 'var(--green)' : 'var(--text3)';
      }
    }
    function handleObserverBatchAnalysis(d) {
      if (d.deepAnalysis) {
        var feed = document.getElementById('insightsFeed');
        if (feed) {
          var ts = new Date().toLocaleTimeString();
          feed.innerHTML = '<div style="padding:6px 8px;background:rgba(168,85,247,0.05);border-left:2px solid #a855f7;margin-bottom:6px;border-radius:4px;"><div style="color:#a855f7;font-size:9px;margin-bottom:3px;">' + ts + ' Post-Batch</div><div style="color:var(--text2);">' + escHtml(d.deepAnalysis).substring(0, 500) + '</div></div>' + feed.innerHTML;
        }
      }
      if (d.proposals && d.proposals.length > 0) { handleObserverProposals(d.proposals); }
    }
    function handleObserverProposals(proposals) {
      var list = document.getElementById('proposalsList');
      if (!list || !proposals || proposals.length === 0) return;
      var countEl = document.getElementById('proposalCount');
      var pending = proposals.filter(function(p) { return p.status === 'pending'; });
      if (countEl) countEl.textContent = pending.length + ' pending';
      list.innerHTML = proposals.slice(0, 10).map(function(p) {
        var sc = p.status === 'pending' ? '#f59e0b' : p.status === 'approved' ? '#4ade80' : '#ef4444';
        return '<div style="padding:6px 8px;background:rgba(0,0,0,0.2);border-radius:4px;margin-bottom:4px;"><span style="color:var(--cyan);">' + escHtml(p.constant || '?') + '</span> <span style="color:var(--text3);">' + p.currentValue + 'ms</span> -> <span style="color:var(--green);">' + p.proposedValue + 'ms</span> <span style="font-size:9px;color:' + sc + ';float:right;">' + (p.status || 'pending') + '</span></div>';
      }).join('');
    }
    function hermesReviewNow() {
      if (!ws || ws.readyState !== WebSocket.OPEN) return showCyberToast('Not connected');
      ws.send(JSON.stringify({ type: 'hermes-review' }));
      showCyberToast('Hermes review triggered');
    }
    function hermesRestart() {
      if (!ws || ws.readyState !== WebSocket.OPEN) return showCyberToast('Not connected');
      ws.send(JSON.stringify({ type: 'hermes-restart' }));
      showCyberToast('Hermes restarting...');
    }
    function hermesSetAutoReview(enabled) {
      if (!ws || ws.readyState !== WebSocket.OPEN) return;
      ws.send(JSON.stringify({ type: 'hermes-set-auto-review', data: { enabled: enabled } }));
    }
    function hermesSetInterval(minutes) {
      if (!ws || ws.readyState !== WebSocket.OPEN) return;
      ws.send(JSON.stringify({ type: 'hermes-set-interval', data: { minutes: parseInt(minutes) } }));
    }
    setInterval(function() {
      var tab = document.getElementById('tab-hermes');
      if (tab && tab.classList.contains('active') && hermesData.upSince) {
        var ut = document.getElementById('hermesUptime');
        if (ut) {
          var sec = Math.floor((Date.now() - new Date(hermesData.upSince).getTime()) / 1000);
          var h = Math.floor(sec / 3600), m2 = Math.floor((sec % 3600) / 60), s = sec % 60;
          ut.textContent = h + 'h ' + m2 + 'm ' + s + 's';
        }
      }
    }, 1000);
    connect(); bindSettingsEvents(); setTimeout(function() { drawSuccessRateChart(); }, 100); startCredCountdownTicker();
  

  window.downloadLogs = function() {
      const logBody = document.getElementById('logBody');
      let text = "";
      logBody.querySelectorAll('.log-line').forEach(line => text += line.innerText + "\n");
      const blob = new Blob([text], { type: 'text/plain' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = 'ignition_logs.txt';
      a.click();
  };
  
async function fetchGoldenStats() {
  const container = document.getElementById('goldenStatsContainer');
  if (!container) return;
  try {
    container.innerHTML = "Fetching latest stats...";
    const res = await fetch('/api/golden/stats');
    const data = await res.json();
    if (data.error) {
      container.innerHTML = `<div style="color:var(--amber)">${data.error}</div>`;
      return;
    }
    const d = new Date(data.timestamp).toLocaleString();
    let html = `<div style="margin-bottom:10px; color:var(--text3);">Last Run: ${d}</div>`;
    if (data.winner) {
      html += `<div style="margin-bottom:10px; font-weight:bold; color:var(--green);">👑 Winner: ${data.winner}</div>`;
    } else {
      html += `<div style="margin-bottom:10px; font-weight:bold; color:var(--red);">❌ No Winner</div>`;
    }
    
    html += `<table class="cred-table" style="width:100%; border-collapse: collapse; margin-top: 10px;">
      <thead>
        <tr>
          <th style="text-align:left; padding:4px;">Backend</th>
          <th style="text-align:left; padding:4px;">Status</th>
          <th style="text-align:left; padding:4px;">Joe</th>
          <th style="text-align:left; padding:4px;">Ignition</th>
          <th style="text-align:left; padding:4px;">Total</th>
          <th style="text-align:left; padding:4px;">Honeypots</th>
          <th style="text-align:left; padding:4px;">Burns</th>
        </tr>
      </thead>
      <tbody>`;
      
    data.leaderboard.forEach(row => {
      const isWinner = row.winner;
      const rowStyle = isWinner ? `background: rgba(34, 197, 94, 0.1); border-left: 2px solid var(--green);` : "";
      html += `<tr style="${rowStyle}">
        <td style="padding:4px;">${row.backend} ${isWinner ? '👑' : ''}</td>
        <td style="padding:4px;">${row.status}</td>
        <td style="padding:4px;">${row.joeTime ? (row.joeTime/1000).toFixed(1)+'s' : (row.joeStatus || '-')}</td>
        <td style="padding:4px;">${row.ignitionTime ? (row.ignitionTime/1000).toFixed(1)+'s' : (row.ignitionStatus || '-')}</td>
        <td style="padding:4px;">${(row.totalTime/1000).toFixed(1)}s</td>
        <td style="padding:4px;">${row._honeypots}</td>
        <td style="padding:4px;">${row._burns}</td>
      </tr>`;
    });
    html += `</tbody></table>`;
    container.innerHTML = html;
  } catch(e) {
    container.innerHTML = `<div style="color:var(--red)">Failed to fetch stats: ${e.message}</div>`;
  }
}

// Call once immediately
setTimeout(fetchGoldenStats, 1000);

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

window.startAutonomousBatch = function() {
    fetch('/api/orchestrator/start', { method: 'POST' })
    .then(res => res.json())
    .then(data => {
         alert('🚀 Master Orchestrator Daemon started! God Mode activated.');
    })
    .catch(e => alert('Failed to start orchestrator: ' + e));
};

    function toggleHeroBanner() {
      const b = document.getElementById('heroBanner');
      if(b) {
         if (b.style.display === 'none') b.style.display = 'block';
         else b.style.display = 'none';
      }
    }

// ═══════ GLOBALLY EXPOSED INLINE HANDLERS ═══════
function uploadCsv(f) {
  if (typeof handleUploadFile === 'function') handleUploadFile(f);
}
window.uploadCsv = uploadCsv;

function updateProxyPreview() {
  const url = document.getElementById('settingsProxyUrl')?.value?.trim() || '';
  const statusEl = document.getElementById('proxyStatusText');
  const dot = document.getElementById('proxyDot');
  if (!statusEl || !dot) return;
  if (!url) {
    statusEl.textContent = 'Not tested';
    statusEl.style.color = 'var(--text3)';
    dot.className = 'proxy-dot';
  } else {
    statusEl.textContent = 'Configured (pending test)';
    statusEl.style.color = 'var(--cyan)';
    dot.className = 'proxy-dot proxy-dot-active';
  }
}
window.updateProxyPreview = updateProxyPreview;

function testProxyConnection() {
  const url = document.getElementById('settingsProxyUrl')?.value?.trim() || '';
  const statusEl = document.getElementById('proxyStatusText');
  const dot = document.getElementById('proxyDot');
  if (!url) {
    alert('Please enter a proxy URL first');
    return;
  }
  if (statusEl) { statusEl.textContent = 'Testing connection...'; statusEl.style.color = 'var(--amber)'; }
  if (dot) dot.className = 'proxy-dot proxy-dot-testing';
  
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: 'proxy-test', data: { url } }));
    showCyberToast('Testing proxy connection...');
  } else {
    setTimeout(() => {
      if (statusEl) { statusEl.textContent = 'Proxy valid'; statusEl.style.color = 'var(--green)'; }
      if (dot) dot.className = 'proxy-dot proxy-dot-alive';
      showCyberToast('Proxy connection simulated OK');
    }, 600);
  }
}
window.testProxyConnection = testProxyConnection;

function forceWakeAllTempDisabled() {
  const emails = Object.keys(tempDisabledTimers);
  if (emails.length === 0) return alert('No temp-disabled credentials currently in cooldown');
  if (!confirm(`Force wake ${emails.length} temp-disabled credentials immediately?`)) return;
  emails.forEach(email => {
    sendWsMessage({ type: 'force-wake', data: { email } });
  });
  tempDisabledTimers = {};
  showCyberToast(`Force-waking ${emails.length} credentials...`);
  renderCredentialsTab();
}
window.forceWakeAllTempDisabled = forceWakeAllTempDisabled;

function hermesForceReview() {
  return hermesReviewNow();
}
window.hermesForceReview = hermesForceReview;

function hermesResetMemory() {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: 'hermes-reset-memory' }));
  }
  showCyberToast('Hermes memory cache reset');
}
window.hermesResetMemory = hermesResetMemory;

function hermesExportLog() {
  const logs = (hermesData && hermesData.recentLogs) ? hermesData.recentLogs : [];
  const blob = new Blob([JSON.stringify(logs, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `hermes-review-log-${Date.now()}.json`;
  a.click();
  showCyberToast('Exported Hermes review log');
}
window.hermesExportLog = hermesExportLog;
window.toggleCommandPalette = toggleCmdPalette;

