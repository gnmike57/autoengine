/**
 * galaxy.js — UFO Galaxy AIP Device Agent Integration
 * Connects the automation-engine to Microsoft UFO Galaxy as a registered device agent.
 * Protocol: WebSocket JSON messages following the AIP (Agent Interaction Protocol).
 */

(function () {
  'use strict';

  let galaxyWs = null;
  let galaxyReconnectTimer = null;
  let galaxyConnected = false;

  // ─── UI helpers ──────────────────────────────────────────────────────────────

  function setGalaxyStatus(connected, label) {
    galaxyConnected = connected;
    const dot = document.getElementById('galaxyDot');
    const txt = document.getElementById('galaxyConnStatus');
    const sidebarDot = document.getElementById('galaxySidebarDot');
    if (dot) {
      dot.style.background = connected ? 'var(--green)' : 'var(--text3)';
      dot.style.boxShadow = connected ? '0 0 8px var(--green)' : 'none';
    }
    if (txt) txt.textContent = label || (connected ? 'Connected' : 'Disconnected');
    if (sidebarDot) {
      sidebarDot.style.background = connected ? 'var(--green)' : 'transparent';
    }
  }

  function appendGalaxyFeed(type, message, payload) {
    const feed = document.getElementById('galaxyTaskFeed');
    if (!feed) return;
    const empty = feed.querySelector('[data-empty]');
    if (empty) empty.remove();

    const ts = new Date().toLocaleTimeString('en-AU', { hour12: false });
    const colors = { task: 'var(--cyan)', result: 'var(--green)', error: 'var(--red)', info: 'var(--text2)', ack: 'var(--purple)' };
    const color = colors[type] || 'var(--text2)';

    const row = document.createElement('div');
    row.style.cssText = `display:flex;gap:8px;padding:6px 0;border-bottom:1px solid var(--border);font-family:'JetBrains Mono',monospace;font-size:10px;`;
    row.innerHTML = `
      <span style="color:var(--text3);white-space:nowrap;">${ts}</span>
      <span style="color:${color};font-weight:700;white-space:nowrap;">[${type.toUpperCase()}]</span>
      <span style="color:var(--text);flex:1;word-break:break-word;">${message}</span>
      ${payload ? `<button onclick="this.nextElementSibling.style.display=this.nextElementSibling.style.display==='none'?'block':'none'" style="background:none;border:1px solid var(--border);color:var(--text3);padding:1px 4px;border-radius:3px;cursor:pointer;font-size:9px;">JSON</button><pre style="display:none;background:var(--bg3);padding:6px;border-radius:4px;margin:4px 0 0;overflow-x:auto;font-size:9px;color:var(--text2);">${JSON.stringify(payload, null, 2)}</pre>` : ''}
    `;
    feed.appendChild(row);
    feed.scrollTop = feed.scrollHeight;
  }

  // ─── AIP message handlers ─────────────────────────────────────────────────

  function handleGalaxyMessage(msg) {
    const { type, task_id, action, payload } = msg;

    appendGalaxyFeed('task', `${action || type}${task_id ? ' [' + task_id + ']' : ''}`, payload);

    switch (action || type) {
      case 'start_batch': {
        const cfg = payload || {};
        if (typeof sendWsMessage === 'function') {
          sendWsMessage({ type: 'start', data: cfg });
          galaxyAck(task_id, 'start_batch dispatched', { status: 'running' });
        } else {
          galaxyError(task_id, 'Engine WebSocket not connected');
        }
        break;
      }
      case 'stop_batch': {
        if (typeof sendWsMessage === 'function') {
          sendWsMessage({ type: 'stop' });
          galaxyAck(task_id, 'stop_batch dispatched', { status: 'stopping' });
        }
        break;
      }
      case 'get_status': {
        const status = {
          connected: typeof ws !== 'undefined' && ws && ws.readyState === 1,
          rows: typeof rows !== 'undefined' ? rows.length : 0,
          active: typeof rows !== 'undefined' ? rows.filter(r => r.status === 'testing').length : 0,
          success: typeof rows !== 'undefined' ? rows.filter(r => Object.values(r.sites || {}).some(s => s.outcome === 'success')).length : 0,
        };
        galaxyAck(task_id, 'status', status);
        break;
      }
      case 'get_results': {
        const results = typeof rows !== 'undefined'
          ? rows.filter(r => Object.values(r.sites || {}).some(s => s.outcome === 'success'))
              .map(r => ({ email: r.email, sites: r.sites }))
          : [];
        galaxyAck(task_id, 'results', { count: results.length, results });
        break;
      }
      case 'set_backend': {
        const backend = payload?.backend;
        if (backend) {
          const el = document.getElementById('settingsBackend');
          if (el) el.value = backend;
          galaxyAck(task_id, 'backend set', { backend });
        }
        break;
      }
      case 'set_proxy': {
        const proxyUrl = payload?.proxy_url;
        if (proxyUrl) {
          const el = document.getElementById('settingsProxyUrl');
          if (el) el.value = proxyUrl;
          galaxyAck(task_id, 'proxy set', { proxy_url: proxyUrl });
        }
        break;
      }
      case 'upload_credentials': {
        const csvData = payload?.csv;
        if (csvData && typeof sendWsMessage === 'function') {
          sendWsMessage({ type: 'upload-csv', data: { csv: csvData } });
          galaxyAck(task_id, 'credentials uploaded');
        }
        break;
      }
      case 'force_wake_tempdisabled': {
        if (typeof sendWsMessage === 'function') {
          sendWsMessage({ type: 'force-wake-tempdisabled' });
          galaxyAck(task_id, 'force wake dispatched');
        }
        break;
      }
      case 'ping': {
        galaxySend({ type: 'pong', device_id: getGalaxyDeviceId(), ts: Date.now() });
        break;
      }
      default:
        appendGalaxyFeed('info', `Unknown action: ${action || type}`);
    }
  }

  function galaxyAck(task_id, message, data) {
    galaxySend({ type: 'task_result', task_id, status: 'success', message, data });
    appendGalaxyFeed('ack', `ACK: ${message}`, data);
  }

  function galaxyError(task_id, message) {
    galaxySend({ type: 'task_result', task_id, status: 'error', message });
    appendGalaxyFeed('error', `ERR: ${message}`);
  }

  function galaxySend(obj) {
    if (galaxyWs && galaxyWs.readyState === WebSocket.OPEN) {
      galaxyWs.send(JSON.stringify(obj));
    }
  }

  function getGalaxyDeviceId() {
    return (document.getElementById('galaxyDeviceId') || {}).value || 'joeignition-engine-01';
  }

  // ─── Connection management ────────────────────────────────────────────────

  window.galaxyConnect = function () {
    const endpoint = (document.getElementById('galaxyEndpoint') || {}).value || 'ws://localhost:7788';
    const deviceId = getGalaxyDeviceId();

    if (galaxyWs) {
      galaxyWs.close();
      galaxyWs = null;
    }

    setGalaxyStatus(false, 'Connecting...');
    appendGalaxyFeed('info', `Connecting to ${endpoint} as device "${deviceId}"...`);

    try {
      galaxyWs = new WebSocket(endpoint);
    } catch (e) {
      setGalaxyStatus(false, 'Invalid endpoint');
      appendGalaxyFeed('error', `Invalid endpoint: ${e.message}`);
      return;
    }

    galaxyWs.onopen = () => {
      setGalaxyStatus(true, `Connected — ${endpoint}`);
      appendGalaxyFeed('info', 'WebSocket open. Registering device...');
      // AIP device registration
      galaxySend({
        type: 'register_device',
        device_id: deviceId,
        device_type: 'automation_engine',
        capabilities: [
          'start_batch', 'stop_batch', 'get_status', 'get_results',
          'upload_credentials', 'set_backend', 'set_proxy', 'force_wake_tempdisabled'
        ],
        version: '1.0.0',
        ts: Date.now()
      });
    };

    galaxyWs.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data);
        handleGalaxyMessage(msg);
      } catch (e) {
        appendGalaxyFeed('error', `Parse error: ${e.message}`);
      }
    };

    galaxyWs.onerror = (e) => {
      setGalaxyStatus(false, 'Connection error');
      appendGalaxyFeed('error', 'WebSocket error — check endpoint and that Galaxy is running');
    };

    galaxyWs.onclose = (e) => {
      setGalaxyStatus(false, `Disconnected (code ${e.code})`);
      appendGalaxyFeed('info', `Connection closed. Code: ${e.code}`);
      galaxyWs = null;
      // Auto-reconnect after 15s
      if (!e.wasClean) {
        clearTimeout(galaxyReconnectTimer);
        galaxyReconnectTimer = setTimeout(() => {
          appendGalaxyFeed('info', 'Auto-reconnecting...');
          window.galaxyConnect();
        }, 15000);
      }
    };
  };

  window.galaxyDisconnect = function () {
    clearTimeout(galaxyReconnectTimer);
    if (galaxyWs) {
      galaxyWs.close(1000, 'User disconnected');
      galaxyWs = null;
    }
    setGalaxyStatus(false, 'Disconnected');
  };

  window.galaxyClearFeed = function () {
    const feed = document.getElementById('galaxyTaskFeed');
    if (feed) feed.innerHTML = '<div data-empty style="color:var(--text3);font-size:10px;font-family:\'JetBrains Mono\',monospace;padding:8px;">Connect to UFO Galaxy to receive tasks...</div>';
  };

  window.galaxyDispatchManual = function () {
    const type = (document.getElementById('galaxyManualTaskType') || {}).value;
    const payloadStr = (document.getElementById('galaxyManualPayload') || {}).value || '{}';
    try {
      const payload = JSON.parse(payloadStr);
      const msg = { type: 'task', action: type, task_id: 'manual-' + Date.now(), payload };
      handleGalaxyMessage(msg);
    } catch (e) {
      appendGalaxyFeed('error', `Invalid JSON payload: ${e.message}`);
    }
  };

  // ─── Proxy test ───────────────────────────────────────────────────────────

  window.testProxyConnection = async function () {
    const url = (document.getElementById('settingsProxyUrl') || {}).value;
    const dot = document.getElementById('proxyDot');
    const txt = document.getElementById('proxyStatusText');
    if (!url) { if (txt) txt.textContent = 'Enter a proxy URL first'; return; }
    if (txt) txt.textContent = 'Testing...';
    if (dot) { dot.style.background = 'var(--amber)'; dot.style.boxShadow = '0 0 6px var(--amber)'; }
    try {
      if (typeof sendWsMessage === 'function') {
        sendWsMessage({ type: 'test-proxy', data: { url } });
        if (txt) txt.textContent = 'Test dispatched — check terminal for result';
      } else {
        if (txt) txt.textContent = 'Engine not connected';
      }
    } catch (e) {
      if (dot) { dot.style.background = 'var(--red)'; dot.style.boxShadow = '0 0 6px var(--red)'; }
      if (txt) txt.textContent = 'Error: ' + e.message;
    }
  };

  // Handle proxy test result from engine WS
  document.addEventListener('engine-proxy-test-result', (e) => {
    const { ok, latencyMs, ip } = e.detail || {};
    const dot = document.getElementById('proxyDot');
    const txt = document.getElementById('proxyStatusText');
    if (ok) {
      if (dot) { dot.style.background = 'var(--green)'; dot.style.boxShadow = '0 0 8px var(--green)'; }
      if (txt) txt.textContent = `OK — ${ip || 'unknown IP'} — ${latencyMs}ms`;
    } else {
      if (dot) { dot.style.background = 'var(--red)'; dot.style.boxShadow = '0 0 6px var(--red)'; }
      if (txt) txt.textContent = 'Failed — proxy unreachable';
    }
  });

})();
