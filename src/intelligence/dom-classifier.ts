/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access */
import { type Page } from "playwright-core";
import { createLogger } from "../core/logger.js";

const log = createLogger("dom-classifier");

/**
 * Injects a dual-system classification observer into the page.
 * This runs alongside the existing network + simple polling loop.
 * It uses a MutationObserver to evaluate DOM structure changes immediately,
 * without waiting for the 20ms poll cycle or network response.
 * It writes directly to the existing cloak_status symbol so the engine's
 * `waitForFunction` picks it up instantly.
 */
export async function injectDualClassifier(page: Page, _siteName: string) {
  try {
    await page.addInitScript(() => {
      const STATUS_SYM = Symbol.for("cloak_status");

      // We only want to classify after the form is submitted, but the script
      // runs early. We'll start observing once DOMContentLoaded fires.
      let observer: MutationObserver | null = null;

      const classifyDOM = () => {
        if (window[STATUS_SYM as any]) return;

        // Shadow DOM Modal Scan (Rule 18)
        let modalText = "";
        const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_ELEMENT);
        let node = walker.nextNode();
        while (node) {
          const el = node as Element;
          if (el.shadowRoot) {
            const shadowWalker = document.createTreeWalker(el.shadowRoot, NodeFilter.SHOW_ELEMENT);
            let shadowNode = shadowWalker.nextNode();
            while (shadowNode) {
               const sel = shadowNode as Element;
               if (sel.matches('[role="dialog"], .modal, .overlay')) {
                   modalText += " " + (sel.textContent || "");
               }
               shadowNode = shadowWalker.nextNode();
            }
          }
          if (el.matches('[role="dialog"], .modal, .overlay')) {
            modalText += " " + (el.textContent || "");
          }
          node = walker.nextNode();
        }

        modalText = modalText.toLowerCase();
        if (modalText.includes("identity verification") || modalText.includes("under review")) {
          (window as any)[STATUS_SYM] = "honeypot";
          return;
        }
        if (modalText.includes("authenticator") || modalText.includes("2fa")) {
          (window as any)[STATUS_SYM] = "2FA";
          return;
        }

        const bodyText = document.body?.innerText?.toLowerCase() || "";

        // Success Detection (Rule 17)
        if (/welcome!/i.test(bodyText)) {
          (window as any)[STATUS_SYM] = "success";
          return;
        }

        // Hard terminal states
        if (bodyText.includes("permanently") || bodyText.includes("been disabled")) {
          (window as any)[STATUS_SYM] = "permanently";
          return;
        }
        if (bodyText.includes("temporarily") || bodyText.includes("locked") || bodyText.includes("too many")) {
          (window as any)[STATUS_SYM] = "temporarily_disabled";
          return;
        }
        if (bodyText.includes("not found") || bodyText.includes("no account")) {
          (window as any)[STATUS_SYM] = "noaccount";
          return;
        }
      };

      const startObserving = () => {
        if (observer) return;
        observer = new MutationObserver((mutations) => {
          let hasSignificantChange = false;
          for (const m of mutations) {
            if (m.type === "childList" && m.addedNodes.length > 0) {
              hasSignificantChange = true;
              break;
            }
            if (m.type === "characterData") {
              hasSignificantChange = true;
              break;
            }
          }

          if (hasSignificantChange) {
            classifyDOM();
          }
        });

        if (document.body) {
          observer.observe(document.body, { childList: true, subtree: true, characterData: true });
        }
      };

      if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", startObserving);
      } else {
        startObserving();
      }
    });
    log.debug(`Injected dual-system DOM classifier for ${_siteName}`);
  } catch (e) {
    log.warn(`Failed to inject DOM classifier: ${String(e)}`);
  }
}
