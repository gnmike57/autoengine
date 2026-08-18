---
name: captcha-solver
description: Standardized autonomous heuristics for visually identifying and solving bot challenges and visual captchas
---

# Captcha Solver Skill

This skill equips the autonomous agent with the logic required to handle visual captchas (e.g., reCAPTCHA, hCaptcha, Turnstile, FunCaptcha) encountered during the login flow.

## 1. Detection Phase
When `timeline-analyzer` or `ai-page-diagnosis` flags a state as `captcha` or `bot_challenge`:
1. **Identify Type**: Isolate the iframe or shadow DOM holding the challenge.
   - reCAPTCHA: `.g-recaptcha` or `iframe[src*="recaptcha"]`
   - hCaptcha: `.h-captcha` or `iframe[src*="hcaptcha"]`
   - Turnstile: `.cf-turnstile` or `iframe[src*="turnstile"]`
2. **Audio Fallback Priority**: Always attempt to trigger the audio challenge version first. 
   - Visual captchas have high failure rates for LLMs due to dynamic grid rendering.
   - Audio captchas can be bypassed by feeding the `.wav` or `.mp3` stream to an internal whisper model or external transcribers.

## 2. Bypass Strategy (Tiered)

### Tier 1: Passive Solve (Turnstile / Invisible reCAPTCHA)
Some captchas only require the mouse to move naturally over the widget or the page to be focused.
- Ensure `browser-warmer` or the current active page is strictly focused.
- Execute a randomized, bezier-curved mouse movement over the widget bounds using `ghost-cursor-playwright`.
- Wait up to 5000ms.

### Tier 2: Audio Challenge Bypass
If a visual grid appears:
1. Click the "headset" or "audio" icon (usually `button[title="Get an audio challenge"]` or similar).
2. Intercept the network request to the audio source (`.mp3` or `.wav`).
3. Download the buffer and transcribe it.
4. Inject the resulting text string into the audio response input field using typed events with standard `baseKeyDelayMs` pacing.

### Tier 3: Visual Grid Processing (Llava Fallback)
If audio is unavailable:
1. Extract the base64 image of the captcha grid.
2. Send to local `llava` via `ollama-client` with a prompt mapping the 3x3 or 4x4 grid to coordinate centers.
3. Map the returned grid indices (e.g., 0, 3, 4) to specific X/Y coordinate clicks within the viewport using `window-manager`.

## 3. Post-Solve Validation
- After submitting a challenge, always wait for the `networkidle` state to settle.
- If the captcha resets, DO NOT instantly retry. Wait 1500ms before attempting the next solve to prevent rate-limiting hooks from flagging the session.
