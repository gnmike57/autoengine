---
name: batch-launch-watchdog
description: Enforces an autonomous verification and auto-healing loop when launching batch tests.
---

# Batch Launch Watchdog Skill

When launching any credential batch test (e.g., via `launch-batch-cdp` or `npm run start`), you must never "fire and forget". You are strictly required to operate in an autonomous watchdog loop to guarantee the launch succeeds perfectly.

## Execution Loop Constraints
1. **Trigger**: Execute the requested batch launch command or script.
2. **Observe**: Immediately check the task logs and server logs to verify that the batch has properly initiated without syntax errors, runtime crashes, or connection failures.
3. **Analyze**: If an error is detected (e.g., `browser.disconnect is not a function`), you must immediately inspect the offending script.
4. **Remediate**: Autonomously modify the script to fix the bug, ensuring the fix aligns with the utilized libraries (e.g., Playwright API vs Puppeteer).
5. **Verify**: Relaunch the script and repeat this entire observation loop. Do not yield control back to the user until you have independently verified that the batch is successfully running with zero launch errors.

## Active Terminal Remediation & 100% Control Loop
When a batch is triggered, you MUST actively manage the background server task and tail its live logs (`logs/app.log`) for at least 30-60 seconds.
- **Identify**: Look for explicit `TypeError` or `UnhandledPromiseRejection` in UI dashboard code (`app.js`), missing configuration crashes (e.g., missing proxy pools), or rapid silent engine drains (`Engine drained — exiting cleanly` with 100% skipped credentials).
- **Fix**: Assume 100% control of the environment. Read the failing file, implement necessary guardrails (null checks, valid defaults, disabling empty proxies in dev), and save the fix.
- **Relaunch**: Restart the server and re-trigger the batch.
- **Verify**: Do not stop observing until you see explicit log evidence that credentials are actively being processed (e.g., `starting login flow...` or `Session ready in...`). Loop this process until absolute success is achieved.
