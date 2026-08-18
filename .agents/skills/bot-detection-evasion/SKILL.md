---
name: bot-detection-evasion
description: Techniques for spoofing WebGL, Canvas, and AudioContext fingerprints to evade advanced WAFs like DataDome and Akamai.
---

# Bot Detection Evasion Skill

Target endpoints actively fingerprint headless and automated browsers by probing specific graphical, audio, and JS environment artifacts.

## Core Evasion Pillars

### 1. Canvas Noise Injection
WAFs silently draw a canvas off-screen and hash the image data. Automated browsers often render this perfectly, whereas human machines have minor hardware artifacts.
- **Implementation**: Hook `HTMLCanvasElement.prototype.toDataURL` and `getImageData`. Inject a subtle, deterministic noise pattern based on the session's random seed by slightly modifying the RGB values of a few pixels.
- **Rule**: Never randomize on every call. The noise MUST be deterministic per session, otherwise the fingerprint changes between pages, instantly triggering a bot flag.

### 2. AudioContext Spoofing
WAFs calculate the audio dynamics (oscillator drift) to detect headless virtual environments.
- **Implementation**: Hook `AudioBuffer.prototype.getChannelData`. Inject a deterministic float offset (-0.000001 to +0.000001) into the array.

### 3. WebGL Spoofing
WebGL extracts precise hardware capabilities (GPU vendor, renderer, WebGL extensions).
- **Implementation**: Override `WebGLRenderingContext.prototype.getParameter` and `getExtension`.
- **Constraint**: The injected GPU (e.g., `Apple M1` or `Intel Iris Plus Graphics`) MUST mathematically align with the User-Agent's Operating System. Do not spoof an Apple M1 on a Windows User-Agent.

### 4. CDP Evasion
The Chrome DevTools Protocol (CDP) exposes debugging traces (e.g., `Runtime.enable`, `Page.enable`).
- **Implementation**: You MUST ensure that the stealth backend disables `Runtime.enable` during navigation or uses external proxy TLS manipulation (e.g., HTTPCloak/Camoufox) to scrub HTTP headers that reveal CDP activity.
- **Hardware Concurrency**: Ensure `navigator.hardwareConcurrency` perfectly matches the generated hardware profile of the session (typically 4, 8, or 16). 

## Continuous Validation
Any time a bot-detection bypass is updated, the changes must be validated against `fingerprint-ai-verifier.ts` to ensure no impossible "Frankenstein" hardware profiles have been created.
