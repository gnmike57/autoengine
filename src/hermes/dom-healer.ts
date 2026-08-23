import { Page } from "playwright-core";
import "dotenv/config";
import { askLlama } from "../core/ollama-client.js";

export async function healSelector(page: Page, targetDescription: string): Promise<string | null> {
  try {
    console.log(`[Hermes Healer] Attempting to heal selector for: "${targetDescription}"`);

    const evaluateResult = await page.evaluate(`(() => {
      function cleanNode(node) {
        if (!node || (node.nodeType !== 1 && node.nodeType !== 11)) return null;
        
        var tag = node.tagName ? String(node.tagName).toLowerCase() : 'shadow-root';
        if (['script', 'style', 'svg', 'path', 'noscript', 'meta', 'link'].indexOf(tag) !== -1) return null;

        var x = 0, y = 0, width = 1, height = 1;
        if (node.nodeType === 1) {
          var rect = node.getBoundingClientRect();
          if (rect.width === 0 || rect.height === 0) return null;
          x = Math.round(rect.x + (window.scrollX || 0));
          y = Math.round(rect.y + (window.scrollY || 0));
          width = rect.width;
          height = rect.height;
        }

        var obj = { tag: tag, x: x, y: y };

        if (node.nodeType === 1) {
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

          if (['button', 'a', 'label', 'span', 'div', 'iframe', 'input'].indexOf(tag) !== -1) {
            var text = node.textContent ? node.textContent.trim() : '';
            if (text && text.length < 50) obj.text = text;
          }
        }

        var childrenNodes = node.shadowRoot ? Array.from(node.shadowRoot.children) : Array.from(node.children || []);
        var children = childrenNodes
          .map(function(child) { return cleanNode(child); })
          .filter(Boolean);

        if (children.length > 0) obj.children = children;

        return Object.keys(obj).length > 3 ? obj : null;
      }
      return cleanNode(document.body);
    })()`);

    const compactedDOM = evaluateResult || {};
    const domString = JSON.stringify(compactedDOM).slice(0, 15000); // Prevent massive payloads

    const systemPrompt = `You are an expert web automation AI. A hardcoded Playwright script failed to find the element for: "${targetDescription}".
The UI may have changed. Below is a compacted JSON representation of the currently visible DOM including [x,y] absolute coordinates.

Find the most robust CSS selector for the "${targetDescription}".
Output ONLY the raw CSS selector string. Do not use markdown, do not use backticks, do not add explanations.
If the element exists but is heavily obfuscated without viable CSS attributes, output the coordinates in the exact format "COORD:x,y" (e.g. COORD:450,600).
If you absolutely cannot find it anywhere in the DOM, output "NULL".`;

    const promptText = `DOM Snapshot:\n${domString}`;

    // Query local LLM (Ollama) with a fallback to OpenRouter handled inside askLlama
    const aiResponse = await askLlama(promptText, systemPrompt, false);
    const trimmedResponse = aiResponse.trim();

    if (trimmedResponse && trimmedResponse !== "NULL" && trimmedResponse !== "null") {
      console.log(`[Hermes Healer] Successfully healed selector. New selector: ${trimmedResponse}`);
      return trimmedResponse;
    }

    console.warn(`[Hermes Healer] AI could not determine a new selector.`);
    return null;
  } catch (e: unknown) {
    console.warn(`[Hermes Healer] Healing failed: ${e instanceof Error ? e.message : String(e)}`);
    return null;
  }
}
