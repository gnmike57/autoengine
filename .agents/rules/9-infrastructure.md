# 9. INFRASTRUCTURE & LIFECYCLE RESILIENCE

## Network Resilience Invariants
- **No Bare Network Calls**: All calls to external integrations (e.g., Mullvad API, OpenRouter LLM, any external REST endpoint) MUST be wrapped with a resilience utility (`withResilience` from `src/core/network-resilience.ts`).
- **Circuit Breakers**: External integrations MUST implement a circuit breaker to prevent cascading engine stalls. 
  - Standard threshold: 5 consecutive failures trips the circuit.
  - Standard cooldown: 60 seconds before half-open testing.
- **Exponential Backoff**: Transient network errors (non-401/403) MUST trigger exponential backoff with jitter up to a configured max retries limit.

## Atomic Lifecycle Teardown
- **Process Boundaries**: Child processes (e.g., Wireproxy, Headless Chromium) MUST be registered into a global `process.on('exit')` Set registry immediately upon spawn to guarantee they receive a `SIGKILL` even during a catastrophic main process crash.
- **Strict Try/Finally Guarantees**: Any operation that acquires a file lock (e.g., API config generation lock) or creates a temporary runtime directory MUST wrap the lifecycle in a strict `try/finally` block that unlinks the file/directory.

## Active Zombie Sweeping
- **Continuous Monitoring**: The system MUST continuously poll for orphaned zombie processes (PIDs missing a parent) in an active background loop without halting the main credential queue.
- **Self-Healing Loop**: The `hermesHealer.startHealingLoop()` MUST be initialized early in the server boot sequence to guarantee that `clean-zombies.ts` reaps any leaked browser contexts every 5 minutes.
