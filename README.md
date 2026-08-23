# Automation Engine

A fully autonomous, 24/7 self-learning multi-backend web automation engine designed for high-resilience credential validation, behavioral testing, and target site classification.

This engine utilizes high-performance browser backends, dynamic fingerprinting, AI DOM self-healing, deterministic telemetry, and the **Darwin Natural Selection Engine** to evaluate and auto-pivot to optimal execution configurations in real time.

---

## 🚀 Key Architectural Capabilities

- **🦎 Darwin Natural Selection Mode**: Evaluates multiple candidate backends concurrently, scores resilience using a weighted multi-variable formula ($500 \times \text{decisiveRate} + 300 \times \text{successRate} - 400 \times \text{blockRate} - 200 \times \text{failRate} - 100 \times \text{latencyPenalty}$), auto-eliminates underperforming engines, elects the winning optimal backend, and hot-swaps active batches with zero manual intervention.
- **🛡️ 3-Tier Universal Cookie Notice Cascade**: Mandatory Cookie Information / OneTrust banner handling (`Native API` → `UI Selector Click` → `CSS Force-Hide`) with multi-stage verification at $T+300\text{ms}$, $T+1.5\text{s}$, and $T+3.5\text{s}$ on fresh launches before credential entry.
- **⚡ Dual Headless / Headed Execution**: Native headless stealth mode via Camoufox C++ biometric binary, Cloak browser, and Zendriver CDP with strict isolation, zero memory leaks, and high-concurrency capability.
- **🤖 Hermes AI Autonomous Ops**: Autonomous supervisor with telemetry watchers, vision model screenshot verification, DOM self-healing, automatic concurrency scaling, and long-term memory persistence (`learning/hermes-memory.json` & SQLite WAL).
- **🔒 Project Rule 1 Governing Invariant**: Precise classification truth gate:
  - `TEMP_DISABLED` → `TEMP_DISABLED_ACCOUNT_EXISTS` (stop immediately and track in 1-hour retry queue).
  - `PERM_DISABLED` → `PERM_DISABLED_ACCOUNT_EXISTS` (stop immediately and track separately).
  - `NO_ACCOUNT_CONFIRMED` requires exactly 4 submit invocations with $\ge 3$ confirmed accepted responses.
  - Cashier verification with DOM quiescence before declaring `SUCCESSFUL_LOGIN`.

---

## 🚀 Quick Start

### 1. Install Dependencies
```bash
npm ci
```

### 2. Configure Environment
Copy `.env.example` to `.env` and set your proxy configurations and credentials:
```bash
cp .env.example .env
```

### 3. Start Engine Server (Background Daemon)
```bash
npm start
```
*The dashboard runs on `http://localhost:3011` with real-time WebSocket telemetry and live stream feeds.*

### 4. Launch Autonomous Batch via CLI
Launch a batch in headless stealth mode with dynamic concurrency:
```bash
npx tsx src/scripts/cli-start-batch.ts --backend=stealth --concurrency=3
```

Launch Darwin Mode for automated backend selection & performance optimization:
```bash
npx tsx src/scripts/cli-start-batch.ts --backend=darwin --concurrency=3
```

Dynamically adjust concurrency during live runs:
```bash
npx tsx src/scripts/cli-set-concurrency.ts --concurrency=4
```

### 5. Run System Audits & Verification
```bash
npm run audit:all
npm run typecheck
npm run test
```

---

## 🦎 Darwin Mode — Automated Natural Selection

Darwin Mode tests multiple candidate backends against live targets under identical proxy conditions:

| Candidate Backend | Engine / Architecture | Stealth Layer |
|---|---|---|
| `stealth` | Camoufox Firefox C++ Binary (Headless) | Native C++ Biometrics |
| `stealth-headed` | Camoufox Firefox C++ Binary (Headed) | Native C++ Biometrics + Visual Tiler |
| `cloak-headless` | Chromium Playwright + Cloak (Headless) | Network TLS Cloak + Runtime Injection |
| `cloak-headed` | Chromium Playwright + Cloak (Headed) | Network TLS Cloak + Visual Tiler |
| `cloak-headless-nocloak` | Chromium Pure (Headless) | Runtime Fingerprint Injector |
| `cloak-headed-nocloak` | Chromium Pure (Headed) | Runtime Fingerprint Injector |
| `zendriver` | Zendriver CDP Undetected (Headless) | CDP Trace Stripping |
| `zendriver-headed` | Zendriver CDP Undetected (Headed) | CDP Trace Stripping + Headed Window |

*(Note: Spider backends are excluded from Darwin evaluation by architectural design).*

### Elimination & Winner Discovery
- **Auto-Elimination**: A backend that accumulates 3 WAF blocks or structural failures is automatically eliminated from the active candidate pool.
- **Optimal Winner Crowned**: When a candidate reaches statistical confidence ($\ge 2$ evaluations with high composite score), Darwin elects the winner, emits `darwin-winner-selected`, persists insights to SQLite and `learning/hermes-memory.json`, and **automatically pivots the active batch** to that optimal backend.

---

## 🛠 Project Structure

```
├── backends/       # Browser Backends (Stealth, Cloak, Zendriver, Spider)
├── data/           # SQLite Database & Storage (WAL mode)
├── docs/           # Architecture Blueprints & Guides
├── learning/       # Hermes Long-Term Memory & Historical Insights
├── reports/darwin/ # Darwin Diagnostic Reports & Post-Mortems
├── src/
│   ├── core/       # AutomationEngine, DarwinEngine, Database, Logger
│   ├── hermes/     # Hermes AI, Darwin Analyzer, Self-Healing, Strategy Engine
│   ├── guards/     # CookieGuard, SubmitButtonTracker
│   ├── proxy/      # Mullvad Adapter, Wireproxy Forwarder, Health Checker
│   ├── server/     # Express + WebSocket UI Server (Single Source of Truth)
│   ├── stealth/    # Random Login Actions, Fingerprint Blender
│   └── targets/    # universal-login.ts, login-flow.ts, site definitions
└── tests/          # System Audits and Test Suites
```
