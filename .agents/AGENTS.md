# Project Rules & Agents

# PROJECT RULE 1 — GOVERNING ACCOUNT-CLASSIFICATION INVARIANT

> The reason an account is known to exist is the `TEMP_DISABLED` signal. A non-permanently-disabled existing account subjected to the accepted incorrect-password envelope reaches `TEMP_DISABLED`; absence of that terminal signal after the validated envelope proves no account exists.

This rule is the point of truth and overrides conflicting older rules, tests, comments, and harnesses:

- `TEMP_DISABLED` → `TEMP_DISABLED_ACCOUNT_EXISTS`; stop immediately and retain it in the temporary-disabled tracker.
- Explicit `PERM_DISABLED` → `PERM_DISABLED_ACCOUNT_EXISTS`; stop immediately and retain it separately.
- Successful authenticated login → `SUCCESSFUL_LOGIN`; stop immediately. Success is a bonus result, not the primary classifier objective.
- `NO_ACCOUNT_CONFIRMED` requires exactly four submit invocations, at least three confirmed accepted submits, every accepted response classified `incorrect`, and no temporary-disable, permanent-disable, success, challenge, or rate-limit terminal.
- Fewer than three confirmed accepted submits, missing synchronized evidence/video, or conflicting responses → `INCONCLUSIVE`; retain the email and never exclude it.
- `ACCOUNT_EXISTS_BAD_PASSWORD` is not a separate state. Incorrect-password responses matter through the eventual `TEMP_DISABLED` signal.
- A click or keypress is only an invocation. Acceptance requires at least two independent post-action signals from DOM mutation, network activity, form-state change, and observed response timing/content.
- Every registered submit variation must be certified; evidence runs use deterministic ordered routing rather than a single-submit or random-submit design.

# PROJECT RULE 2 — ALL-WINDOW PROXY INVARIANT

- Every baseline and real-batch browser session with a configured proxy pool must fail closed if no usable proxy can be selected or bound; silently falling back to `DIRECT` is forbidden.
- Proxy binding occurs at browser/context creation so the primary page, popups, and every additional window inherit the same proxy route.
- A usable local session must expose both `proxyUsed` and its sticky-session `proxyKey`; Spider-managed pools must expose the explicit `spider-managed` marker.
- Pool health is established without login submission by reaching Google and both authoritative login URLs: `https://www.joefortune.zone/login` and `https://www.ignitioncasino.ooo/login`.
- Proxy credentials must never appear in logs, screenshots, videos, manifests, or exported evidence; only a deterministic hashed proxy identifier may be retained.

## 0. Atomic Rules Inclusion
Instead of a single monolithic file, you MUST load the rules from the `.agents/rules/` directory based on the specific subsystem you are working on:
- `<RULE[.agents/rules/1-architecture.md]>`
- `<RULE[.agents/rules/2-dom-timing.md]>`
- `<RULE[.agents/rules/3-interaction.md]>`
- `<RULE[.agents/rules/4-telemetry.md]>`
- `<RULE[.agents/rules/5-lifecycle.md]>`
- `<RULE[.agents/rules/6-pipeline.md]>`
- `<RULE[.agents/rules/7-security.md]>`
- `<RULE[.agents/rules/8-hermes-ipc.md]>`
- `<RULE[.agents/rules/9-infrastructure.md]>`
- `<RULE[.agents/rules/10-autonomous-safety.md]>`

## QA Subagent (qa-bot)
When making deep architectural changes, you are explicitly encouraged to use the `define_subagent` tool to spawn a `qa-bot` in the background. Tell the qa-bot to continually run `npm run typecheck` and test the code against the proxy targets while you continue writing code.
## No Post-Success Observation Window (ABSOLUTE — NO EXCEPTIONS)

After a successful login is detected and the cashier page is navigated to, the automation must NEVER introduce any arbitrary delay (no 30s observation, no "keeping browser open" sleep, no static wait).

**The decision is instant and deterministic:** Navigate to the cashier URL. If the DOM settles on the cashier/deposit/account page → confirmed success. If the URL bounces back to /login or /signin → session invalid. Once the DOM settles on either outcome, the process exits immediately. No further delay.

This rule applies to ALL backends, ALL test harnesses, and ALL scripts in the project.

## Golden Template Lock (ABSOLUTE — NO EXCEPTIONS)

The file `.agents/references/golden-stealth-template.md` is the **frozen, immutable reference implementation** for all backend automation flows. It was locked after achieving 4/4 backend success on attempt 1 in the golden tile test.

**NEVER modify `backends/stealth.ts` session lifecycle logic without explicit user approval.** The stealth/Camoufox backend is the canonical reference that all other backends must follow. Any proposed change to the stealth session lifecycle, login flow sequence, or CMP dismissal cascade MUST be presented to the user for review before implementation.

All backends (cloak, spider-local, zendriver, stealth) MUST implement the same phases in the same order:
1. CMP Dismissal (3-tier cascade: API → Click → CSS Hide)
2. Credential Entry (Autofill replica via `.fill()`)
3. Password Field Re-focus (`.click()` before Enter)
4. Submit with the matrix-selected registered variation. If that invocation is not accepted, advance to the deterministic ordered fallback route; never hide multiple physical actions inside one invocation.

## Mandatory CMP Dismissal (ABSOLUTE — NO EXCEPTIONS)

Every backend MUST execute the 3-tier Cascade CMP Dismissal **before** filling credentials:

1. **Tier 1 — Native API**: `window.CookieInformation?.submitAllCategories?.()`
2. **Tier 2 — UI Click**: Try known selectors (`.coi-banner__accept`, `button:has-text("ACCEPT ALL")`, etc.)
3. **Tier 3 — CSS Hide**: Force `display: none !important` on cookie overlay elements

This cascade was proven critical — stealth/Camoufox failed 100% without it because cookie banners steal focus and intercept Enter keypresses. Removing or skipping this cascade is STRICTLY BANNED.

## Golden Template Flow Directives (ABSOLUTE)

The following behavioral directives from the `stealth` reference implementation MUST be enforced globally across all engine backends:

1. **Cold Start Strict Isolation**: A new browser instance MUST be spawned for every session. Warm pools are strictly prohibited to ensure total identity isolation.
2. **Geo Alignment & Locale Matching**: The browser's locale and timezone MUST mathematically match the proxy's physical geographic location. Discrepancies here trigger instant CAPTCHA flags.
3. **Session Teardown Guarantees**: Session teardown must execute in three unyielding phases:
   - Phase 1: Graceful `browser.close()` bounded by a strict 3000ms timeout.
   - Phase 2: OS-level `SIGKILL` or `taskkill /F` targeting the specific browser PID as a final guarantee.
   - Phase 3: Proxy forwarder teardown.
   Zombie processes leading to fingerprint degradation are unacceptable.
4. **Registered Submit Routing**: The evidence matrix selects the primary registered variation. Each envelope invocation executes exactly one variation; an unaccepted invocation advances to the deterministic ordered fallback route.

## Cashier Verification & DOM Quiescence (ABSOLUTE)

The final verification step (verifying the cashier page load to confirm a successful login) MUST follow the exact sequence implemented in `run-flow-debug.ts` (Step 6) and `engine.ts`:
1. **Network Idle Navigation**: `page.goto` MUST wait for `networkidle` (with a fallback to `domcontentloaded`), not just HTML parse.
2. **Instant Bounce Listener**: A `framenavigated` listener MUST be attached to instantly detect redirects to `/login` or `/signin`.
3. **Mutation Quiescence (DOM Settle)**: Before declaring success, the script MUST wait for the DOM to settle by observing `document.body` with a `MutationObserver` until mutations stop for at least 800ms (capped at 8000ms). Arbitrary `page.waitForTimeout()` sleeps are strictly forbidden here.

## Terminal Session End Conditions (ABSOLUTE)

The app should ONLY ever end a session when one of the following four conditions is met:

1. **Success**: You have successfully navigated to the cashier page after detecting a success and the cashier page navigation is confirmed.
2. **No Account**: Exactly four invocations were recorded, at least three were confirmed accepted by independent signals, every accepted response was `incorrect`, and no account-exists or success terminal appeared. Otherwise the outcome is `INCONCLUSIVE`.
3. **Permanently Disabled**: A "has been disabled" message is detected, meaning the credential is permanently disabled from that target site. The automation requires no more login attempts. After the other target site with that credential is tested, and unless that other site has a success result, the session cookies/session/cache/ip/fingerprint must be burned and the credential banned from future testing (the only exception for banning is a perm_disabled/temp_disabled split).
4. **Temporarily Disabled**: A "temporarily disabled" response is detected. The automation requires no more login attempts. The other target site with that credential is still tested, a countdown of exactly 1 hour is started, and the tested passwords of that email are marked as tested or colored red.

*(Note: There are other less common honeypot and misdirection pages that occur from fingerprinting, but they aren't causing the automations to end early right now. Review their details in other documentation if needed.)*

## Headed Mode & Visual Verification (ABSOLUTE)

1. **Headed vs Headless Contract**: Backends suffixed with `-headed` MUST explicitly set `headless: false` and `liveTest: true`. Bare backend names (e.g., `stealth`, `zendriver`) MUST explicitly default to `headless: true`. There must be no ambiguous `undefined` state for the headless flag.
2. **Grid Tiling for Headed Modes**: Headed modes MUST acquire a slot via `acquireHeadedSlot()` and use the native C# resizer (`BrowserTiler`) to visually tile windows on the desktop.
3. **No Pseudo-Headless for Headed**: Headed modes must never use the `-2000,-2000` off-screen positioning hack. They are meant for visual verification.
4. **Golden Benchmark**: The golden benchmark suite MUST ONLY use `-headed` backends.

## Input Emulation Additions

1. **Async Early "Remember Me" (ABSOLUTE)**: The very first event that happens in each site's script MUST be clicking the "Remember Me" checkbox. This must occur the exact first second the checkbox appears in the DOM, even if the page hasn't fully loaded, and within the first second of it becoming clickable. This is an app-wide and universally adopted rule applying to all backends, modes, and tests. It MUST be implemented via early DOM hooks (e.g. `addInitScript`) to ensure instant execution.
2. **Unconditional "Show Password"**: The password visibility eye-icon MUST be clicked on every single run to simulate human trust behavior.

## Directory Isolation (ABSOLUTE — NO EXCEPTIONS)

You must **NEVER** access, read, or modify the `combined bank statement and metadata cloner` folder on the Desktop (or any of its contents) from this workspace. This rule enforces strict isolation between this web automation project and the bank statement modifier codebase. Any accidental crossover or cross-talk between the two codebases is strictly prohibited.

## Strict Workspace Context Isolation (ABSOLUTE)

You must **NEVER** mix conversation context, plans, or actions from other workspaces into this one. Specifically, you are strictly forbidden from accessing, reading, or modifying any directories or files related to the `rover` project (e.g., `rover-preview-helper`) or any `bank statement` related projects while operating within this `automati1-111` workspace. Always verify that your current working directory and targets are strictly confined to `automati1-111` and ignore context from previous conversations if they apply to a different codebase.

## Autonomous Hermes Directives (ABSOLUTE)

When Hermes is operating in fully autonomous mode (e.g., via `/goal`), it possesses the following elevated privileges and constraints to ensure it can reach the core goal of 100% credential testing coverage:
1. **Unrestricted Internet & Dependency Access**: Hermes has full authorization to browse the internet for solutions and add any necessary 3rd-party dependencies (e.g., `npm install`) required to bypass modern WAFs or resolve issues.
2. **Worker Spawning**: Hermes is explicitly authorized to clone itself or spawn sub-agents/workers to parallelize tasks and increase efficiency.
3. **Full Directory & Config Access**: Hermes has full read/write access to the `.env` file and the entirety of the workspace directory for the purpose of writing hot-fixes, adjusting configs, and executing tests.
4. **Final Repo Changes Require PR (CONSTRAINT)**: While Hermes can manipulate the local directory to achieve the goal, **final structural changes to the core repository must be submitted for user approval**. Hermes is strictly forbidden from directly committing and pushing permanent architectural changes to `main` without generating a Pull Request (PR) or receiving explicit, manual user approval.
5. **Continuous 24/7 Operations (CONSTRAINT)**: Hermes must ensure credential testing continues 24/7. It may pause testing for edits or evaluation for a MAXIMUM of 15-20 minutes. If untested credentials remain in the queue, Hermes must never be idle for more than 20 minutes unless actively editing code. Once edits are complete, testing MUST resume immediately.

## No_Account Classification Rule (ABSOLUTE)

An outcome can ONLY be classified as `NO_ACCOUNT_CONFIRMED` when one target-site session contains exactly four invocation records, at least three invocations are proven accepted by two or more independent post-action signals, every accepted response is `incorrect`, and no `TEMP_DISABLED`, `PERM_DISABLED`, success, challenge, or rate-limit terminal appears. A visually unchanged message does not prove a new accepted submit by itself. Any missing video/evidence, unaccepted envelope, or conflict is `INCONCLUSIVE`.

## 4 Login Attempts Invariant (ABSOLUTE)

This rule overrides ALL other rules: **Exactly 4 physical login attempts MUST occur** before ever moving on to the next credential or next target site, *unless* a hard terminal result (Success, TempDisabled, PermDisabled, 2FA/Challenge) is explicitly detected.
- If a timeout occurs (e.g., `Choreography timeout`) or credentials fail to fill (`Email OK: false, Password OK: false`), the attempt DOES NOT COUNT. The engine must retry or brute-force repair until 4 valid attempts are executed.
- A "success" classification from an empty form submission is a false positive and must be blocked.
- Skipping attempts and moving on prematurely is STRICTLY PROHIBITED.

## Modal-Agnostic Terminal Triggers (ABSOLUTE)

Terminal classification triggers (like 2FA/Authenticator) MUST never be gated behind the disappearance of the password field. Modern frontend architectures (like React portals or z-indexed modals) may obscure the login form without removing its DOM node. If a terminal signal string appears anywhere in the rendered `document.body` text, it must immediately classify as that terminal state.

## TempDisabled Hard Teardown Exception (ABSOLUTE)

The `tempdisabled` signal is a unique exception in the Multi-Level Toxic Burn Protocol. While it proves an account exists and queues a 1-hour retry (making it functionally a "good" signal for the credential), it MUST always be classified as a `HARD_TOXIC` outcome for the session itself. The browser context must be destroyed and the proxy IP must be rotated instantly to prevent cascading WAF/IP reputation bans.

## Darwin Natural Selection Mode & Auto-Pivoting (ABSOLUTE)

1. **Spider Exclusions**: Spider backends (`spider-local`, `spider-cloud`, `spider-local-headed`) are STRICTLY EXCLUDED from Darwin natural selection candidate pools. Only core browser backends (`stealth`, `stealth-headed`, `cloak-headless`, `cloak-headed`, `cloak-headless-nocloak`, `cloak-headed-nocloak`, `zendriver`, `zendriver-headed`) are evaluated.
2. **Mathematical Scoring**: Candidates are scored using the canonical formula:
   $$\text{Score} = 500 \times \text{decisiveRate} + 300 \times \text{successRate} - 400 \times \text{blockRate} - 200 \times \text{failRate} - 100 \times \text{latencyPenalty}$$
3. **Auto-Elimination**: A backend that accumulates $\ge 3$ WAF blocks or structural failures is immediately eliminated from rotation.
4. **Optimal Winner Discovery & Continuous Auto-Pivoting**: When a candidate reaches statistical confidence ($\ge 2$ evaluations with high composite score), Darwin elects the winner, emits `darwin-winner-selected`, saves the diagnostic report to SQLite and `learning/hermes-memory.json`, and **automatically pivots the active batch** to that optimal backend with zero operator intervention.

## Mandatory Cookie Notice Dismissal & Multi-Stage Timing (ABSOLUTE)

On fresh launches for both target sites (**Joe Fortune** and **Ignition Casino**), the engine MUST wait for the Cookie Information / OneTrust banner to mount and execute the 3-tier cascade (`Native API` → `UI Click` → `CSS Force-Hide`) with multi-stage verification triggers at $T+300\text{ms}$, $T+1.5\text{s}$, and $T+3.5\text{s}$ before entering credentials. Form queries before cookie dismissal are strictly forbidden.

