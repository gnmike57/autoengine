# Automation Scripts

A fully autonomous, 24/7 self-learning multi-backend web automation engine designed for credential validation and behavioral testing.

This engine utilizes five distinct browser backends, a 9-vector fingerprinting system, and a robust outcome classification gate to simulate deep, deterministic human interactions against sophisticated targets.

---

## 🚀 Quick Start

1. **Install Dependencies**
   ```bash
   npm ci
   ```
2. **Setup Environment**
   Copy `.env.example` to `.env` and fill in required variables (Proxy keys, AI tokens if using visual fallback).
3. **Start the Engine (Daemon Mode - Recommended)**
   ```bash
   npm run daemon:install
   ```
   *This installs PM2, registers it to start on boot, and launches the 24/7 background process.*
4. **Monitor the Daemon**
   ```bash
   npm run daemon:status
   npm run daemon:logs
   ```
5. **Run the Dashboard (Manual Mode)**
   ```bash
   npm run gui
   ```
   *Note: `npm run start` maps to the same command. The dashboard runs on `http://localhost:3011`.*
6. **Run the Test Suite**
   ```bash
   npm run test
   ```

### 🔄 Maintenance
To ensure peak evasion performance, routinely update the core browser engines:
```bash
npm update
npm install cloakbrowser@latest camoufox-js@latest
```

---

## 📚 Documentation

The documentation has been completely rewritten to serve as the definitive architectural blueprint. If you are extending the engine or auditing its behavior, read these in order:

1. **[Architecture Overview](docs/1-ARCHITECTURE.md)**
   Understand the `AutomationEngine` bootstrap lifecycle, the SQLite WAL database, and the Zombie process manager.
2. **[Automation Flow](docs/2-AUTOMATION_FLOW.md)**
   Step-by-step choreography: CMP dismissal, Autofill injection, and submit protocols.
3. **[Stealth & Profiles](docs/3-STEALTH_AND_PROFILES.md)**
   The 9-Profile system, `httpcloak` TLS masking, and backend isolation.
4. **[Classification Gate](docs/4-CLASSIFICATION_GATE.md)**
   The single source of truth for outcome routing, soft vs hard toxic handling, and cashier verification.
5. **[Windows 11 Launch Guide](docs/WINDOWS_LAUNCH_GUIDE.md)**
   System configuration, native C# resizers, Wicketkeeper solver building, and PowerShell startup.

---

## 🛠 Project Structure

```
├── backends/       # The 5 Browser Backends (Cloak, Stealth, Zendriver, Spider Local/Cloud)
├── data/           # SQLite Database & CSV Imports (gitignored)
├── docs/           # Architecture Blueprints
├── scripts/        # Standalone maintenance/audit scripts
├── src/
│   ├── core/       # Engine, Database, Framework Config, Logger
│   ├── hermes/     # DOM Healer, Visual Verifier
│   ├── intelligence/# AI Decoys, Humanized Mouse Movement
│   ├── profiles/   # Profile generators (Geo, Font, UA, Display)
│   ├── proxy/      # Proxy rotators and score trackers
│   ├── server/     # Express + WebSocket UI Backend
│   ├── services/   # Process cleaner, screenshotters, codegen
│   ├── stealth/    # Wicketkeeper handling, recaptcha interceptors
│   └── targets/    # login-flow.ts (The canonical trigger logic)
└── tests/          # Vitest suite (980+ tests)
```
