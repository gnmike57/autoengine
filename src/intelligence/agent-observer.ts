import { type Page } from "playwright-core";
import { WebSocketServer, WebSocket } from "ws";
import express from "express";
import fs from "fs";
import path from "path";
import { createLogger } from "../core/logger.js";
import { ConfigStore } from "../core/config-store.js";

const log = createLogger("AgentObserver");

let wss: WebSocketServer | null = null;
let app: express.Express | null = null;
const connectedClients: Set<WebSocket> = new Set();
// Map of active pages for REPL evaluation
const activePages: Map<string, Page> = new Map();

/**
 * Initializes the global WebSocket and REPL servers if they don't exist.
 */
function initGlobalServers() {
    if (wss || app) return;

    // 1. WebSocket Server (Port 8080) for Matrix View Screencasts
    wss = new WebSocketServer({ port: 8080 });
    wss.on('connection', (ws) => {
        connectedClients.add(ws);
        ws.on('close', () => connectedClients.delete(ws));
    });
    log.info("[AGENT-OBSERVER] WebSocket Matrix View Server listening on ws://localhost:8080");

    // 2. HTTP Express Server (Port 9999) for REPL
    app = express();
    app.use(express.json());

    app.post('/repl', async (req, res) => {
        const { sessionId, code } = req.body;
        if (!sessionId || !code) {
            res.status(400).json({ error: "Missing sessionId or code" });
            return;
        }
        const page = activePages.get(sessionId);
        if (!page) {
            res.status(404).json({ error: `Session ${sessionId} not found or inactive` });
            return;
        }
        try {
            log.info(`[AGENT-REPL] Executing code on session: ${sessionId}`);
            const result = await page.evaluate(code);
            res.json({ success: true, result });
        } catch (e: any) {
            res.status(500).json({ success: false, error: e.message });
        }
    });

    app.listen(9999, () => {
        log.info("[AGENT-OBSERVER] HTTP REPL Server listening on http://localhost:9999/repl");
    });
}

export class AgentObserver {

    /**
     * Attaches all live observation hooks to the Playwright Page.
     */
    static async attach(page: Page, sessionId: string) {
        const config = ConfigStore.load();
        if (!config.enableAgentObservation) return;

        initGlobalServers();
        activePages.set(sessionId, page);

        // Ensure crash dumps dir exists for disk saving
        const dumpDir = path.join(process.cwd(), "data", "crash-dumps", "live-stream", sessionId);
        fs.mkdirSync(dumpDir, { recursive: true });

        // 1. Network Waterfall Stream (Req/Res)
        page.on('request', req => {
            if (req.resourceType() === 'document' || req.resourceType() === 'xhr' || req.resourceType() === 'fetch') {
                log.info(`[AGENT-NETWORK] [${sessionId}] REQ: ${req.method()} ${req.url()}`);
            }
        });
        page.on('response', res => {
            const req = res.request();
            if (req.resourceType() === 'document' || req.resourceType() === 'xhr' || req.resourceType() === 'fetch') {
                log.info(`[AGENT-NETWORK] [${sessionId}] RES: ${res.status()} ${req.method()} ${req.url()}`);
            }
        });

        // Cleanup when page closes
        page.on('close', () => {
            activePages.delete(sessionId);
        });

        // 2. DOM Mutation Firehose
        await page.addInitScript((sId) => {
            const observer = new MutationObserver((mutations) => {
                for (const m of mutations) {
                    if (m.type === 'childList' && m.addedNodes.length > 0) {
                        for (const n of Array.from(m.addedNodes)) {
                            if (n.nodeType === 1) { // Element node
                                const el = n as Element;
                                // Ignore script/style/link injections to reduce noise
                                if (['SCRIPT','STYLE','LINK','META'].includes(el.tagName)) continue;
                                const summary = el.outerHTML.substring(0, 150).replace(/\\s+/g, ' ');
                                console.log(`[AGENT-FIREHOSE] [${sId}] Added: ${summary}`);
                            }
                        }
                    } else if (m.type === 'characterData') {
                        console.log(`[AGENT-FIREHOSE] [${sId}] Text Changed: ${m.target.textContent?.substring(0,50)}`);
                    }
                }
            });
            window.addEventListener('DOMContentLoaded', () => {
                observer.observe(document.body, { childList: true, characterData: true, subtree: true });
            });
        }, sessionId);

        page.on('console', msg => {
            if (msg.text().startsWith('[AGENT-FIREHOSE]')) {
                log.info(msg.text());
            }
        });

        // 3. CDP Screencast (The Matrix View)
        let frameCount = 0;
        try {
            const context = page.context();
            const cdp = await context.newCDPSession(page);
            cdp.on('Page.screencastFrame', (event: any) => {
                const { data, sessionId: frameSessionId } = event;
                cdp.send('Page.screencastFrameAck', { sessionId: frameSessionId }).catch(()=>{});

                // Write to disk
                const framePath = path.join(dumpDir, `frame_${String(frameCount).padStart(5, '0')}.jpg`);
                fs.writeFile(framePath, data, 'base64', () => {});
                frameCount++;

                // Broadcast over WebSocket
                const payload = JSON.stringify({ sessionId, type: 'screencast', data });
                for (const client of connectedClients) {
                    if (client.readyState === WebSocket.OPEN) {
                        client.send(payload);
                    }
                }
            });
            await cdp.send('Page.startScreencast', { format: 'jpeg', quality: 50, everyNthFrame: 1 });
            log.info(`[AGENT-OBSERVER] CDP Screencast started for ${sessionId}`);
        } catch (e: any) {
            log.warn(`[AGENT-OBSERVER] CDP Screencast unavailable for ${sessionId} (Likely Camoufox): ${e.message}`);
            // Fallback: poll screenshot every 2 seconds if CDP isn't available
            const interval = setInterval(async () => {
                if (page.isClosed()) {
                    clearInterval(interval);
                    return;
                }
                try {
                    const buffer = await page.screenshot({ type: 'jpeg', quality: 50 });
                    const b64 = buffer.toString('base64');
                    const framePath = path.join(dumpDir, `frame_${String(frameCount).padStart(5, '0')}.jpg`);
                    fs.writeFile(framePath, b64, 'base64', () => {});
                    frameCount++;
                    const payload = JSON.stringify({ sessionId, type: 'screencast', data: b64 });
                    for (const client of connectedClients) {
                        if (client.readyState === WebSocket.OPEN) client.send(payload);
                    }
                } catch { /* ignore screenshot errors */ }
            }, 2000);
            page.on('close', () => clearInterval(interval));
        }
    }

    /**
     * Updates the Headed UI overlay (if in headed mode).
     * Enhanced HUD with IP geo-verification, email, password, attempt counter.
     */
    static async updateOverlay(page: Page, opts: {
        state: string;
        attemptNumber?: number;
        totalAttempts?: number;
        email?: string;
        password?: string;
        siteName?: string;
    }) {
        const config = ConfigStore.load();
        if (!config.enableAgentObservation) return;

        try {
            await page.evaluate(({ s, a, total, email, password, siteName }) => {
                let overlay = document.getElementById('__agent_overlay__');
                const isNew = !overlay;
                if (!overlay) {
                    overlay = document.createElement('div');
                    overlay.id = '__agent_overlay__';
                    Object.assign(overlay.style, {
                        position: 'fixed',
                        top: '8px',
                        right: '8px',
                        zIndex: '2147483647',
                        backgroundColor: 'rgba(15, 15, 30, 0.92)',
                        color: '#e0e0e0',
                        padding: '12px 16px',
                        borderRadius: '10px',
                        fontFamily: '"SF Mono", "Cascadia Code", "Fira Code", monospace',
                        fontSize: '13px',
                        lineHeight: '1.6',
                        pointerEvents: 'none',
                        boxShadow: '0 4px 24px rgba(0,0,0,0.6)',
                        border: '1px solid rgba(255,255,255,0.15)',
                        backdropFilter: 'blur(8px)',
                        minWidth: '280px',
                        maxWidth: '360px',
                    });
                    document.body.appendChild(overlay);

                    // Start session timer
                    (window as any).__agent_start_time__ = Date.now();
                    setInterval(() => {
                        const el = document.getElementById('__agent_timer__');
                        if (el) {
                            const diff = Math.floor((Date.now() - (window as any).__agent_start_time__) / 1000);
                            const m = Math.floor(diff / 60).toString().padStart(2, '0');
                            const sec = (diff % 60).toString().padStart(2, '0');
                            el.innerText = `${m}:${sec}`;
                        }
                    }, 1000);

                    // Fetch IP with geo-verification via ip-api.com
                    fetch('http://ip-api.com/json/?fields=query,country,countryCode,regionName,city')
                        .then(r => r.json())
                        .then((d: any) => {
                            const ipEl = document.getElementById('__agent_ip__');
                            const geoEl = document.getElementById('__agent_geo__');
                            if (ipEl) ipEl.innerText = d.query || 'unknown';
                            if (geoEl) {
                                const isAU = d.countryCode === 'AU';
                                geoEl.innerHTML = isAU
                                    ? `<span style="color:#4caf50">🇦🇺 AU ✅</span>`
                                    : `<span style="color:#f44336">${d.countryCode || '??'} ❌</span>`;
                                geoEl.title = `${d.city}, ${d.regionName}, ${d.country}`;
                            }
                        })
                        .catch(() => {
                            const ipEl = document.getElementById('__agent_ip__');
                            if (ipEl) ipEl.innerText = 'fetch failed';
                        });
                }

                // State color mapping
                const stateColors: Record<string, string> = {
                    'COOKIE_DISMISS': '#ff9800',
                    'FILLING_CREDENTIALS': '#2196f3',
                    'SUBMITTING_FORM': '#e91e63',
                    'WAITING_RESPONSE': '#9c27b0',
                    'RESPONSE_RECEIVED': '#4caf50',
                    'SUCCESS': '#00e676',
                    'FAILED': '#f44336',
                };
                const stateColor = stateColors[s] || '#ffeb3b';

                overlay.innerHTML = `
                    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px;padding-bottom:6px;border-bottom:1px solid rgba(255,255,255,0.1)">
                        <span><span id="__agent_geo__" style="color:#aaa">🌐 ...</span> <span id="__agent_ip__" style="color:#90caf9">fetching...</span></span>
                        <span style="color:#ffeb3b;font-weight:bold">⏱ <span id="__agent_timer__">00:00</span></span>
                    </div>
                    <div style="margin-bottom:4px;color:#90caf9">📧 ${email || 'N/A'}</div>
                    <div style="margin-bottom:6px;color:#ce93d8">🔑 ${password || 'N/A'}</div>
                    <div style="display:flex;justify-content:space-between;align-items:center;padding-top:4px;border-top:1px solid rgba(255,255,255,0.1)">
                        <span style="color:${stateColor};font-weight:bold;text-transform:uppercase;font-size:12px">${siteName ? siteName.toUpperCase() + ' | ' : ''}${s}</span>
                        <span style="color:#fff;font-size:14px;font-weight:bold">${a ?? 1}/${total ?? 4}</span>
                    </div>
                `;

                // Re-fetch IP on new overlay creation (timer/IP persist via innerHTML replacement)
                if (!isNew) {
                    // Re-populate timer (it's reset by innerHTML)
                    const timerEl = document.getElementById('__agent_timer__');
                    if (timerEl && (window as any).__agent_start_time__) {
                        const diff = Math.floor((Date.now() - (window as any).__agent_start_time__) / 1000);
                        const m = Math.floor(diff / 60).toString().padStart(2, '0');
                        const sec = (diff % 60).toString().padStart(2, '0');
                        timerEl.innerText = `${m}:${sec}`;
                    }
                    // Re-populate IP/geo from cached data
                    const cached = (window as any).__agent_geo_cache__;
                    if (cached) {
                        const ipEl = document.getElementById('__agent_ip__');
                        const geoEl = document.getElementById('__agent_geo__');
                        if (ipEl) ipEl.innerText = cached.ip;
                        if (geoEl) geoEl.innerHTML = cached.html;
                    }
                }
            }, {
                s: opts.state,
                a: opts.attemptNumber,
                total: opts.totalAttempts,
                email: opts.email,
                password: opts.password,
                siteName: opts.siteName,
            });
        } catch { /* ignore if page isn't ready or closed */ }
    }

    /**
     * Emits the state to the terminal/stdout.
     */
    static emitState(sessionId: string, state: string) {
        log.info(`[AGENT-STATE] [${sessionId}] 🎯 Transitioned to: ${state}`);
    }
}
