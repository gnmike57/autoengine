/**
 * STEALTH SCRIPTS — MOBILE DEVICE SPOOFS
 * Layer 10: Mobile Device Fingerprint Coherence.
 * Only activated when emulateMobile = true. Zero impact on desktop profiles.
 * Extracted from stealth-scripts.ts per Phase 4 restructuring.
 */

import crypto from "node:crypto";

/**
 * Mobile #1: navigator.platform override.
 * Desktop Chrome reports "Win32" even when UA says Android.
 * This is the #1 mobile emulation detection signal.
 */
export function getMobilePlatformOverrideScript(): string {
  return `
(function() {
  try {
    Object.defineProperty(navigator, 'platform', {
      get: function() { return 'Linux armv8l'; },
      configurable: true
    });
    if (navigator.oscpu) {
      Object.defineProperty(navigator, 'oscpu', {
        get: function() { return 'Linux armv8l'; },
        configurable: true
      });
    }
  } catch { /* intentional */ }
})();
  `.trim();
}

/**
 * Mobile #2: maxTouchPoints = 5.
 * Real Android phones report 5-10 touch points. Desktop = 0 or 1.
 */
export function getMobileTouchPointsScript(): string {
  return `
(function() {
  try {
    Object.defineProperty(navigator, 'maxTouchPoints', {
      get: function() { return 5; },
      configurable: true
    });
  } catch { /* intentional */ }
})();
  `.trim();
}

/**
 * Desktop Coherence: maxTouchPoints = 0.
 * Touchscreen laptops report maxTouchPoints=10 which creates coherence
 * failure when the UA is desktop. This override ensures consistency.
 */
export function getDesktopTouchPointsScript(): string {
  return `
(function() {
  try {
    Object.defineProperty(navigator, 'maxTouchPoints', {
      get: function() { return 0; },
      configurable: true
    });
  } catch { /* intentional */ }
})();
  `.trim();
}

/**
 * Mobile #3: ontouchstart event support.
 */
export function getMobileOntouchstartScript(): string {
  return `
(function() {
  try {
    if (!('ontouchstart' in window)) { window.ontouchstart = null; }
    if (!('ontouchend' in window)) { window.ontouchend = null; }
    if (!('ontouchmove' in window)) { window.ontouchmove = null; }
    if (!('ontouchcancel' in window)) { window.ontouchcancel = null; }
  } catch { /* intentional */ }
})();
  `.trim();
}

/**
 * Mobile #4: screen.orientation.type = portrait-primary.
 */
export function getMobileOrientationScript(): string {
  return `
(function() {
  try {
    if (screen.orientation) {
      Object.defineProperty(screen.orientation, 'type', {
        get: function() { return 'portrait-primary'; },
        configurable: true
      });
      Object.defineProperty(screen.orientation, 'angle', {
        get: function() { return 0; },
        configurable: true
      });
    }
    Object.defineProperty(window, 'orientation', {
      get: function() { return 0; },
      configurable: true
    });
  } catch { /* intentional */ }
})();
  `.trim();
}

/**
 * Mobile #5: navigator.connection mobile profile.
 */
export function getMobileConnectionScript(seed: number): string {
  const rtt = 30 + (seed % 40);
  const downlink = 5 + (seed % 20);
  return `
(function() {
  try {
    var mobileConn = {
      type: 'cellular',
      effectiveType: '4g',
      rtt: ${rtt},
      downlink: ${downlink},
      saveData: false,
      onchange: null,
      addEventListener: function() {},
      removeEventListener: function() {},
      dispatchEvent: function() { return true; }
    };
    if (navigator.connection) {
      for (var k in mobileConn) {
        try {
          Object.defineProperty(navigator.connection, k, {
            get: (function(v) { return function() { return v; }; })(mobileConn[k]),
            configurable: true
          });
        } catch { /* intentional */ }
      }
    } else {
      Object.defineProperty(navigator, 'connection', {
        get: function() { return mobileConn; },
        configurable: true
      });
    }
  } catch { /* intentional */ }
})();
  `.trim();
}

/**
 * Mobile #6: Mobile WebGL renderer (Adreno/Mali).
 */
export function getMobileWebGLRendererScript(seed: number): string {
  const gpus = [
    { vendor: "Qualcomm", renderer: "Adreno (TM) 730" },
    { vendor: "Qualcomm", renderer: "Adreno (TM) 660" },
    { vendor: "Qualcomm", renderer: "Adreno (TM) 640" },
    { vendor: "ARM", renderer: "Mali-G78" },
    { vendor: "ARM", renderer: "Mali-G710" },
  ];
  const gpu = gpus[seed % gpus.length]!;
  const vendor = `Qualcomm`;
  const renderer = `ANGLE (${gpu.vendor}, ${gpu.renderer}, OpenGL ES 3.2)`;

  return `
(function() {
  try {
    var canvas = document.createElement('canvas');
    var gl = canvas.getContext('webgl') || canvas.getContext('experimental-webgl');
    if (gl) {
      var ext = gl.getExtension('WEBGL_debug_renderer_info');
      if (ext) {
        var origGetParam = WebGLRenderingContext.prototype.getParameter;
        WebGLRenderingContext.prototype.getParameter = function(param) {
          if (param === 37445) return '${vendor}';
          if (param === 37446) return '${renderer}';
          return origGetParam.call(this, param);
        };
        if (typeof WebGL2RenderingContext !== 'undefined') {
          var origGetParam2 = WebGL2RenderingContext.prototype.getParameter;
          WebGL2RenderingContext.prototype.getParameter = function(param) {
            if (param === 37445) return '${vendor}';
            if (param === 37446) return '${renderer}';
            return origGetParam2.call(this, param);
          };
        }
      }
    }
  } catch { /* intentional */ }
})();
  `.trim();
}

/**
 * Mobile #7: navigator.vibrate() API.
 */
export function getMobileVibrateScript(): string {
  return `
(function() {
  try {
    Object.defineProperty(navigator, 'vibrate', {
      value: function(pattern) { return true; },
      configurable: true, writable: true
    });
    navigator.vibrate.toString = function() { return "function vibrate() { [native code] }"; };
  } catch { /* intentional */ }
})();
  `.trim();
}

/**
 * Mobile #8: Mobile screen dimensions + high DPR.
 */
export function getMobileScreenDimensionsScript(seed: number): string {
  const screens = [
    { w: 360, h: 800, dpr: 3 },
    { w: 393, h: 873, dpr: 2.75 },
    { w: 390, h: 844, dpr: 3 },
    { w: 412, h: 915, dpr: 2.625 },
    { w: 375, h: 812, dpr: 3 },
  ];
  const scr = screens[seed % screens.length]!;

  return `
(function() {
  try {
    Object.defineProperty(screen, 'width', { get: function() { return ${scr.w}; }, configurable: true });
    Object.defineProperty(screen, 'height', { get: function() { return ${scr.h}; }, configurable: true });
    Object.defineProperty(screen, 'availWidth', { get: function() { return ${scr.w}; }, configurable: true });
    Object.defineProperty(screen, 'availHeight', { get: function() { return ${scr.h}; }, configurable: true });
    Object.defineProperty(screen, 'availTop', { get: function() { return 0; }, configurable: true });
    Object.defineProperty(screen, 'availLeft', { get: function() { return 0; }, configurable: true });
    Object.defineProperty(screen, 'colorDepth', { get: function() { return 24; }, configurable: true });
    Object.defineProperty(screen, 'pixelDepth', { get: function() { return 24; }, configurable: true });
    Object.defineProperty(window, 'devicePixelRatio', {
      get: function() { return ${scr.dpr}; },
      configurable: true
    });
  } catch { /* intentional */ }
})();
  `.trim();
}

/**
 * Mobile #9: Mobile battery behavior (not charging).
 */
export function getMobileBatteryScript(seed: number): string {
  const level = ((seed % 50) + 20) / 100;
  const charging = (seed % 8) === 0;
  const dischargingTime = charging ? Infinity : Math.floor(level * 7200);
  const chargingTime = charging ? Math.floor((1 - level) * 5400) : Infinity;

  return `
(function() {
  try {
    var mobileBattery = {
      charging: ${charging},
      chargingTime: ${chargingTime === Infinity ? "Infinity" : chargingTime},
      dischargingTime: ${dischargingTime === Infinity ? "Infinity" : dischargingTime},
      level: ${level.toFixed(2)},
      addEventListener: function() {},
      removeEventListener: function() {},
      dispatchEvent: function() { return true; }
    };
    Object.defineProperty(mobileBattery, 'onchargingchange', { get: function() { return null; }, set: function() {}, configurable: true });
    Object.defineProperty(mobileBattery, 'onchargingtimechange', { get: function() { return null; }, set: function() {}, configurable: true });
    Object.defineProperty(mobileBattery, 'ondischargingtimechange', { get: function() { return null; }, set: function() {}, configurable: true });
    Object.defineProperty(mobileBattery, 'onlevelchange', { get: function() { return null; }, set: function() {}, configurable: true });
    if (navigator.getBattery) {
      Object.defineProperty(navigator, 'getBattery', {
        value: function() { return Promise.resolve(mobileBattery); },
        configurable: true, writable: true
      });
    }
  } catch { /* intentional */ }
})();
  `.trim();
}

/**
 * Mobile #10: PointerEvent.pointerType = "touch".
 */
export function getMobilePointerTypeScript(): string {
  return `
(function() {
  try {
    var OrigPointerEvent = window.PointerEvent;
    if (OrigPointerEvent) {
      window.PointerEvent = function(type, init) {
        var mobileInit = Object.assign({}, init || {});
        if (!mobileInit.pointerType || mobileInit.pointerType === 'mouse') {
          mobileInit.pointerType = 'touch';
        }
        if (mobileInit.pointerId === undefined) mobileInit.pointerId = 1;
        if (mobileInit.width === undefined) mobileInit.width = 23.4;
        if (mobileInit.height === undefined) mobileInit.height = 23.4;
        if (mobileInit.pressure === undefined) mobileInit.pressure = 0.5;
        return new OrigPointerEvent(type, mobileInit);
      };
      window.PointerEvent.prototype = OrigPointerEvent.prototype;
      Object.setPrototypeOf(window.PointerEvent, OrigPointerEvent);
    }
  } catch { /* intentional */ }
})();
  `.trim();
}

/**
 * Derive a deterministic fingerprint seed from an email.
 */
export function emailToSeed(email: string): number {
  const normalized = email.trim().toLowerCase();
  const digest = crypto.createHash("sha256").update(normalized).digest();
  return digest.readUInt32BE(4);
}
