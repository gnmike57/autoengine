import { Page } from "playwright-core";
import "dotenv/config";
import { askLlama } from "../core/ollama-client.js";
import { createLogger } from "../core/logger.js";

const log = createLogger("HermesHealer");

export async function healSelector(page: Page, targetDescription: string): Promise<string | null> {
  try {
    log.info(`[Hermes Healer] Attempting to heal selector for: "${targetDescription}"`);

    const evaluateResult = await page.evaluate(`(() => {
      function getComputedSafe(el) {
        try {
          return window.getComputedStyle(el);
        } catch {
          return null;
        }
      }

      function cleanNode(node, depth) {
        if (!node || depth > 15) return null;
        var nodeType = node.nodeType;
        if (nodeType !== 1 && nodeType !== 11) return null;

        var tag = node.tagName ? String(node.tagName).toLowerCase() : (nodeType === 11 ? 'shadow-root' : 'element');
        if (['script', 'style', 'svg', 'path', 'noscript', 'meta', 'link', 'template'].indexOf(tag) !== -1) return null;

        var x = 0, y = 0, width = 0, height = 0;
        var isVisible = true;
        var zIndex = 0;

        if (nodeType === 1) {
          var rect = node.getBoundingClientRect();
          x = Math.round(rect.x + (window.scrollX || 0));
          y = Math.round(rect.y + (window.scrollY || 0));
          width = Math.round(rect.width);
          height = Math.round(rect.height);

          var style = getComputedSafe(node);
          if (style) {
            if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0' || style.pointerEvents === 'none') {
              isVisible = false;
            }
            var parsedZ = parseInt(style.zIndex, 10);
            if (!isNaN(parsedZ)) zIndex = parsedZ;
          }
        }

        var obj = { tag: tag };
        if (width > 0 && height > 0) {
          obj.x = x;
          obj.y = y;
          obj.w = width;
          obj.h = height;
        }
        if (!isVisible) obj.hidden = true;
        if (zIndex !== 0) obj.z = zIndex;

        if (nodeType === 1) {
          var id = node.getAttribute("id");
          if (id) obj.id = id;
          var name = node.getAttribute("name");
          if (name) obj.name = name;
          var type = node.getAttribute("type");
          if (type) obj.type = type;
          var placeholder = node.getAttribute("placeholder");
          if (placeholder) obj.placeholder = placeholder;
          var ariaLabel = node.getAttribute("aria-label");
          if (ariaLabel) obj.ariaLabel = ariaLabel;
          var testId = node.getAttribute("data-testid") || node.getAttribute("data-qa") || node.getAttribute("data-cy");
          if (testId) obj.testId = testId;
          var role = node.getAttribute("role");
          if (role) obj.role = role;
          var autocomplete = node.getAttribute("autocomplete");
          if (autocomplete) obj.autocomplete = autocomplete;

          var className = node.className;
          if (typeof className === "string" && className.trim()) {
            var filteredClasses = className.split(/\\s+/).filter(function(c) {
              return c && c.length < 30 && !/^[0-9a-f]{8,}$/i.test(c);
            }).slice(0, 3).join(' ');
            if (filteredClasses) obj.class = filteredClasses;
          }

          if (['button', 'a', 'label', 'span', 'p', 'h1', 'h2', 'h3', 'div', 'input'].indexOf(tag) !== -1) {
            var text = node.textContent ? node.textContent.trim().replace(/\\s+/g, ' ') : '';
            if (text && text.length < 60) obj.text = text;
          }
        }

        // Deep Shadow-DOM & iframe piercing
        var childrenList = [];

        // 1. Light DOM Children
        if (node.children) {
          for (var i = 0; i < node.children.length; i++) {
            var c = cleanNode(node.children[i], depth + 1);
            if (c) childrenList.push(c);
          }
        }

        // 2. Open Shadow Root Children
        if (node.shadowRoot && node.shadowRoot.children) {
          for (var j = 0; j < node.shadowRoot.children.length; j++) {
            var sc = cleanNode(node.shadowRoot.children[j], depth + 1);
            if (sc) {
              sc._inShadow = true;
              childrenList.push(sc);
            }
          }
        }

        // 3. Iframe Content Document Body
        if (tag === 'iframe') {
          try {
            var doc = node.contentDocument || (node.contentWindow ? node.contentWindow.document : null);
            if (doc && doc.body) {
              var fc = cleanNode(doc.body, depth + 1);
              if (fc) {
                fc._inIframe = true;
                childrenList.push(fc);
              }
            }
          } catch { /* cross-origin iframe */ }
        }

        if (childrenList.length > 0) {
          obj.children = childrenList;
        }

        // Retain node if it has meaningful attributes, text, or children
        var keysCount = Object.keys(obj).length;
        if (keysCount > 1 || (obj.children && obj.children.length > 0)) {
          return obj;
        }
        return null;
      }

      return cleanNode(document.body, 0);
    })()`);

    const compactedDOM = evaluateResult || {};
    const domString = JSON.stringify(compactedDOM).slice(0, 12000); // Strict compact payload

    const systemPrompt = `You are an expert web automation AI specializing in self-healing DOM selectors.
A hardcoded Playwright script failed to find the element for: "${targetDescription}".
The UI may have changed, modified its attributes, or encapsulated elements inside Web Components / Shadow DOM.

Below is a compacted AST representation of the visible DOM including absolute [x,y,w,h] bounding coordinates, attributes (id, name, type, placeholder, aria-label, data-testid, class), and text.

Rules for your output:
1. Return the single most robust CSS selector for the "${targetDescription}".
2. Selector priority: [data-testid] > [name] > [aria-label] > unique [id] > distinct [type/placeholder] > hierarchical CSS path.
3. Output ONLY the raw CSS selector string without backticks, markdown, or explanations.
4. If the element exists but is obfuscated with random hashes, output the center coordinate formatted as "COORD:x,y" (e.g. COORD:450,600).
5. If you cannot locate the element anywhere in the DOM, output "NULL".`;

    const promptText = `DOM Snapshot AST:\n${domString}\n\nFind target: "${targetDescription}"`;

    // Query local LLM (Ollama) with fallback to OpenRouter/Gemini Flash via askLlama
    const aiResponse = await askLlama(promptText, systemPrompt, false);
    let trimmedResponse = (aiResponse || "").trim();

    // Strip markdown formatting if any was returned
    trimmedResponse = trimmedResponse.replace(/^```[a-z]*\s*/i, "").replace(/\s*```$/i, "").trim();
    trimmedResponse = trimmedResponse.replace(/^['"](.*)['"]$/, "$1").trim();

    if (trimmedResponse && trimmedResponse !== "NULL" && trimmedResponse !== "null") {
      log.info(`[Hermes Healer] Successfully healed selector. New selector: ${trimmedResponse}`);
      return trimmedResponse;
    }

    // Tier 3: Heuristic DOM TreeWalker Fallback
    const heuristic = await page.evaluate((targetDesc: string) => {
      const desc = targetDesc.toLowerCase();
      if (desc.includes("submit") || desc.includes("login button") || desc.includes("sign in")) {
        const candidates = ['button[type="submit"]', 'button:not([disabled])', 'input[type="submit"]', 'a[role="button"]'];
        for (const sel of candidates) {
          const el = document.querySelector(sel);
          if (el && (el as HTMLElement).offsetParent !== null) return sel;
        }
      } else if (desc.includes("email") || desc.includes("username")) {
        const candidates = ['input[type="email"]', 'input[name*="email" i]', 'input[name*="user" i]', 'input[type="text"]'];
        for (const sel of candidates) {
          const el = document.querySelector(sel);
          if (el && (el as HTMLElement).offsetParent !== null) return sel;
        }
      } else if (desc.includes("password")) {
        const candidates = ['input[type="password"]', 'input[name*="pass" i]'];
        for (const sel of candidates) {
          const el = document.querySelector(sel);
          if (el && (el as HTMLElement).offsetParent !== null) return sel;
        }
      } else if (desc.includes("remember")) {
        const candidates = ['input[type="checkbox"]', '#rememberMe', 'input[name*="remember" i]'];
        for (const sel of candidates) {
          const el = document.querySelector(sel);
          if (el) return sel;
        }
      }
      return null;
    }, targetDescription).catch(() => null);

    if (heuristic) {
      log.info(`[Hermes Healer] Heuristic fallback discovered selector: ${heuristic}`);
      return heuristic;
    }

    log.warn(`[Hermes Healer] AI and Heuristics could not determine a new selector.`);
    return null;
  } catch (e: unknown) {
    log.warn(`[Hermes Healer] Healing failed: ${e instanceof Error ? e.message : String(e)}`);
    return null;
  }
}

