/**
 * reCAPTCHA v3 Score Maximization Scripts
 *
 * Target sites use INVISIBLE reCAPTCHA v3 which scores 0.0–1.0 based on
 * behavioral telemetry. There are NO puzzle CAPTCHAs to solve.
 *
 * This module provides three coordinated layers:
 *   1. grecaptcha.execute hook — delays execution, injects behavioral burst
 *   2. ___grecaptcha_cfg callback override — force-sets g-recaptcha-response
 *   3. Unified behavioral emulation — Bézier mouse + inertia scroll + RAF loop
 *
 * These replace the partially duplicated scripts previously scattered across
 * stealth-scripts.ts (L1963–2103, L2377–2483, L2495–2570).
 */

// ── grecaptcha.execute Hook ─────────────────────────────────────────────────

/**
 * Enhanced grecaptcha.execute interception script.
 *
 * Key behaviors:
 *   - Minimum 3-second delay after page load (instant execute is bot signal)
 *   - Pre-execute behavioral burst: 5+ Bézier mouse movements + scroll
 *   - Force-sets g-recaptcha-response hidden field
 *   - Overrides ___grecaptcha_cfg.fns callback functions
 *   - Optional session-proxy binding for score consistency
 *
 * @param sessionProxy - Optional proxy URL for session binding context
 */
export function getRecaptchaHookScript(sessionProxy?: string): string {
  const proxyContext = sessionProxy ? `"${sessionProxy}"` : "null";
  return `
(function() {
  try {
    var PAGE_LOAD_TIME = Date.now();
    var MIN_DELAY_MS = 3000;
    var PROXY_CONTEXT = ${proxyContext};

    // Track behavioral engagement score internally
    var behavioralScore = 0;
    var lastMouseX = 400 + Math.floor(Math.random() * 200);
    var lastMouseY = 300 + Math.floor(Math.random() * 100);

    // Monitor real user-like engagement
    document.addEventListener('mousemove', function() { behavioralScore += 0.1; }, { passive: true });
    document.addEventListener('click', function() { behavioralScore += 0.5; }, { passive: true });
    document.addEventListener('scroll', function() { behavioralScore += 0.2; }, { passive: true });
    document.addEventListener('keydown', function() { behavioralScore += 0.3; }, { passive: true });

    function injectBehavioralBurst() {
      // Rapid-fire mouse movements along a natural curve
      for (var i = 0; i < 5; i++) {
        var dx = (Math.random() - 0.5) * 40;
        var dy = (Math.random() - 0.5) * 30;
        lastMouseX = Math.max(50, Math.min(1230, lastMouseX + dx));
        lastMouseY = Math.max(50, Math.min(670, lastMouseY + dy));
        document.dispatchEvent(new MouseEvent('mousemove', {
          bubbles: true, clientX: Math.round(lastMouseX), clientY: Math.round(lastMouseY)
        }));
        try {
          document.dispatchEvent(new PointerEvent('pointermove', {
            bubbles: true, clientX: Math.round(lastMouseX), clientY: Math.round(lastMouseY),
            pointerId: 1, pointerType: 'mouse', isPrimary: true
          }));
        } catch { /* intentional */ }
      }
      // Micro-scroll
      window.dispatchEvent(new Event('scroll', { bubbles: true }));
      behavioralScore += 2;
    }

    function forceSetResponseField(token) {
      // Set all known response field variants
      var selectors = [
        '#g-recaptcha-response',
        'textarea[name="g-recaptcha-response"]',
        '.g-recaptcha-response'
      ];
      selectors.forEach(function(sel) {
        var els = document.querySelectorAll(sel);
        els.forEach(function(el) {
          if (el) {
            el.value = token;
            el.textContent = token;
            el.innerHTML = token;
          }
        });
      });
    }

    function overrideCfgCallbacks(token) {
      try {
        if (window.___grecaptcha_cfg) {
          // Override fns array callbacks
          if (window.___grecaptcha_cfg.fns) {
            Object.keys(window.___grecaptcha_cfg.fns).forEach(function(key) {
              try { window.___grecaptcha_cfg.fns[key](token); } catch { /* intentional */ }
            });
          }
          // Override clients callbacks (newer reCAPTCHA structure)
          if (window.___grecaptcha_cfg.clients) {
            Object.keys(window.___grecaptcha_cfg.clients).forEach(function(clientKey) {
              var client = window.___grecaptcha_cfg.clients[clientKey];
              if (client) {
                // Walk the client object looking for callback functions
                function walkCallbacks(obj, depth) {
                  if (depth > 5 || !obj) return;
                  Object.keys(obj).forEach(function(k) {
                    if (typeof obj[k] === 'function') {
                      try { obj[k](token); } catch { /* intentional */ }
                    } else if (typeof obj[k] === 'object' && obj[k] !== null) {
                      walkCallbacks(obj[k], depth + 1);
                    }
                  });
                }
                walkCallbacks(client, 0);
              }
            });
          }
        }
      } catch { /* intentional */ }
    }

    function patchGrecaptcha() {
      if (typeof grecaptcha === 'undefined' || !grecaptcha.execute) return;
      if (grecaptcha.__v3_patched) return;

      var origExecute = grecaptcha.execute;
      grecaptcha.execute = function(siteKey, opts) {
        var action = (opts && opts.action) || 'submit';
        var elapsed = Date.now() - PAGE_LOAD_TIME;

        // Always inject behavioral burst before execute
        injectBehavioralBurst();

        if (elapsed < MIN_DELAY_MS) {
          return new Promise(function(resolve, reject) {
            setTimeout(function() {
              origExecute.call(grecaptcha, siteKey, opts)
                .then(function(token) {
                  forceSetResponseField(token);
                  overrideCfgCallbacks(token);
                  resolve(token);
                })
                .catch(reject);
            }, MIN_DELAY_MS - elapsed);
          });
        }

        return origExecute.call(grecaptcha, siteKey, opts)
          .then(function(token) {
            forceSetResponseField(token);
            overrideCfgCallbacks(token);
            return token;
          });
      };
      grecaptcha.__v3_patched = true;
    }

    // Retry patching at intervals (reCAPTCHA loads asynchronously)
    patchGrecaptcha();
    setTimeout(patchGrecaptcha, 500);
    setTimeout(patchGrecaptcha, 1500);
    setTimeout(patchGrecaptcha, 3000);
    setTimeout(patchGrecaptcha, 5000);
    setTimeout(patchGrecaptcha, 10000);
  } catch { /* intentional */ }
})();
  `.trim();
}

// ── Unified Behavioral Emulation Script ─────────────────────────────────────

/**
 * Unified behavioral emulation layer that coordinates:
 *   1. RAF-driven continuous micro-events (mouse drift, pointer, scroll)
 *   2. Bézier curve mouse trajectory function (window.__bezierMouseMove)
 *   3. Natural scroll with inertia decay (window.__naturalScroll)
 *   4. Focus/visibility state management
 *   5. Touch event emulation for mobile profiles
 *
 * This replaces the previously separate:
 *   - getRecaptchaV3ScoreBoostScript (L1963)
 *   - getBezierMouseTrajectoryScript (L2377)
 *   - getScrollEmulationScript (L2437)
 *
 * @param isMobile - Whether to emit touch events instead of mouse events
 */
export function getUnifiedBehavioralScript(isMobile: boolean): string {
  return `
(function() {
  try {
    // ── 1. Immediate focus/visibility signals ──
    window.dispatchEvent(new Event('focus', { bubbles: false }));
    document.dispatchEvent(new Event('focus', { bubbles: false }));

    if (document.hasFocus && !document.hasFocus()) {
      Object.defineProperty(document, 'hasFocus', {
        value: function() { return true; },
        configurable: true, writable: true
      });
    }
    Object.defineProperty(document, 'visibilityState', {
      get: function() { return 'visible'; },
      configurable: true
    });
    Object.defineProperty(document, 'hidden', {
      get: function() { return false; },
      configurable: true
    });

    // ── 2. RAF-driven continuous micro-events ──
    var lastMouseX = 400 + Math.floor(Math.random() * 200);
    var lastMouseY = 300 + Math.floor(Math.random() * 100);
    var frameCount = 0;
    var maxDurationMs = 60000;
    var startTime = Date.now();

    function rafLoop(timestamp) {
      if (Date.now() - startTime > maxDurationMs) return;
      frameCount++;

      var eventInterval = 8 + Math.floor(Math.random() * 7);
      if (frameCount % eventInterval === 0) {
        var eventType = Math.random();

        if (eventType < 0.45) {
          lastMouseX += (Math.random() - 0.5) * 6;
          lastMouseY += (Math.random() - 0.5) * 4;
          lastMouseX = Math.max(50, Math.min(1230, lastMouseX));
          lastMouseY = Math.max(50, Math.min(670, lastMouseY));
          if (${isMobile}) {
            try {
              var touch = new Touch({
                identifier: Date.now(),
                target: document.body,
                clientX: Math.round(lastMouseX),
                clientY: Math.round(lastMouseY),
                radiusX: 2.5, radiusY: 2.5, rotationAngle: 10, force: 0.5,
              });
              document.dispatchEvent(new TouchEvent('touchmove', {
                bubbles: true, cancelable: true,
                touches: [touch], targetTouches: [touch], changedTouches: [touch]
              }));
            } catch { /* intentional */ }
          } else {
            document.dispatchEvent(new MouseEvent('mousemove', {
              bubbles: true, clientX: Math.round(lastMouseX), clientY: Math.round(lastMouseY)
            }));
          }
        } else if (eventType < 0.65) {
          try {
            document.dispatchEvent(new PointerEvent('pointermove', {
              bubbles: true, clientX: Math.round(lastMouseX), clientY: Math.round(lastMouseY),
              pointerId: 1, pointerType: 'mouse', isPrimary: true
            }));
          } catch { /* intentional */ }
        } else if (eventType < 0.75) {
          window.dispatchEvent(new Event('focus', { bubbles: false }));
        } else if (eventType < 0.85) {
          window.dispatchEvent(new Event('scroll', { bubbles: true }));
        }
      }
      requestAnimationFrame(rafLoop);
    }

    setTimeout(function() { requestAnimationFrame(rafLoop); }, 250 + Math.floor(Math.random() * 250));

    // Initial mouseenter burst
    setTimeout(function() {
      document.dispatchEvent(new MouseEvent('mouseenter', {
        bubbles: true, clientX: lastMouseX, clientY: lastMouseY
      }));
    }, 200 + Math.floor(Math.random() * 200));

    // ── 3. Bézier curve mouse trajectory ──
    window.__bezierMouseMove = function(fromX, fromY, toX, toY, durationMs, callback) {
      durationMs = durationMs || 400 + Math.floor(Math.random() * 300);
      var cpRange = Math.max(Math.abs(toX - fromX), Math.abs(toY - fromY)) * 0.4;
      var cp1x = fromX + (toX - fromX) * 0.25 + (Math.random() - 0.5) * cpRange;
      var cp1y = fromY + (toY - fromY) * 0.25 + (Math.random() - 0.5) * cpRange;
      var cp2x = fromX + (toX - fromX) * 0.75 + (Math.random() - 0.5) * cpRange;
      var cp2y = fromY + (toY - fromY) * 0.75 + (Math.random() - 0.5) * cpRange;
      var steps = Math.max(10, Math.floor(durationMs / 16));
      var step = 0;

      function bezier(t, p0, p1, p2, p3) {
        var u = 1 - t;
        return u*u*u*p0 + 3*u*u*t*p1 + 3*u*t*t*p2 + t*t*t*p3;
      }

      function tick() {
        step++;
        var t = Math.min(step / steps, 1);
        var eased = t < 0.5 ? 2*t*t : -1 + (4 - 2*t)*t;
        var x = Math.round(bezier(eased, fromX, cp1x, cp2x, toX));
        var y = Math.round(bezier(eased, fromY, cp1y, cp2y, toY));

        document.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: x, clientY: y }));
        try {
          document.dispatchEvent(new PointerEvent('pointermove', {
            bubbles: true, clientX: x, clientY: y,
            pointerId: 1, pointerType: 'mouse', isPrimary: true
          }));
        } catch { /* intentional */ }

        if (step < steps) {
          var delay = (durationMs / steps) + (Math.random() - 0.5) * 4;
          setTimeout(tick, Math.max(1, delay));
        } else if (callback) {
          callback();
        }
      }
      tick();
    };

    // ── 4. Natural scroll with inertia ──
    window.__naturalScroll = function(targetY, durationMs) {
      durationMs = durationMs || 600 + Math.floor(Math.random() * 400);
      var startY = window.scrollY || window.pageYOffset || 0;
      var distance = targetY - startY;
      var scrollStartTime = performance.now();

      function easeOutQuart(t) { return 1 - Math.pow(1 - t, 4); }

      function scrollStep(now) {
        var elapsed = now - scrollStartTime;
        var t = Math.min(elapsed / durationMs, 1);
        var currentY = startY + distance * easeOutQuart(t);
        window.scrollTo(0, Math.round(currentY));
        window.dispatchEvent(new Event('scroll', { bubbles: true }));
        if (t < 1) requestAnimationFrame(scrollStep);
      }
      requestAnimationFrame(scrollStep);
    };

    // Auto-trigger idle scroll after page load
    setTimeout(function() {
      var maxScroll = Math.max(0, document.body.scrollHeight - window.innerHeight);
      if (maxScroll > 100) {
        var scrollTarget = 50 + Math.floor(Math.random() * Math.min(200, maxScroll));
        window.__naturalScroll(scrollTarget, 800 + Math.floor(Math.random() * 400));
      }
    }, 2000 + Math.floor(Math.random() * 3000));

  } catch { /* intentional */ }
})();
  `.trim();
}
