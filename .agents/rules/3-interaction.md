---
trigger: always_on
---

⌨️ 3. INTERACTION PHYSICS & INPUT EMULATION
Credential Input (Autofill Replica): When injecting the primary login credentials (email/password combo), the code must bypass manual typing speeds and replicate native browser Autofill mechanics (instant application of state via JS properties mapped directly to React's internal state tracker).

Standard DOM Interaction: For ALL OTHER interactions (typing in secondary fields, solving prompts, UI clicks), you must replicate standard human-like DOM events. You MUST dispatch synthetic TrustedEvent constructs (input, change, keydown) to synchronize state back to the virtual DOM. Direct property manipulation (element.value = ... or element.click()) without these trusted event chains is STRICTLY BANNED.

Mandatory Biometrics & Humanization:

Early "Remember Me": Find and activate "Remember Me" checkboxes strictly via an early DOM initialization hook (e.g., `addInitScript`) the exact moment they register in the DOM, even before the page has fully loaded.

"Show Password": The password visibility eye-icon MUST be clicked on every single run, app-wide, to simulate human trust behavior.

Non-Blocking Noise: Fire 1 randomized right-click and 1 left click (context menu events) across the viewport within the first 50-300ms of page load. This must run asynchronously via promises and NEVER block the main execution thread.
