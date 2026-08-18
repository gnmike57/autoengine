/**
 * Playwright/CloakBrowser sets `navigator.webdriver = true` by default.
 * This is the #1 detection signal for every anti-bot service. We override
 * it to false and ensure the property descriptor matches a real browser's
 * native implementation (configurable, non-enumerable).
 *
 * Also patches `navigator.permissions.query` to return realistic results
 * for the Permissions API, which fingerprinters use as a secondary signal.
 */
export const WEBDRIVER_OVERRIDE_SCRIPT = `
(function() {
  try {
    // Override navigator.webdriver — THE #1 bot detection signal
    // It is critical to override Navigator.prototype, not the navigator instance
    // Completely delete the webdriver property from the prototype
    delete Navigator.prototype.webdriver;
    // If origDesc doesn't exist at all, the engine is properly patched (or it's Firefox).
    // We do NOT inject it manually, as defining it leaves a tampering trace.

    // Make CredentialContainer.get appear functional (real browsers have this)
    if (navigator.credentials) {
      var credProto = Object.getPrototypeOf(navigator.credentials) || CredentialContainer.prototype;
      if (credProto && credProto.get) {
        credProto.get = new Proxy(credProto.get, {
          apply: function(target, thisArg, args) {
            var opts = args[0];
            if (opts && opts.password) return Promise.resolve(null);
            return Reflect.apply(target, thisArg, args);
          }
        });
      }
    }
  } catch { /* intentional */ }
})();
`.trim();
/**
 * Simulate Chrome's native password manager autofill behavior.
 * When Chrome autofills a login form, it:
 *   1. Fires an 'animationstart' event (for the :-webkit-autofill animation)
 *   2. Sets `InputEvent.inputType` to `"insertReplacementText"`
 *   3. Applies a characteristic background color (rgb(232, 240, 254))
 *   4. Creates entries in `PasswordCredential` / `CredentialManager`
 *
 * Fingerprinters detect the ABSENCE of these signals. This script adds
 * a global helper that the engine can invoke after filling a field to
 * make it look like Chrome's autofill populated it.
 */
export const AUTOFILL_SIMULATION_SCRIPT = `
(function() {
  try {
    // Expose a helper the engine can call after filling a field
    // Usage: window.__simulateAutofill(inputElement)
    window.__simulateAutofill = function(el) {
      if (!el || !(el instanceof HTMLInputElement)) return;

      try {
        // 1. Fire animationstart (Chrome fires this for :-webkit-autofill CSS animation)
        el.dispatchEvent(new AnimationEvent('animationstart', {
          animationName: 'onautofillstart',
          bubbles: true,
          cancelable: false,
        }));

        // 2. Apply autofill background styling (Chrome's characteristic yellow)
        el.style.setProperty('background-color', 'rgb(232, 240, 254)', 'important');
        el.style.setProperty('background-image', 'none', 'important');
        el.style.setProperty('color', 'rgb(0, 0, 0)', '');

        // 3. Inject :-webkit-autofill styling via a <style> tag if not already present
        if (!document.querySelector('#__autofill_style_shim')) {
          var style = document.createElement('style');
          style.id = '__autofill_style_shim';
          style.textContent = 'input:-webkit-autofill { background-color: rgb(232, 240, 254) !important; -webkit-text-fill-color: #000 !important; }';
          document.head.appendChild(style);
        }

        // 4. Mark the element with a data attribute fingerprinters sometimes check
        el.setAttribute('data-is-autofilled', 'true');

        // 5. Dispatch an InputEvent with the autofill-specific inputType
        try {
          el.dispatchEvent(new InputEvent('input', {
            bubbles: true,
            cancelable: false,
            inputType: 'insertReplacementText',
            data: el.value,
          }));
        } catch (e2) {
          // InputEvent constructor may not support inputType in all envs
          el.dispatchEvent(new Event('input', { bubbles: true }));
        }

        el.dispatchEvent(new Event('change', { bubbles: true }));
      } catch { /* intentional */ }
    };


  } catch { /* intentional */ }
})();
`.trim();

export function getWebdriverOverrideScript(): string {
    return WEBDRIVER_OVERRIDE_SCRIPT;
}

export function getAutofillSimulationScript(): string {
    return AUTOFILL_SIMULATION_SCRIPT;
}
