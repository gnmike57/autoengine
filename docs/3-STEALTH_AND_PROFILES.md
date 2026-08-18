# Stealth & Profiles

This document explains the synthetic identity generation and anti-fingerprinting measures used by the engine.

## 1. The 9-Profile Vector System

Every single session execution is assigned a unique, deterministic fingerprint profile based on the proxy IP address. This ensures that if the same proxy is reused, the target sees the exact same device. The 9 vectors are:

1. **UserAgent / Platform**: Consistent Chrome version, OS, and Architecture.
2. **Hardware Concurrency**: Bound strictly between 2 to 8 cores (natively spoofed and verified to prevent bundle↔runtime drift).
3. **Device Memory**: Bound strictly between 4GB and 16GB (natively spoofed and verified to prevent bundle↔runtime drift).
4. **Geo & Timezone**: Perfectly synchronized with the proxy's outbound IP routing.
5. **Fonts**: Synthesized local font lists.
6. **Display**: Viewport sizing, color depth, and pixel ratio.
7. **Interaction**: Touch support, mouse movement speeds.
8. **Network**: TLS signatures (see `httpcloak` below).
9. **Storage**: LocalStorage, IndexedDB persistence mechanisms.

## 2. Backend-Specific Isolation Rules

A strict directive governs the stealth implementation based on the underlying browser backend.

### Camoufox (Strict Native)
- Camoufox provides its fingerprinting exclusively at the native C++ binary level.
- **Rule**: We are **FORBIDDEN** from injecting JavaScript runtime overrides (e.g., `puppeteer-extra-plugin-stealth` or `Apify` injectors) into a Camoufox context.
- Native `alignGeoToProxy()` is the only configuration applied.

### Zendriver & Cloak (JS Injected)
- These backends operate via standard Chromium binaries.
- **Rule**: They MUST use the Apify `fingerprint-injector` to execute runtime overrides within the JS context.

## 3. `httpcloak` & TLS Masking

For non-Camoufox backends, standard Node.js or Chromium TLS fingerprints (JA3 signatures) are dead giveaways. The engine uses an internal proxy layer called `httpcloak`.
- **Function**: Active network TLS masking. It strips CDP (Chrome DevTools Protocol) traces and rewrites outgoing TLS client hellos to perfectly mimic standard Google Chrome signatures.

## 4. PoW Latencies (Wicketkeeper.io)

Modern WAFs use computational Proof-of-Work (PoW) to stall bots.
- The engine uses a multi-tier Wicketkeeper check.
- **Tier 1**: Explicit wait loops polling for the `.wicketkeeper` hidden class string in the DOM. Execution is yielded until the programmatic token value populates natively.
- **Tier 2/3**: Fallback native hashing scripts (Rust/Go targets) are invoked if the browser cannot solve the puzzle in time.

## 5. Recaptcha Interception

Network blackholing is strictly enforced against `recaptcha/api` and `gstatic.com/recaptcha`.
- Instead of solving visual captchas, the engine hooks into `window.___grecaptcha_cfg` and `grecaptcha.execute`.
- These hooks intercept the token request, cache the required `sitekey` and `action`, and queue the token generation to an external Redis farming logic system (`redis-coordinator.ts`), running entirely asynchronously from the main operational thread.

## 6. Live Session Rotation & Blending

Fingerprint rotation is strictly driven by live production sessions:
- **Rotation Authority**: `createSession()` is the canonical authority for advancing fingerprint rotation (via `FingerprintRotationEngine`). Audit, test, or diagnostic callers use non-advancing modes (e.g. `advanceRotation: false`).
- **Blender Success-Hook**: When a session is definitively classified as a success (after cashier verification), `FingerprintBlender.recordSuccess()` is hooked directly in the engine pipeline. This captures the exact `HardwareProfile`, `UAProfile`, and `GeoProfile` for blending.

## 7. Auditing & Guardian Skills

To ensure continuous fingerprint coherence:
- **Auditor Tool (`scripts/fp-audit.ts`)**: A consolidated diagnostic tool that inspects rotation state, analyzes proxy coherence, and forces single-seed headless verifications without modifying ledger state.
- **Automati Fingerprint Guardian (`skills/automati-fingerprint-guardian`)**: An OpenClaw AI skill designed to continuously detect hardware drift between the generated fingerprint bundle and runtime Playwright injection. If drift is found, the Guardian isolates the issue, repairs `hardware-rotation.ts`, and automatically issues a Pull Request.
