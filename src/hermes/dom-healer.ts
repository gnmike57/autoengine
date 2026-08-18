import { Page } from "playwright-core";
import "dotenv/config";
import { askLlama } from "../core/ollama-client.js";

export async function healSelector(page: Page, targetDescription: string): Promise<string | null> {
  try {
    console.log(`[Hermes Healer] Attempting to heal selector for: "${targetDescription}"`);

    const evaluateResult = await page.evaluate(() => {
      function cleanNode(node: Element | ShadowRoot): any {
        // Fallback for ShadowRoot (nodeType 11) or Element (nodeType 1)
        if (node.nodeType !== 1 && node.nodeType !== 11) return null;
        
        const tag = (node as Element).tagName ? (node as Element).tagName.toLowerCase() : 'shadow-root';
        if (['script', 'style', 'svg', 'path', 'noscript', 'meta', 'link'].includes(tag)) return null;

        let x = 0, y = 0, width = 1, height = 1;
        if (node.nodeType === 1) { // Element
          const el = node as Element;
          const rect = el.getBoundingClientRect();
          if (rect.width === 0 || rect.height === 0) return null;
          x = Math.round(rect.x + window.scrollX);
          y = Math.round(rect.y + window.scrollY);
          width = rect.width;
          height = rect.height;
        }

        const obj: any = { tag, x, y };

        if (node.nodeType === 1) {
          const el = node as Element;
          const id = el.getAttribute("id");
          if (id) obj.id = id;
          const name = el.getAttribute("name");
          if (name) obj.name = name;
          const type = el.getAttribute("type");
          if (type) obj.type = type;
          const placeholder = el.getAttribute("placeholder");
          if (placeholder) obj.placeholder = placeholder;
          const ariaLabel = el.getAttribute("aria-label");
          if (ariaLabel) obj.ariaLabel = ariaLabel;

          if (['button', 'a', 'label', 'span', 'div', 'iframe', 'input'].includes(tag)) {
            const text = el.textContent?.trim();
            if (text && text.length < 50) obj.text = text;
          }
        }

        const childrenNodes = (node as Element).shadowRoot ? Array.from((node as Element).shadowRoot!.children) : Array.from(node.children || []);
        const children = childrenNodes
          .map(cleanNode)
          .filter(Boolean);

        if (children.length > 0) obj.children = children;

        return Object.keys(obj).length > 3 ? obj : null;
      }
      return cleanNode(document.body);
    });

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
