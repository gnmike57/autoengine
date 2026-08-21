/**
 * SubmitButtonStateTracker — Intelligent, event-driven submit button state tracking.
 *
 * Replaces the previous passive systems:
 *   1. Submit Ready Gate (fixed timeout polling)
 *   2. Submit Mutation Observer (outerHTML + disabled checks)
 *   3. Fixed timing waits (POST_CLICK_RACE_DELAY, FAST_RACE_WINDOW, etc.)
 *
 * Architecture: State machine with event-driven transitions.
 *
 * States:
 *   IDLE → PRESSED → PROCESSING → RESPONSE_RECEIVED → IDLE
 *
 * Detection methods (combined):
 *   - MutationObserver on button element (attributes, childList, subtree)
 *   - Computed style polling (backgroundColor, color, opacity, borderColor)
 *   - Error text change detection in form area
 *   - Network/cloak_status detection integration
 *
 * The login flow subscribes to state transitions and only proceeds when
 * the tracker reports the button is back to IDLE.
 */

import type { Page } from "playwright-core";

export type ButtonState = "IDLE" | "PRESSED" | "PROCESSING" | "RESPONSE_RECEIVED";

export interface ButtonStyleBaseline {
  backgroundColor: string;
  color: string;
  opacity: string;
  borderColor: string;
  pointerEvents: string;
  text: string;
  disabled: boolean;
  ariaDisabled: string | null;
}

export interface SubmitAcceptanceSnapshot {
  state: ButtonState;
  mutationCount: number;
  domMutation: boolean;
  errorTextChanged: boolean;
  buttonHtmlChanged: boolean;
  cloakStatus: string | null;
  responseObserved: boolean;
}

export interface SubmitTrackerOptions {
  /** Submit button selector. */
  submitSelector: string;
  /** Email/username input selector (for error text scope). */
  emailSelector: string;
  /** Password input selector. */
  passwordSelector: string;
  /** Site name for logging. */
  siteName: string;
  /** Debounce buffer after style returns to baseline. Default: 500ms. */
  readyBufferMs?: number;
  /** Max time to wait for the button to return to IDLE. Default: 15000ms. */
  maxWaitMs?: number;
  /** Polling interval for style checks. Default: 100ms. */
  pollIntervalMs?: number;
}

const log = {
  info: (...args: unknown[]) => console.log("[SubmitTracker]", ...args),
  warn: (...args: unknown[]) => console.warn("[SubmitTracker]", ...args),
  debug: (...args: unknown[]) => console.log("[SubmitTracker:DEBUG]", ...args),
};

export class SubmitButtonStateTracker {
  private _state: ButtonState = "IDLE";
  private _baseline: ButtonStyleBaseline | null = null;
  private _installed = false;
  private page: Page;
  private options: Required<SubmitTrackerOptions>;

  constructor(page: Page, options: SubmitTrackerOptions) {
    this.page = page;
    this.options = {
      submitSelector: options.submitSelector,
      emailSelector: options.emailSelector,
      passwordSelector: options.passwordSelector,
      siteName: options.siteName,
      readyBufferMs: options.readyBufferMs ?? 500,
      maxWaitMs: options.maxWaitMs ?? 15000,
      pollIntervalMs: options.pollIntervalMs ?? 100,
    };
  }

  /** Current button state. */
  getState(): ButtonState {
    return this._state;
  }

  /** Current style baseline (captured before submit). */
  getBaseline(): ButtonStyleBaseline | null {
    return this._baseline;
  }

  /**
   * Return the durable post-invocation evidence used by the account
   * classifier. This does not decide acceptance by itself; callers combine it
   * with network and form-state signals under Project Rule 1.
   */
  async getAcceptanceSnapshot(): Promise<SubmitAcceptanceSnapshot> {
    const inPage = await this.page.evaluate(() => {
      const SYM = Symbol.for("submitTracker");
      const STATUS_SYM = Symbol.for("cloak_status");
      const state = (window as any)[SYM] as {
        mutationCount?: number;
        errorTextChanged?: boolean;
        buttonHtmlChanged?: boolean;
      } | undefined;
      return {
        mutationCount: state?.mutationCount ?? 0,
        errorTextChanged: Boolean(state?.errorTextChanged),
        buttonHtmlChanged: Boolean(state?.buttonHtmlChanged),
        cloakStatus: ((window as any)[STATUS_SYM] ?? null) as string | null,
      };
    }).catch(() => ({
      mutationCount: 0,
      errorTextChanged: false,
      buttonHtmlChanged: false,
      cloakStatus: null as string | null,
    }));

    const domMutation = inPage.mutationCount > 0 || inPage.buttonHtmlChanged;
    const responseObserved = inPage.errorTextChanged || Boolean(inPage.cloakStatus) || this._state === "RESPONSE_RECEIVED";
    return {
      state: this._state,
      mutationCount: inPage.mutationCount,
      domMutation,
      errorTextChanged: inPage.errorTextChanged,
      buttonHtmlChanged: inPage.buttonHtmlChanged,
      cloakStatus: inPage.cloakStatus,
      responseObserved,
    };
  }

  /**
   * Install the in-page MutationObserver that watches the submit button
   * for attribute, child, and style changes. Also sets up error text
   * baseline tracking in the form area.
   */
  async install(): Promise<void> {
    if (this._installed) return;
    this._installed = true;

    await this.page.evaluate(
      ({ submitSel, emailSel }: { submitSel: string; emailSel: string }) => {
        const SYM = Symbol.for("submitTracker");
        interface TrackerState {
          mutationCount: number;
          lastMutationTime: number;
          baselineErrorText: string;
          currentErrorText: string;
          errorTextChanged: boolean;
          buttonHtmlChanged: boolean;
          initialHtml: string;
        }

        const getDeepText = (root: Node): string => {
          let text = "";
          if (root.nodeType === Node.TEXT_NODE) return (root.textContent || "").trim();
          if (root.nodeType === Node.ELEMENT_NODE) {
            const tag = (root as Element).tagName.toLowerCase();
            if (tag === "script" || tag === "style" || tag === "noscript") return "";
            if ((root as Element).shadowRoot) text += " " + getDeepText((root as Element).shadowRoot as unknown as Node);
          }
          const childNodes = root.childNodes || [];
          for (let i = 0; i < childNodes.length; i++) {
            text += " " + getDeepText(childNodes[i]!);
          }
          return text;
        };

        const getFormErrorText = (): string => {
          const emailEl = document.querySelector(emailSel);
          let target: Node = document.body;
          if (emailEl) {
            let parent = emailEl.parentElement;
            for (let i = 0; i < 4; i++) {
              if (parent?.parentElement) parent = parent.parentElement;
            }
            if (parent) target = parent;
          }
          try {
            return getDeepText(target).replace(/\s+/g, " ").trim().substring(0, 2000).toLowerCase();
          } catch {
            return (document.body.textContent || "").substring(0, 2000).toLowerCase();
          }
        };

        const btn = document.querySelector(submitSel);
        const initialErrorText = getFormErrorText();
        const state: TrackerState = {
          mutationCount: 0,
          lastMutationTime: 0,
          baselineErrorText: initialErrorText,
          currentErrorText: initialErrorText,
          errorTextChanged: false,
          buttonHtmlChanged: false,
          initialHtml: btn?.outerHTML || "",
        };

        (window as any)[SYM] = state;

        if (!btn) return;

        // Watch button for mutations
        const btnObserver = new MutationObserver(() => {
          state.mutationCount++;
          state.lastMutationTime = Date.now();
          if (btn.outerHTML !== state.initialHtml) {
            state.buttonHtmlChanged = true;
          }
        });
        btnObserver.observe(btn, { attributes: true, childList: true, subtree: true, characterData: true });

        // Watch form area for error text changes
        const formArea = document.querySelector(emailSel)?.closest("form") || document.body;
        const formObserver = new MutationObserver(() => {
          const newText = getFormErrorText();
          if (newText !== state.baselineErrorText) {
            state.errorTextChanged = true;
            state.currentErrorText = newText;
          }
        });
        formObserver.observe(formArea, { childList: true, subtree: true, characterData: true });

        // Deep shadow DOM observation
        const observeNodeAndShadows = (node: Node) => {
          try {
            formObserver.observe(node, { childList: true, subtree: true, characterData: true });
          } catch { /* intentional */ }
          if ((node as Element).shadowRoot) {
            observeNodeAndShadows((node as Element).shadowRoot as unknown as Node);
          }
          const walker = document.createTreeWalker(node, NodeFilter.SHOW_ELEMENT);
          let child = walker.nextNode();
          while (child) {
            if ((child as Element).shadowRoot) {
              observeNodeAndShadows((child as Element).shadowRoot as unknown as Node);
            }
            child = walker.nextNode();
          }
        };
        observeNodeAndShadows(formArea);

        // Cleanup
        (window as any).__submitTrackerCleanup = () => {
          btnObserver.disconnect();
          formObserver.disconnect();
        };
      },
      { submitSel: this.options.submitSelector, emailSel: this.options.emailSelector }
    ).catch(() => { /* intentional */ });
  }

  /**
   * Capture the visual baseline of the submit button BEFORE submitting.
   * This includes computed styles, text content, and disabled state.
   */
  async captureBaseline(): Promise<ButtonStyleBaseline | null> {
    try {
      this._baseline = await this.page.evaluate((sel: string) => {
        const btn = document.querySelector(sel);
        if (!btn) return null;
        const style = window.getComputedStyle(btn);
        return {
          backgroundColor: style.backgroundColor,
          color: style.color,
          opacity: style.opacity,
          borderColor: style.borderColor,
          pointerEvents: style.pointerEvents,
          text: (btn.textContent || "").trim(),
          disabled: (btn as HTMLButtonElement).disabled,
          ariaDisabled: btn.getAttribute("aria-disabled"),
        };
      }, this.options.submitSelector);

      if (this._baseline) {
        log.debug(`${this.options.siteName}: Baseline captured: bg=${this._baseline.backgroundColor} text="${this._baseline.text}" disabled=${this._baseline.disabled}`);
      }
      return this._baseline;
    } catch {
      return null;
    }
  }

  /**
   * Get the current computed styles of the submit button.
   */
  async getCurrentStyles(): Promise<ButtonStyleBaseline | null> {
    try {
      return await this.page.evaluate((sel: string) => {
        const btn = document.querySelector(sel);
        if (!btn) return null;
        const style = window.getComputedStyle(btn);
        return {
          backgroundColor: style.backgroundColor,
          color: style.color,
          opacity: style.opacity,
          borderColor: style.borderColor,
          pointerEvents: style.pointerEvents,
          text: (btn.textContent || "").trim(),
          disabled: (btn as HTMLButtonElement).disabled,
          ariaDisabled: btn.getAttribute("aria-disabled"),
        };
      }, this.options.submitSelector);
    } catch {
      return null;
    }
  }

  /**
   * Compare two style baselines to determine if they match.
   */
  private stylesMatch(a: ButtonStyleBaseline, b: ButtonStyleBaseline): boolean {
    return (
      a.backgroundColor === b.backgroundColor &&
      a.color === b.color &&
      a.opacity === b.opacity &&
      a.disabled === b.disabled &&
      a.pointerEvents === b.pointerEvents
    );
  }

  /**
   * Check if the button is currently in a loading/processing state.
   */
  async isButtonLoading(): Promise<boolean> {
    try {
      return await this.page.evaluate((sel: string) => {
        const btn = document.querySelector(sel);
        if (!btn) return false;

        // Check disabled state
        if ((btn as HTMLButtonElement).disabled) return true;
        if (btn.getAttribute("aria-disabled") === "true") return true;
        if (btn.getAttribute("aria-busy") === "true") return true;

        // Check for spinner elements
        const spinnerSel =
          '[class*="spin" i],[class*="loader" i],[class*="loading" i],' +
          '[role="progressbar"],[class*="lds-" i],svg[class*="animate" i]';
        if (btn.querySelector(spinnerSel)) return true;

        // Check text content for loading indicators
        const txt = (btn.textContent || "").trim().toLowerCase();
        if (/loading|signing|please wait|processing|verifying|submitting|authenticat/i.test(txt)) {
          return true;
        }

        // Check computed styles
        const style = window.getComputedStyle(btn);
        if (style.pointerEvents === "none") return true;
        const op = parseFloat(style.opacity || "1");
        if (!isNaN(op) && op < 0.5) return true;

        return false;
      }, this.options.submitSelector);
    } catch {
      return false;
    }
  }

  /**
   * Mark that a submit action (click/Enter) has been performed.
   * Transitions state from IDLE → PRESSED.
   */
  async markSubmitted(): Promise<void> {
    this._state = "PRESSED";
    log.debug(`${this.options.siteName}: State → PRESSED`);

    // Reset the in-page tracker state for fresh monitoring
    await this.page.evaluate(() => {
      const SYM = Symbol.for("submitTracker");
      const state = (window as any)[SYM];
      if (state) {
        state.mutationCount = 0;
        state.lastMutationTime = 0;
        state.errorTextChanged = false;
        state.buttonHtmlChanged = false;
      }
    }).catch(() => { /* intentional */ });
  }

  /**
   * Reset error text baseline (for use when restarting attempts).
   */
  async resetErrorBaseline(): Promise<void> {
    await this.page.evaluate(({ emailSel }: { emailSel: string }) => {
      const SYM = Symbol.for("submitTracker");
      const state = (window as any)[SYM];
      if (!state) return;

      const getDeepText = (root: Node): string => {
        let text = "";
        if (root.nodeType === Node.TEXT_NODE) return (root.textContent || "").trim();
        if (root.nodeType === Node.ELEMENT_NODE) {
          const tag = (root as Element).tagName.toLowerCase();
          if (tag === "script" || tag === "style" || tag === "noscript") return "";
          if ((root as Element).shadowRoot) text += " " + getDeepText((root as Element).shadowRoot as unknown as Node);
        }
        const childNodes = root.childNodes || [];
        for (let i = 0; i < childNodes.length; i++) {
          text += " " + getDeepText(childNodes[i]!);
        }
        return text;
      };

      let target: Node = document.body;
      const emailEl = document.querySelector(emailSel);
      if (emailEl) {
        let parent = emailEl.parentElement;
        for (let i = 0; i < 4; i++) {
          if (parent?.parentElement) parent = parent.parentElement;
        }
        if (parent) target = parent;
      }
      
      let text = "";
      try {
        text = getDeepText(target).replace(/\s+/g, " ").trim().substring(0, 2000).toLowerCase();
      } catch {
        text = target.textContent ? target.textContent.substring(0, 2000).toLowerCase() : "";
      }
      state.baselineErrorText = text;
      state.currentErrorText = text;
      state.errorTextChanged = false;
      state.buttonHtmlChanged = false;
      state.initialHtml = document.querySelector(state.submitSel)?.outerHTML || state.initialHtml;
    }, { emailSel: this.options.emailSelector }).catch(() => { /* intentional */ });
  }

  /**
   * MAIN GATE: Wait until the submit button returns to IDLE state.
   *
   * State machine flow:
   *   PRESSED → PROCESSING (style changed from baseline)
   *           → RESPONSE_RECEIVED (error text changed OR cloak_status set)
   *           → IDLE (styles returned to baseline + 500ms buffer)
   *
   * Returns the final state. If timeout is hit, returns the last known state.
   */
  async waitUntilReady(timeoutMs?: number): Promise<ButtonState> {
    const { maxWaitMs, pollIntervalMs, readyBufferMs, siteName } = this.options;
    const effectiveTimeout = timeoutMs ?? maxWaitMs;
    const startTime = Date.now();
    let baselineMatchStart: number | null = null;

    if (!this._baseline) {
      log.warn(`${siteName}: No baseline captured — falling back to loading check`);
      return this.waitUntilNotLoading(effectiveTimeout);
    }

    while (Date.now() - startTime < effectiveTimeout) {
      if (this.page.isClosed()) return this._state;

      const elapsed = Date.now() - startTime;
      const currentStyles = await this.getCurrentStyles();

      if (!currentStyles) {
        // Button gone from DOM — possible success (form vanished)
        this._state = "RESPONSE_RECEIVED";
        log.info(`${siteName}: Button gone from DOM at T+${elapsed}ms → RESPONSE_RECEIVED`);
        return this._state;
      }

      // Get in-page tracker state
      const trackerState = await this.page.evaluate(() => {
        const SYM = Symbol.for("submitTracker");
        return (window as any)[SYM] as {
          errorTextChanged: boolean;
          buttonHtmlChanged: boolean;
          mutationCount: number;
        } | null;
      }).catch(() => null);

      switch (this._state) {
        case "PRESSED": {
          // Transition to PROCESSING when styles differ from baseline
          if (!this.stylesMatch(currentStyles, this._baseline)) {
            this._state = "PROCESSING";
            log.debug(`${siteName}: Style changed at T+${elapsed}ms → PROCESSING (bg: ${this._baseline.backgroundColor} → ${currentStyles.backgroundColor})`);
          } else if (currentStyles.disabled || currentStyles.ariaDisabled === "true") {
            this._state = "PROCESSING";
            log.debug(`${siteName}: Button disabled at T+${elapsed}ms → PROCESSING`);
          } else if (trackerState?.buttonHtmlChanged) {
            this._state = "PROCESSING";
            log.debug(`${siteName}: Button HTML changed at T+${elapsed}ms → PROCESSING`);
          }
          // If no style change after 2s, the click may not have registered
          if (elapsed > 2000 && this._state === "PRESSED") {
            log.warn(`${siteName}: ⚠ No style change after 2s — click may not have registered`);
            this._state = "PROCESSING"; // Move forward anyway
          }
          break;
        }

        case "PROCESSING": {
          // Transition to RESPONSE_RECEIVED when error text changes or cloak_status set
          if (trackerState?.errorTextChanged) {
            this._state = "RESPONSE_RECEIVED";
            log.debug(`${siteName}: Error text changed at T+${elapsed}ms → RESPONSE_RECEIVED`);
          }

          // Check cloak_status
          const cloakStatus = await this.page.evaluate(() => {
            const STATUS_SYM = Symbol.for("cloak_status");
            return (window as any)[STATUS_SYM] ?? null;
          }).catch(() => null);

          if (cloakStatus) {
            this._state = "RESPONSE_RECEIVED";
            log.debug(`${siteName}: cloak_status=${cloakStatus} at T+${elapsed}ms → RESPONSE_RECEIVED`);
          }

          // Check if URL moved (success redirect)
          // This is checked by the caller, not here — keep this focused on button state
          break;
        }

        case "RESPONSE_RECEIVED": {
          // Transition to IDLE when styles return to baseline + buffer
          if (this.stylesMatch(currentStyles, this._baseline) && !currentStyles.disabled) {
            if (baselineMatchStart === null) {
              baselineMatchStart = Date.now();
              log.debug(`${siteName}: Styles returned to baseline — waiting ${readyBufferMs}ms buffer`);
            } else if (Date.now() - baselineMatchStart >= readyBufferMs) {
              this._state = "IDLE";
              log.info(`${siteName}: ✅ Button IDLE at T+${elapsed}ms (ready for next attempt)`);
              return this._state;
            }
          } else {
            baselineMatchStart = null; // Reset if styles diverge again
          }
          break;
        }

        case "IDLE": {
          return this._state;
        }
      }

      await new Promise((r) => setTimeout(r, pollIntervalMs));
    }

    // Timeout
    log.warn(`${siteName}: ⚠ waitUntilReady timed out after ${effectiveTimeout}ms in state ${this._state}`);

    // Force to IDLE on timeout (proceed anyway, don't block forever)
    this._state = "IDLE";
    return this._state;
  }

  /**
   * Fallback: wait until the button is no longer in a loading state.
   * Used when no baseline was captured.
   */
  private async waitUntilNotLoading(timeoutMs: number): Promise<ButtonState> {
    const startTime = Date.now();
    while (Date.now() - startTime < timeoutMs) {
      if (this.page.isClosed()) return this._state;
      const loading = await this.isButtonLoading();
      if (!loading) {
        // 500ms buffer
        await new Promise((r) => setTimeout(r, this.options.readyBufferMs));
        const stillLoading = await this.isButtonLoading();
        if (!stillLoading) {
          this._state = "IDLE";
          return this._state;
        }
      }
      await new Promise((r) => setTimeout(r, this.options.pollIntervalMs));
    }
    this._state = "IDLE";
    return this._state;
  }

  /**
   * Reset tracker state for a fresh attempt.
   */
  reset(): void {
    this._state = "IDLE";
    this._baseline = null;
  }

  /**
   * Cleanup in-page observers.
   */
  async cleanup(): Promise<void> {
    await this.page.evaluate(() => {
      if ((window as any).__submitTrackerCleanup) {
        (window as any).__submitTrackerCleanup();
      }
    }).catch(() => { /* intentional */ });
  }
}
