# Session Research Notes — Aug 5, 2026

## Microsoft UFO Galaxy Integration
- Source: https://github.com/microsoft/ufo + https://microsoft.github.io/UFO/
- UFO³ Galaxy uses **WebSocket-based AIP (Agent Interaction Protocol)** for device agent communication
- Integration approach: Register automation-engine as a Galaxy **Linux device agent**
- Galaxy sends tasks via AIP WebSocket messages; we bridge to our existing WS server
- Key config: `config/galaxy/devices.yaml` registers devices; `config/galaxy/agent.yaml` has LLM keys
- AIP protocol: WebSocket-based, fault-tolerant, auto-reconnect
- Galaxy can orchestrate our engine as part of DAG-based multi-device workflows
- MCP integration is planned/available — our engine can expose tools via MCP to Galaxy

## Golden Credentials
- Loaded from env vars: `GOLDEN_CRED_JOE=email:password` OR `JOE_EMAIL` + `JOE_PASSWORD`
- Same pattern for Ignition: `GOLDEN_CRED_IGNITION=email:password`
- File: `src/services/private-golden-credentials.ts`
- No hardcoded credentials in repo — must be in `.env`

## Dashboard Current State
- Port: 9223 (not 3000)
- HTML: `public/index.html` (1099 lines)
- CSS: `public/css/style.css` (2649 lines)
- JS: `public/js/app.js`
- Design tokens: `--bg: #020305`, `--cyan: #22d3ee`, `--red: #ef4444`, `--purple: #a78bfa`
- Fonts: Inter, JetBrains Mono, Outfit
- Current issues: large hero banner, cramped emoji nav tabs, no sidebar, no proxy wizard, no UFO panel

## Server Architecture
- Express + WebSocket server: `src/server/server.ts`
- WebSocket messages: init, row-update, log, vitals, started, complete, config-sync, etc.
- Settings tab has: proxy pool select, proxy rotate URL input, golden benchmark section
- Proxy pool config: pool "6" = Flame Sticky AU (no actual URLs stored in repo)

## Backends Available
- `stealth` (Camoufox/Firefox-based)
- `cloak-headless`, `cloak-headed` (CloakBrowser/Chromium)
- `zendriver`, `zendriver-headed` (Python zendriver)
- `spider`, `spider-cloud`, `spider-local` (Spider.rs — disabled by default)

## Package Scripts Added
- `npm run setup` → `bash setup.sh`
- `npm run dev` → `npx tsx src/server/server.ts`
- `npm run golden` → golden watcher
- `npm run pm2` → pm2 daemon

## Dependency Update Summary (done)
- 19 packages updated; better-sqlite3 held at v12 (v13 segfaults); typescript held at v6 (v7 breaks eslint)
- camoufox-js held at 0.11.5 (0.12.0 requires playwright-core <1.61.0)
