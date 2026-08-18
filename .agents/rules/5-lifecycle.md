---
trigger: always_on
---

♻️ 5. SESSION LIFECYCLE & CONTEXT MANAGEMENT
Fast-Loop Persistence (Standard Failures): For standard iteration failures (e.g., "incorrect password" on attempt 2 of 4), DO NOT destroy the context, wipe local storage, or clear cookies. Retain all state (including cookies) to preserve trust metrics. Clear the #password field, inject the next password using Autofill replication, and dispatch Enter.

Toxic Context Destruction (Anomalies): If misdirection, fingerprinting false results, or terminal blocks occur (e.g., HTTP 403, Honeypot detected, success, 2FA, blocked), the context is permanently poisoned. You MUST instantly:

Destroy the Playwright context.

Rotate the proxy worker.

Throttle the specific affected proxy worker down to 1 active slot (Concurrency Hysteresis).

Zombie Sweeping: Every spawned headless context must map --user-data-dir to tracked temporary folders. Upon toxic context destruction, execute UNIX ps -axo or Windows WMI sweeps to kill orphaned processes and prevent stealth fingerprint degradation via memory leaks.
