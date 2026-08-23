# Setup & Operations Guide

This guide provides end-to-end setup, environment configuration, proxy pool connectivity, and operational instructions for running the Automation Engine.

---

## 📋 System Prerequisites

- **Node.js**: `v20.x` or higher
- **Package Manager**: `npm`
- **Operating Systems**: macOS (Apple Silicon / Intel), Windows 10/11, Ubuntu/Debian Linux
- **WireGuard / Wireproxy** (Optional for Mullvad residential proxy forwarders)

---

## 🔧 Environment Configuration (`.env`)

Create a `.env` file in the root workspace directory based on `.env.example`:

```env
# Server Configuration
PORT=3011
ENGINE_CONCURRENCY=3
DEFAULT_BACKEND=stealth
HEADLESS_MODE=true

# Database Configuration
DATABASE_URL=data/credentials.sqlite

# Proxy Configuration
PROXY_POOL_1=http://user:pass@proxy-node-1.net:8080
PROXY_POOL_2=http://user:pass@proxy-node-2.net:8080
PROXY_POOL_3=http://user:pass@proxy-node-3.net:8080
MULLVAD_ACCOUNT_ID=5901587210529138

# AI & Verification Keys (Optional for Video Verification Fallback)
ANTHROPIC_API_KEY=
OPENAI_API_KEY=
GEMINI_API_KEY=
```

---

## 🚀 Running the Engine

### 1. Start GUI & Engine Server
```bash
npm start
```
The server will initialize the SQLite database in WAL mode, start background zombie cleanup monitors, and expose:
- **Web UI / Dashboard**: `http://localhost:3011`
- **WebSocket Feeds**: Real-time log streams, screenshot streams, and telemetry updates.

### 2. Autonomous Batch Execution via CLI

Run a batch with headless stealth mode:
```bash
npx tsx src/scripts/cli-start-batch.ts --backend=stealth --concurrency=3
```

Run Darwin Natural Selection Mode to auto-evaluate and discover the optimal backend:
```bash
npx tsx src/scripts/cli-start-batch.ts --backend=darwin --concurrency=3
```

Live-adjust concurrency while a batch is executing:
```bash
npx tsx src/scripts/cli-set-concurrency.ts --concurrency=4
```

### 3. Verify Codebase Integrity
Run the comprehensive 5-layer system audit and TypeScript strict checks:
```bash
npm run audit:all
npm run typecheck
```

---

## 🦎 Darwin Mode Operational Flow

1. **Candidate Rotation**: Evaluates `stealth`, `stealth-headed`, `cloak-headless`, `cloak-headed`, `cloak-headless-nocloak`, `cloak-headed-nocloak`, `zendriver`, and `zendriver-headed`.
2. **Outcome Tracking**: Each attempt records response times, outcome decisiveness, and WAF blocks.
3. **Auto-Elimination**: Any engine with $\ge 3$ blocks or failures is automatically eliminated.
4. **Optimal Auto-Pivoting**: When statistical confidence is reached, the highest-scoring backend is crowned, logged into `learning/hermes-memory.json`, and the batch is automatically transitioned to run on that winner.
5. **Hard Review & Auto-Mitigation**: If all candidate backends are blocked, Hermes triggers proxy rotation and concurrency reduction before initiating post-mortem analysis.

---

## 🛡️ Cookie Banner Dismissal Rules

On fresh launches for both **Joe Fortune** (`https://www.joefortune.zone/login`) and **Ignition Casino** (`https://www.ignitioncasino.ooo/login`):
- The engine executes a 3-tier cascade (`Native CookieInformation API` → `UI Selector Click` → `CSS Force-Hide`).
- Multi-stage interaction triggers ensure the cookie notice is dismissed at $T+300\text{ms}$, $T+1.5\text{s}$, and $T+3.5\text{s}$ before filling credentials.
