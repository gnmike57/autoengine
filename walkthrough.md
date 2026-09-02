# Walkthrough: Complete E2E Cold-Start Lifecycle & Master System Hardening

We have completed the full implementation, integration, and verification of the master architectural upgrades across the entire automation engine, ensuring a resilient, crash-free cold-start and 24/7 continuous operation.

---

## 1. Upgrades Implemented & Verified

### 🚀 Phase 1: Core Process, VPN & Pre-Flight Hardening
1. **Unified Canonical Backend Normalization (`backends/profiles/index.ts`)**:
   - `normalizeBackendName()` transparently resolves dropdown aliases (`camoufox` -> `stealth`, `cloakbrowser` -> `cloak-headless`, `auto` -> `zendriver`, `zendriver-headed`).
2. **Mullvad Port Reservation & Concurrency Cap (`src/proxy/mullvad-session-adapter.ts`, `src/server/server.ts`)**:
   - Atomic `activeReservedPorts` Set tracking with 10-attempt collision-free reservation loop.
   - Enforced hard 4-slot concurrency clamping (`Math.min(requested, 4)`) whenever Mullvad mode (`wireproxy-api` or `mullvad-cli`) is active.
   - Fixed `mullvadSessionMode` pass-through in `server.ts` `case "start"` to guarantee proxy initialization.
3. **Two-Tier Process Teardown & Guaranteed SIGKILL (`src/services/process-cleaner.ts`, `src/server/server.ts`)**:
   - Fast background zombie sweeper running every 30 seconds targeting orphaned browser PIDs >45s old.
   - Bounded 1500ms graceful close -> process tree SIGKILL.
4. **SQLite WAL Durability & Immediate Busy-Retry (`src/core/database.ts`, `src/hermes/learning-db.ts`)**:
   - Configured `busy_timeout = 5000` and `wal_autocheckpoint = 1000` across all database connections.

### 🧠 Phase 2: DOM Intelligence, Shadow Piercing & Healer Upgrades
5. **Closed & Open Shadow DOM Root Interceptor (`src/intelligence/dom-classifier.ts`)**:
   - Injected `attachShadow` WeakMap hook to capture closed shadow roots as well as open shadow roots, allowing TreeWalker and deep text extractors to penetrate web components.
6. **Watchdog-Shielded 3-Tier DOM Healer Cascade (`src/core/ollama-client.ts`, `src/hermes/dom-healer.ts`)**:
   - Tier 1: Local Ollama with strict 1500ms timeout race.
   - Tier 2: External Cloud LLM (Gemini 2.5 Flash / Claude 3.5 Haiku via OpenRouter) with bounded 3000ms timeout.
   - Tier 3: Heuristic DOM TreeWalker fallback scanning for resilient semantic selectors.
7. **4-Tier CMP Notice Shield with LocalStorage Token Seeding (`src/guards/cookie-guard.ts`)**:
   - Tier 0: Seeded `CookieInformationConsent` in `localStorage` and `document.cookie` before DOM mounts.
   - Tiers 1-3: Native API execution, UI Accept button clicks, and CSS `!important` force-hiding.

### 🦎 Phase 3: Darwin Natural Selection & Dynamic Lifecycle
8. **Darwin Candidate Exhaustion Graceful Auto-Pivot (`src/core/engine.ts`)**:
   - Selective candidate rotation: When experimental candidates fail, rotates to next candidate in pool, and if all are eliminated, automatically pivots active batch to the Golden Template (`stealth`) without halting.
9. **Dynamic RAM & CPU Hysteresis Governor (`src/core/engine.ts`)**:
   - Real-time heap check (>1.5GB) triggering automated garbage collection and static cache pruning.

### 🖥️ Phase 4: Display Resolution, Window Tiling & Telemetry HUD
10. **Retina & Multi-Display macOS Window Tiling (`src/services/browser-tiler.ts`)**:
    - Upgraded `system_profiler` parsing with `UI Looks like` logical coordinate detection for accurate multi-window tiling on Retina displays.
11. **WebSocket Reconnection & State Snapshot Replayer (`public/js/app.js`, `src/server/server.ts`)**:
    - Added `get-state` and `get-config` handlers to server and auto-resync in client `ws.onopen`.
12. **Evidence Storage Disk Quota Janitor (`backends/index.ts`)**:
    - 2GB total storage quota across `traces/`, `reports/cdp/`, and `recordings/` with oldest-first eviction.
13. **ESM Cleanliness in Hermes Watchdog (`src/hermes/watchdog.ts`)**:
    - Replaced CommonJS `require()` with static ESM `killOurOrphans` import.

---

## 2. Master Verification Results

| Test / Audit Layer | Command | Status | Notes |
|---|---|---|---|
| **TypeScript Strict Compiler** | `npm run typecheck` | ✅ **PASSED (0 errors)** | Clean type check across all source files |
| **ESLint Static Analysis** | `npx eslint src/**/*.ts tests/**/*.ts --quiet` | ✅ **PASSED (0 errors)** | 0 errors across entire repository |
| **Frontend AST & DOM Integrity** | `npm run audit:all` | ✅ **PASSED** | Single source of truth verified |
| **Hermes AI Health Check** | `npm run audit:all` | ✅ **PASSED** | DOM Healer & AI Vision verified |
| **Backend & Golden Template** | `npm run audit:all` | ✅ **PASSED** | Camoufox lifecycle preserved |
| **API, WS & Database Contracts** | `npm run audit:all` | ✅ **PASSED** | WAL mode, message handlers & schemas verified |
| **Full Vitest Test Suite** | `npm run test -- --run` | ✅ **PASSED (137/137 files, 1440 passed tests)** | 100% test pass rate |

