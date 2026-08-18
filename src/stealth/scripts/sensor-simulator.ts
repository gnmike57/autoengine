/**
 * Sensor Simulator Scripts
 *
 * Enhanced sensor spoofing that extends the existing DeviceMotion/Orientation
 * scripts with configurable parameters matching the spec requirements:
 *   - Accelerometer: ±0.3g drift around Earth gravity (9.81 m/s²)
 *   - Gyroscope: ±0.8°/s low-frequency noise (device on desk)
 *   - Battery: level 0.78–0.82, charging: false (spec-constrained range)
 *   - ComputedStyle: intercepts getComputedStyle for uniform rendering
 *
 * All scripts are IIFE-wrapped, document_start safe.
 */

// ── Enhanced Accelerometer Script ───────────────────────────────────────────

/**
 * Enhanced accelerometer spoofing with spec-mandated drift parameters.
 *
 * Extends the existing getDeviceMotionSpoofScript with:
 *   - Configurable accelerometer stddev (default ±0.3g)
 *   - Configurable gyroscope stddev (default ±0.8°/s)
 *   - Persistent Perlin-like low-frequency drift (not just random noise)
 *   - Smooth transitions between readings (box-muller + exponential decay)
 *
 * @param seed - Deterministic seed for base offsets
 * @param accelStddev - Accelerometer noise standard deviation (default 0.3)
 * @param gyroStddev - Gyroscope noise standard deviation (default 0.8)
 */
export function getEnhancedAccelerometerScript(
  seed: number,
  accelStddev = 0.3,
  gyroStddev = 0.8,
): string {
  // Deterministic base offsets from seed
  const baseAccelX = ((seed % 100) - 50) / 500;   // ±0.1 m/s² base
  const baseAccelY = ((seed % 73) - 36) / 400;
  const baseGyroZ = ((seed % 61) - 30) / 200;     // ±0.15 °/s base

  return `
(function() {
  try {
    var baseAX = ${baseAccelX.toFixed(6)};
    var baseAY = ${baseAccelY.toFixed(6)};
    var baseGZ = ${baseGyroZ.toFixed(6)};
    var accelStd = ${accelStddev};
    var gyroStd = ${gyroStddev};
    var frameCount = 0;
    var maxActiveFrames = 600;  // ~10s at 60Hz
    var activeInterval = 16;    // ~60Hz
    var idleInterval = 1000;    // 1Hz after settle

    // Low-frequency drift state (Perlin-like)
    var driftAX = 0, driftAY = 0, driftGZ = 0;
    var driftDecay = 0.95; // exponential decay toward zero

    function gaussNoise(stddev) {
      var u1 = Math.random(), u2 = Math.random();
      return stddev * Math.sqrt(-2 * Math.log(u1 || 0.001)) * Math.cos(2 * Math.PI * u2);
    }

    var idleScheduled = false;

    function fireMotion() {
      frameCount++;

      // Update low-frequency drift (smooth random walk)
      driftAX = driftAX * driftDecay + gaussNoise(0.02);
      driftAY = driftAY * driftDecay + gaussNoise(0.02);
      driftGZ = driftGZ * driftDecay + gaussNoise(0.05);

      var accel = {
        x: baseAX + driftAX + gaussNoise(accelStd * 0.5),
        y: baseAY + driftAY + gaussNoise(accelStd * 0.5),
        z: 9.81 + gaussNoise(accelStd)
      };
      var accelGravity = {
        x: accel.x + gaussNoise(0.02),
        y: accel.y + gaussNoise(0.02),
        z: accel.z
      };
      var rotation = {
        alpha: gaussNoise(gyroStd * 0.5),
        beta: gaussNoise(gyroStd),
        gamma: baseGZ + driftGZ + gaussNoise(gyroStd * 0.6)
      };

      try {
        var evt = new DeviceMotionEvent('devicemotion', {
          acceleration: accel,
          accelerationIncludingGravity: accelGravity,
          rotationRate: rotation,
          interval: activeInterval
        });
        window.dispatchEvent(evt);
      } catch(e) {
        var fallback = new Event('devicemotion');
        fallback.acceleration = accel;
        fallback.accelerationIncludingGravity = accelGravity;
        fallback.rotationRate = rotation;
        fallback.interval = activeInterval;
        window.dispatchEvent(fallback);
      }

      if (frameCount < maxActiveFrames) {
        setTimeout(fireMotion, activeInterval + Math.floor(Math.random() * 4));
      } else if (!idleScheduled) {
        // CRITICAL: only schedule the idle interval ONCE
        idleScheduled = true;
        setInterval(fireMotion, idleInterval);
      }
    }

    // Start after brief settle
    setTimeout(fireMotion, 100 + Math.floor(Math.random() * 200));

    // DeviceOrientation companion events
    var orientAlpha = (${seed} % 360);
    var orientBeta = -2 + (${seed} % 5);
    var orientGamma = -1 + (${seed} % 3);

    function fireOrientation() {
      try {
        var evt = new DeviceOrientationEvent('deviceorientation', {
          alpha: orientAlpha + gaussNoise(0.3),
          beta: orientBeta + gaussNoise(0.5),
          gamma: orientGamma + gaussNoise(0.3),
          absolute: false
        });
        window.dispatchEvent(evt);
      } catch(e) {
        var fb = new Event('deviceorientation');
        fb.alpha = orientAlpha + gaussNoise(0.3);
        fb.beta = orientBeta + gaussNoise(0.5);
        fb.gamma = orientGamma + gaussNoise(0.3);
        fb.absolute = false;
        window.dispatchEvent(fb);
      }
    }

    setInterval(fireOrientation, 200 + Math.floor(Math.random() * 100));
  } catch { /* intentional */ }
})();
  `.trim();
}

// ── Enhanced Battery Script ─────────────────────────────────────────────────

/**
 * Constrained battery emulation with spec-mandated range:
 *   - level: 0.78 → 0.82 (narrow band, simulating steady-state laptop)
 *   - charging: false (default — cord unplugged)
 *   - Slow micro-drift every 60 seconds
 *
 * @param seed - Deterministic seed for initial state
 */
export function getEnhancedBatteryScript(seed: number): string {
  // Constrained range: 0.78–0.82
  const initialLevel = 0.78 + ((seed % 5) / 100);  // 0.78, 0.79, 0.80, 0.81, 0.82

  return `
(function() {
  try {
    var level = ${initialLevel.toFixed(2)};
    var charging = false;
    var listeners = { chargingchange: [], levelchange: [], chargingtimechange: [], dischargingtimechange: [] };

    var batteryData = {
      get charging() { return charging; },
      get level() { return level; },
      get chargingTime() { return charging ? Math.floor((1 - level) * 3600) : Infinity; },
      get dischargingTime() { return charging ? Infinity : Math.floor(level * 14400); },
      addEventListener: function(type, fn) {
        if (listeners[type]) listeners[type].push(fn);
      },
      removeEventListener: function(type, fn) {
        if (listeners[type]) listeners[type] = listeners[type].filter(function(f) { return f !== fn; });
      },
      dispatchEvent: function() { return true; },
      onchargingchange: null,
      onchargingtimechange: null,
      ondischargingtimechange: null,
      onlevelchange: null
    };

    if (navigator.getBattery) {
      Object.defineProperty(navigator, 'getBattery', {
        value: function() { return Promise.resolve(batteryData); },
        configurable: true, writable: true
      });
      navigator.getBattery.toString = function() { return "function getBattery() { [native code] }"; };
    }

    // Micro-drift within constrained range every 60s
    setInterval(function() {
      var delta = (Math.random() - 0.5) * 0.004; // ±0.002 per minute
      level = Math.max(0.78, Math.min(0.82, level + delta));
      if (batteryData.onlevelchange) batteryData.onlevelchange();
      listeners.levelchange.forEach(function(fn) { try { fn(); } catch { /* intentional */ } });
    }, 60000);
  } catch { /* intentional */ }
})();
  `.trim();
}

// ── ComputedStyle Intercept Script ──────────────────────────────────────────

/**
 * Intercepts getComputedStyle to normalize rendering differences that
 * fingerprinters use to detect automation environments.
 *
 * Automation browsers often have different default font rendering,
 * missing system fonts, or non-standard CSS computed values.
 * This script ensures getComputedStyle returns values consistent with
 * a standard Chrome installation.
 *
 * @param chromeVersion - Chrome major version for CSS property support checks
 */
export function getComputedStyleInterceptScript(chromeVersion = 130): string {
  return `
(function() {
  try {
    var origGetCS = window.getComputedStyle;

    // Properties that leak automation environment differences
    var normalizations = {
      'font-family': null,  // Don't normalize fonts (too risky)
      'appearance': 'none',
      '-webkit-appearance': 'none'
    };

    window.getComputedStyle = function(element, pseudoElt) {
      var result = origGetCS.call(window, element, pseudoElt);

      // Wrap getPropertyValue to normalize specific properties
      var origGetPV = result.getPropertyValue.bind(result);

      // Create a proxy-like wrapper
      var wrapped = Object.create(result);
      wrapped.getPropertyValue = function(prop) {
        // Normalize -webkit-text-size-adjust (headless Chrome returns 'auto')
        if (prop === '-webkit-text-size-adjust') return '100%';
        return origGetPV(prop);
      };
      wrapped.getPropertyValue.toString = function() {
        return "function getPropertyValue() { [native code] }";
      };

      return wrapped;
    };

    window.getComputedStyle.toString = function() {
      return "function getComputedStyle() { [native code] }";
    };

    // Also extend CSS.supports to align with Chrome ${chromeVersion}
    if (CSS && CSS.supports) {
      var origSupports = CSS.supports;
      var supportedFeatures = {
        'color-mix': true,
        'container-type': true,
        '@container': true,
        'accent-color': true,
        'aspect-ratio': true,
        'backdrop-filter': true,
        'content-visibility': true,
        'font-palette': true,
        'mix-blend-mode': true,
        'text-decoration-thickness': true,
        'view-transitions': ${chromeVersion >= 125},
        'anchor-positioning': ${chromeVersion >= 125},
        'popover': ${chromeVersion >= 114}
      };

      CSS.supports = function() {
        var conditionText = arguments[0];
        if (arguments.length === 1) {
          var match = conditionText.match(/\\(([\\w-]+)\\s*:/);
          if (match && supportedFeatures[match[1]]) return true;
          if (conditionText.indexOf('@container') !== -1) return true;
        } else if (arguments.length === 2) {
          if (supportedFeatures[arguments[0]]) return true;
        }
        return origSupports.apply(this, arguments);
      };
      CSS.supports.toString = function() { return "function supports() { [native code] }"; };
    }
  } catch { /* intentional */ }
})();
  `.trim();
}
