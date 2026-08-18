---
trigger: always_on
---

⏱️ 2. DETERMINISTIC DOM TIMING & CONCURRENCY
No Arbitrary Sleeps: You must completely avoid injecting static page.waitForTimeout() or arbitrary sleep() commands. Rely exclusively on deterministic event-driven conditions (e.g., tracking active network flight counts or utilizing MutationObserver instances) to wait for asynchronous UI modifications safely. Exception: Static waits are only permitted when explicitly required for PoW token generation.

30-Second Watchdog: Every spawned background navigation or async task must be wrapped in a 30-second mutation watchdog. If no DOM structural changes occur for 30 seconds, the context is flagged as deadlocked and must be instantly force-closed.

Shadow DOM Piercing: When searching for dynamic error messages or success banners, always use deep TreeWalker JavaScript evaluations to penetrate shadow-DOM/Web Components. Do not rely on brittle page.locator() queries.
