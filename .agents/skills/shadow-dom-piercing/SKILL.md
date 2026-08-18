---
name: shadow-dom-piercing
description: Standardized methods for agents to traverse deeply nested Shadow DOMs and Web Components when locating elements.
---

# Shadow DOM Piercing Skill

Modern target sites often encapsulate forms, credential inputs, and submit buttons inside isolated Web Components and shadow roots to break standard automation scripts.

## The Problem
Playwright's standard `page.locator()` and `page.waitForSelector()` will fail if an element is inside an isolated `#shadow-root (open)` or `#shadow-root (closed)`.

## The Solution: Deep TreeWalking

Whenever an expected element (e.g., a login form, a CAPTCHA iframe, or a "Remember Me" checkbox) is missing from the main document body, the agent MUST employ a `TreeWalker` evaluation to recursively pierce shadow roots.

### Standard Implementation Pattern

Do not use simple `querySelector`. Instead, execute this pattern via `page.evaluateHandle` or `page.evaluate`:

```javascript
function findElementDeep(root, selector) {
    if (root.matches && root.matches(selector)) return root;
    
    // Check local children first
    const localMatch = root.querySelector ? root.querySelector(selector) : null;
    if (localMatch) return localMatch;
    
    // Pierce shadow root if present
    if (root.shadowRoot) {
        const shadowMatch = findElementDeep(root.shadowRoot, selector);
        if (shadowMatch) return shadowMatch;
    }
    
    // Walk through all children
    const children = root.children || (root.childNodes ? Array.from(root.childNodes).filter(n => n.nodeType === 1) : []);
    for (let child of children) {
        const match = findElementDeep(child, selector);
        if (match) return match;
    }
    
    return null;
}
```

### Usage Rules
1. **Never assume elements are in the light DOM.** Always write resilient locators that fall back to shadow-piercing traversal.
2. **Handle Closed Shadow DOMs**: If a target site uses `mode: 'closed'`, you cannot pierce it natively via `.shadowRoot`. You must intercept the `attachShadow` prototype during the early `addInitScript` hook to capture a reference to closed shadow roots.
3. **Use Playwright's Native Piercer**: Where possible, use Playwright's engine syntax `css=pierce/your-selector`, which automatically attempts to pierce open shadow boundaries. Use the custom TreeWalker only when native Playwright piercing fails or when writing pure JS browser-context evaluations.
