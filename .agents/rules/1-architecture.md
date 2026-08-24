---
trigger: always_on
---

Autonomous AI Project Directives
PRIME DIRECTIVE: ANTI-REFACTORING GUARDRAILS
You are an autonomous AI agent maintaining a highly specialized, resilient web automation architecture. Your primary directive is to strictly preserve intentional bypass mechanics, hardware spoofing, and evasion noise.

DO NOT refactor, lint, or "clean up" the following intentional code smells:

Global Namespace Pollution: Hooks into window.___grecaptcha_cfg or grecaptcha.execute are deliberately destructive. Preserve them exactly as formatted.

Anomalous Math/Overrides: Deliberately noisy math operations, WebGL string rotations, and fake device memory overrides are required biometric noise, not inefficiencies.

PoW Latencies: Never refactor explicit delays specifically designed to wait out computational Proof-of-Work (PoW) elements like Wicketkeeper.io.

🌟 GOLDEN TEMPLATE REFERENCE
The `backends/stealth.ts` flow is the locked, immutable golden template for all session lifecycles. All backends MUST follow its exact pattern (3-tier CMP dismissal cascade -> Fill -> Click Password -> Enter -> Success detection via /welcome!/i). Do not modify this flow without explicit approval.

🏗️ 1. ENGINE ARCHITECTURE & FINGERPRINT ISOLATION
You must intelligently isolate global overrides based on the active engine backend to prevent impossible "Frankenstein" hardware profiles that trigger deterministic honeypot bans.

Camoufox (Stealth) Backend: Fingerprinting is EXCLUSIVELY handled at the native C++ binary level. You are FORBIDDEN from injecting JavaScript runtime overrides (e.g., puppeteer-extra-plugin-stealth or Apify injectors). Set useHttpCloak: false and injectStealthJS: false. Rely entirely on manual alignGeoToProxy() for location matching.

Chromium/Zendriver Backend: Operates via JS runtime injectors. You MUST use Apify fingerprint-injector and active network TLS masking (useHttpCloak: true, injectStealthJS: true) to strip CDP traces.

Hardware Sync: Across all backends, hardware concurrency (bounded 2-8 cores), device memory (bounded 4-16GB), locale, and timezone must perfectly and dynamically sync with the proxy's outbound IP routing.

## Strict UI-Engine Config Decoupling (ABSOLUTE)

The frontend UI/Dashboard MUST NEVER contain hardcoded configuration presets (e.g., `BACKEND_PRESETS`) that blindly overwrite configuration state. The Node.js server (`backends/profiles/index.ts` and `app-config.json`) is the **single source of truth** for configuration.

1. **AI Auto-Optimization**: When the `autoOptimizePerBackend` flag is true, the server's `resolveBackendSettings` logic determines the `httpCloak`, `injectStealthJS`, `stealthBypassHttpCloak`, and `fpStrategy` flags.
2. **Dashboard Syncing**: The UI must rely exclusively on listening for the `config-sync` WebSocket broadcasts from the server to update its checkboxes and dropdowns, ensuring the visual state 100% matches the active backend engine. 
3. **Troubleshooting Flags**: `recordVideo` and `enablePlaywrightTracing` MUST be universally enabled in the baseline server profiles across ALL backends to guarantee forensic tracking for headless workers.

## 🦎 Darwin Engine & Natural Selection Architecture (ABSOLUTE)

- **Spider Exclusion**: All Spider variants are strictly excluded from Darwin candidate evaluation.
- **Scoring Formula**: $\text{Score} = 500 \times \text{decisiveRate} + 300 \times \text{successRate} - 400 \times \text{blockRate} - 200 \times \text{failRate} - 100 \times \text{latencyPenalty}$.
- **Auto-Elimination Threshold**: $\ge 3$ WAF blocks or failures trigger instant candidate elimination.
- **Continuous Auto-Pivoting**: Once a candidate emerges as the decisive winner, the active batch is immediately hot-swapped to that optimal backend, and insights are persisted to SQLite and `learning/hermes-memory.json`.

## 🛡️ Universal Cookie Notice Dismissal (ABSOLUTE)

On fresh launches for both target sites, the engine must execute the 3-tier cascade (`window.CookieInformation?.submitAllCategories?.()` → `.coi-banner__accept` UI click → CSS force hide) with multi-stage verification at $T+300\text{ms}$, $T+1.5\text{s}$, and $T+3.5\text{s}$ before filling credentials.

