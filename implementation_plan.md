# Infrastructure Resilience & Lifecycle Cleanup

This plan addresses the critical weaknesses in the proxy/browser lifecycles and network flakiness.

## Proposed Changes

### Network Resilience Layer
#### [NEW] `src/core/network-resilience.ts`
Implement `withResilience()`, a utility function that wraps external asynchronous calls. It will include:
- **Exponential Backoff**: Configurable base delay and jitter.
- **Circuit Breaker**: Tracks consecutive failures. Based on our `/grill-me` answers, 5 consecutive failures trips the circuit for 60 seconds. If tripped, it fast-fails requests to prevent cascading stalls.

#### [MODIFY] `src/proxy/mullvad-api.ts`
Wrap the `fetch("https://api.mullvad.net/...")` calls in the new `withResilience()` wrapper to prevent network hiccups from crashing proxy generation.

#### [MODIFY] `src/hermes/hermes-llm.ts`
Wrap the `fetch` to OpenRouter inside `withResilience()` to protect against AI API outages stalling the telemetry pipeline.

---

### Atomic Teardown Guarantees
#### [MODIFY] `src/proxy/mullvad-session-adapter.ts`
- Implement strict `try/finally` blocks around the `acquireWireproxyApi` lock acquisition (`keysLockFile`) and directory creation (`runtimeDir`).
- Create an internal registry (`activeWireguardSessions: Set<string>`) that hooks into `process.on('exit')` to guarantee `fs.rmSync(runtimeDir)` and `child.kill("SIGKILL")` execute even during catastrophic exits.

---

### Active Zombie Sweeping (Self-Healing Loop)
#### [MODIFY] `src/hermes/self-healing.ts`
- Add a `startHealingLoop()` method that sets a `setInterval` for every 5 minutes.
- The loop will invoke `killOurOrphans({ timeoutMs: 5000, minEtimeSec: 300 })` from `clean-zombies.ts`/`process-cleaner.ts` to actively reap orphaned browsers without halting the queue.

#### [MODIFY] `src/server/server.ts`
- Start the `hermesHealer.startHealingLoop()` when the engine boots.

## Verification Plan
1. Typecheck the project (`npm run typecheck`).
2. Verify that network wrappers catch simulated failures without crashing.
3. Validate that the 5-minute loop starts and executes successfully without throwing async errors.
