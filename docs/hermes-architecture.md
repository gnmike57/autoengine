# Hermes Architectural Blueprint: The Autonomous Overseer

The Hermes Engine (`hermes-review.ts`) serves as the central intelligence and autonomous orchestrator for the automation infrastructure. It has evolved from a simple anomaly detection service into a full-stack, God-mode administrator. 

This document outlines Hermes's expanded capabilities, the iOS Command API, the OpsOrchestrator Sandbox, and how the core "Intelligence Ceiling" scales infinitely.

---

## 1. The Core Goal Injection Loop

Hermes's decision-making is driven by a `coreGoal` parameter. This parameter is the highest-priority directive fed into the Gemini 2.5 Flash self-improvement prompt every 10 minutes.

- **Current Default Goal**: 
  > "Ensure that all queued credentials are tested until and results marked accurately, and all the while the apps efficiency and backends are rotated when fingerprinted, and code is fixed when broken, and zombie windows are killed, and hermes intelligence and skills are increasing and adding always, and his understanding and reasoning of the app until the point there is no credentials left to test. Hermes is to follow instructions from the app websocket and also report issues when needing clarification. Hermes is to be seeking to always add and refine skills, and rollback changes if regression is detected, and refine and tinker until it has 100% coverage of the orchestration."

- **Infinite Scalability**: Because the goal is injected directly into the LLM context (`YOUR CORE GOAL (Highest Priority): {coreGoal}`), Hermes's logic is never hardcoded. If you change the goal via the iOS app, Hermes instantly pivots its entire architectural strategy.

---

## 2. iOS WebSocket Command Bridge

Hermes natively listens for commands dispatched through the `server.ts` WebSocket layer (authenticated via `MOBILE_API_KEY`). This allows iOS apps or remote dashboards to puppet Hermes in real time.

### Available Commands:
Commands are sent as JSON payloads to `ws://server:3011`.

#### `set_goal`
Dynamically overrides Hermes's Core Goal on the fly.
```json
{
  "type": "hermes-command",
  "action": "set_goal",
  "goal": "Focus entirely on purging stuck proxy pools and reducing latency."
}
```

#### `force_cycle`
Bypasses the standard 10-minute AI loop timer. Forces Hermes to immediately read server telemetry, gather DOM failure patterns, and execute a Gemini reasoning cycle.
```json
{
  "type": "hermes-command",
  "action": "force_cycle"
}
```

#### `inject_ops_skill`
God-mode override. The iOS app can push a raw Node.js script string directly into the `OpsOrchestrator` sandbox for immediate execution on the server.
```json
{
  "type": "hermes-command",
  "action": "inject_ops_skill",
  "script": "console.log('Manually clearing redis cache...'); process.exit(0);"
}
```

---

## 3. The OpsOrchestrator Sandbox

Hermes is no longer restricted to generating client-side JavaScript patches for Playwright `page.evaluate()`. It can now write and execute server-side Node.js maintenance scripts ("OpsSkills").

### How it Works:
1. **Telemetry Ingestion**: Every 10 minutes, Hermes reads `process.memoryUsage()` and process uptimes.
2. **Generation**: If Hermes detects server degradation (e.g., RSS memory exceeding 2000MB, indicating a leak), the AI will output a JSON payload containing an `ops-skill` script.
3. **Execution**: The `OpsOrchestrator` (`ops-orchestrator.ts`) takes the script, wraps it in a safety try/catch block, and executes it via a spawned child `node` process (to ensure the main server thread never crashes).
4. **The Infinite Learning Loop**: The `OpsOrchestrator` captures the `stdout`, `stderr`, and crash status of the executed script. These outcomes are pushed to `opsSkillOutcomes` in Hermes's memory. On the *next* 10-minute cycle, Hermes reads its own crash logs and writes patched versions of its failing scripts, continuously improving until the script succeeds.

---

## 4. Multi-Mode Integrity & Security

While Hermes has infinite generation potential, the core automation pipeline is heavily guarded to prevent AI hallucinations from destroying the fingerprinting architecture.

- **`resolveBackendSettings()`**: All backend execution profiles (Stealth, Zendriver, Camoufox) strictly route through `resolveBackendSettings()` in `backends/profiles/index.ts`. 
- **Enforcement**: If Hermes generates a flawed configuration (e.g., attempting to inject JavaScript fingerprinting into the Camoufox backend, which relies purely on C++ binary fingerprinting), `resolveBackendSettings()` will silently intercept and correct the configuration to match the mode's architectural constraints before the browser ever launches.
- **Fail-Safe**: This guarantees that no matter how aggressive Hermes's strategy becomes, it can never accidentally uncloak the browser and burn the proxy pool.

---

## 5. Hermes-Observer: LLM-Powered Live Intelligence

The **Hermes-Observer** (`src/hermes/hermes-observer.ts`) is an ultra-intelligent agent that runs **during** live automation batches. Unlike the 10-minute review loop, the Observer operates in real-time, analyzing every attempt as it happens.

### Architecture
```
HermesObserver (singleton)
├── TimingRecorder (per session) → data/timing-telemetry.jsonl
├── ResponseScreenshotter → screenshots/responses/{email}/{site}/
├── HermesLLM (OpenRouter + Ollama) → Vision + Text analysis
└── IntelligenceLog → data/hermes-intelligence/live-observations.jsonl
```

### LLM Intelligence Methods

| Method | Trigger | What It Does |
|--------|---------|--------------|
| `analyzeScreenshotLive()` | After each login response | Vision LLM reads the page screenshot and validates the code's verdict |
| `diagnoseAnomaly()` | When timing anomalies detected | Explains what went wrong and suggests specific corrections |
| `analyzeAttemptComplete()` | After each attempt finishes | Full post-attempt analysis combining screenshot + telemetry + history |
| `suggestCorrection()` | When unexpected state detected | Provides immediate correction suggestions (e.g., cookie banner still visible) |

### Key Design Decisions
- **Non-blocking**: All LLM calls run asynchronously — they NEVER slow down the automation flow
- **Graceful degradation**: If OpenRouter is unavailable, falls back to local Ollama; if Ollama is unavailable, operates in telemetry-only mode
- **Persistent learning**: All intelligence is appended to JSONL files for post-batch analysis

---

## 6. HermesLLM: Unified AI Client

The **HermesLLM** (`src/hermes/hermes-llm.ts`) provides a unified interface for all Hermes agents to call LLMs.

### Provider Cascade
1. **Primary**: OpenRouter API (`google/gemini-2.0-flash-001`) — fast, cheap, vision-capable
2. **Fallback**: Local Ollama (`llama3`) — works offline, no API costs

### Capabilities
- **Text Analysis** (`analyzeText()`): System prompt + user content → structured response
- **Vision Analysis** (`analyzeScreenshot()`): Screenshot buffer → visual understanding
- **File Vision** (`analyzeScreenshotFile()`): File path → vision analysis (convenience wrapper)

### Configuration
```
OPENROUTER_API_KEY=sk-or-v1-... (from .env)
Text Model: google/gemini-2.0-flash-001
Vision Model: google/gemini-2.0-flash-001
Max Tokens: 1024
Temperature: 0.3
```

---

## 7. Timing Telemetry Pipeline

The **TimingRecorder** (`src/hermes/timing-telemetry.ts`) passively instruments the login flow to measure actual phase durations.

### Recorded Phases
| Phase | What It Measures |
|-------|-----------------|
| `cookieDismissMs` | Time from CMP dismissal start to completion |
| `credentialFillMs` | Time to fill email + password fields |
| `submitMs` | Time from submit initiation to response signal |
| `responseWaitMs` | Time waiting for DOM/network response |
| `responseClassifyMs` | Time to classify the verdict |
| `cashierVerifyMs` | Time for cashier page navigation + DOM settle |
| `totalE2EMs` | Total end-to-end time for the session |

### Data Flow
```
login-flow.ts → TimingRecorder.markPhaseStart/End() → JSONL append
                                                        ↓
OpsOrchestrator.postBatchAnalysis() ← readRecentRecords()
                                        ↓
                                    computePhaseStats() → P50/P95/max
                                        ↓
                                    addProposal() → hermes-proposals.json
```

### Storage
- **File**: `data/timing-telemetry.jsonl` (append-only, one JSON object per line)
- **Analysis**: `readRecentRecords(hoursBack)` + `computePhaseStats(records, phase)`

---

## 8. Response Screenshot System

The **ResponseScreenshotter** (`src/services/response-screenshotter.ts`) captures targeted screenshots after each login attempt.

### Screenshot Types
1. **Zoom Screenshot**: `element.screenshot()` on the detected response element (error banner, success message)
2. **Full Page Screenshot**: Full viewport with the response element highlighted via red CSS outline

### Element Detection Priority
1. CSS selectors: `[role="alert"]`, `.error-message`, `[class*="error"]`, etc.
2. TreeWalker text search: Scans for `welcome!`, `incorrect`, `disabled`, etc.
3. Fallback: Login form area (`form`, `[class*="login"]`, `main`)

### Storage Convention
```
screenshots/responses/{email}/{site}/{password}_attempt-{N}-{verdict}-{zoom|full}-{timestamp}.webp
```

---

## 9. Enhanced Headed Overlay (HUD)

The headed browser overlay (`src/intelligence/agent-observer.ts`) displays real-time session intelligence:

```
┌─────────────────────────────────────────┐
│ 🇦🇺 AU ✅ 203.45.67.89   | ⏱ 02:34    │
│ 📧 user@example.com                    │
│ 🔑 currentPassword123                  │
│ JOEFORTUNE | SUBMITTING     2/4        │
└─────────────────────────────────────────┘
```

### Features
- **Geo-IP verification** via `ip-api.com` — shows AU ✅ or country code ❌
- **Unmasked credentials** — email and current password visible
- **Session timer** — live elapsed time counter
- **State-aware coloring** — different colors per flow state (orange=cookie, blue=filling, pink=submitting, purple=waiting, green=success, red=failed)
- **Attempt counter** — current/total (e.g., 2/4)

---

## 10. Proposal System (Human-in-the-Loop)

The **Proposal System** (`src/hermes/hermes-proposals.ts`) enables data-driven timing/flow suggestions that require explicit user approval.

### Lifecycle
```
OpsOrchestrator.postBatchAnalysis()
    ↓ reads timing telemetry
    ↓ computes P50/P95 per timing constant
    ↓ compares against current DynamicTimings values
    ↓
addProposal({ constant, currentValue, proposedValue, evidence })
    ↓
data/hermes-proposals.json (status: "pending")
    ↓
User reviews → approved / rejected
    ↓
Applied to DynamicTimings (if approved)
```

### Confidence Scoring
Confidence = `sampleFactor × varianceFactor × successRate`
- `sampleFactor`: Scales linearly 0→1 over 0→50 samples
- `varianceFactor`: Lower P95-P50 spread = higher confidence
- `successRate`: Direct multiplier from batch success rate

