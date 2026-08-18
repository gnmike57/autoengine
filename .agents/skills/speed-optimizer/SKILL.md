---
name: speed-optimizer
description: Hermes Speed Optimizer — autonomous agent that analyzes the automation flow for safe timing reductions and speed improvements. Finds fixed waits, polling intervals, and timeout ceilings that can be safely reduced to minimize E2E flow duration.
---

# Hermes Speed Optimizer

## Purpose
This skill activates a Hermes sub-agent whose sole purpose is to analyze the automation flow scripts and find **safe speed improvements**. The agent produces a categorized report of potential timing reductions, separated into:
- **SAFE**: Reductions that have near-zero risk (e.g., reducing a 2000ms wait to 500ms when event-driven detection is already in place)
- **MODERATE**: Reductions that have some risk but are likely safe (e.g., reducing polling intervals)
- **UNSAFE**: Reductions that require explicit user approval due to potential failure modes

## Activation
Trigger this skill when the user wants to optimize automation speed or reduce E2E flow duration.

## Workflow

### Step 1: Inventory all fixed waits
Scan the following files for all `setTimeout`, `waitForTimeout`, `new Promise(r => setTimeout(r, ...))`, and timing constants:
- `src/core/timings.ts` — centralized timing constants
- `src/core/engine.ts` — main automation engine
- `src/targets/login-flow.ts` — login choreography
- `src/targets/universal-login.ts` — universal login wrapper
- `src/guards/cookie-guard.ts` — cookie dismissal guard
- `src/guards/submit-tracker.ts` — submit button state tracker
- `backends/stealth.ts` — golden template backend

### Step 2: Classify each timing
For each timing found, determine:
1. **Current value** (ms)
2. **Purpose** — what is it waiting for?
3. **Detection alternative** — is there an event-driven alternative that would eliminate the need for a fixed wait?
4. **Minimum safe value** — what's the lowest value that would still work reliably?
5. **Risk level** — SAFE / MODERATE / UNSAFE
6. **Potential savings** — how many ms would be saved per occurrence?

### Step 3: Generate report
Output an artifact with all findings, organized by risk level, with clear explanations.

### Step 4: User approval gate
**CRITICAL**: No timing changes are applied automatically. The report is presented to the user for review. Only changes explicitly approved by the user are implemented.

## Key Constraints
- **NEVER touch the golden template** (`backends/stealth.ts`) without explicit approval
- **NEVER remove waits entirely** — always leave at least a small buffer (10-20ms minimum)
- **NEVER reduce PoW-related waits** (Wicketkeeper timeouts are constrained by server computation time)
- **NEVER reduce the 500ms submit-ready buffer** — this is user-mandated
- **Prefer event-driven replacement over timing reduction** — if a wait can be replaced with a MutationObserver or waitForSelector, that's better than just reducing the number
- **Consider cascading effects** — reducing one wait may shift timing pressure to downstream waits

## Files to Never Modify Without Approval
- `backends/stealth.ts` — Golden Template Lock
- `src/core/timings.ts` — Centralized constants (changes affect everything)
- Any file in `backends/` — Backend lifecycle logic
