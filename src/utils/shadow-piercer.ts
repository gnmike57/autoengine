import type { Page } from "playwright";

/**
 * Executes a deep, recursive TreeWalker inside the browser context that pierces open
 * shadow roots to extract all text content from the DOM. This ensures that dynamic
 * error messages, success banners, or WAF responses rendered inside Web Components 
 * are successfully extracted and classified by the engine.
 * 
 * @param page The Playwright Page instance
 * @returns The lowercase, consolidated text content of the entire page
 */
export async function extractDeepText(page: Page): Promise<string> {
  return await page.evaluate(() => {
    function getDeepText(root: Node): string {
      let text = "";
      
      // If it's a Text node, grab its content
      if (root.nodeType === Node.TEXT_NODE) {
        return (root.textContent || "").trim();
      }

      // If it's an element, skip scripts and styles
      if (root.nodeType === Node.ELEMENT_NODE) {
        const el = root as Element;
        const tag = el.tagName.toLowerCase();
        if (tag === "script" || tag === "style" || tag === "noscript") {
          return "";
        }
        
        // Pierce open shadow roots
        if (el.shadowRoot) {
          text += " " + getDeepText(el.shadowRoot);
        }
      }

      // Traverse children recursively
      const childNodes = root.childNodes || [];
      for (let i = 0; i < childNodes.length; i++) {
        text += " " + getDeepText(childNodes[i]!);
      }

      return text;
    }

    try {
      const allText = getDeepText(document.body || document.documentElement);
      // Clean up excess whitespace and return lowercase for consistent classification
      return allText.replace(/\s+/g, " ").trim().toLowerCase();
    } catch (err) {
      // Fallback in case of severe DOM corruption
      return (document.body?.textContent || "").toLowerCase();
    }
  });
}
