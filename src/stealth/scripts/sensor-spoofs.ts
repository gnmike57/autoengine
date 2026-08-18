/**
 * Sensor and Battery dynamic spoofing scripts
 * Extracted from stealth-scripts.ts
 */

export function getDeviceMotionSpoofScript(seed: number): string {
  // Deterministic base offsets from seed
  const baseAccelX = ((seed % 100) - 50) / 500;   // ±0.1 m/s²
  const baseAccelY = ((seed % 73) - 36) / 400;
  const baseGyroZ = ((seed % 61) - 30) / 200;     // ±0.15 °/s

  return `
(function() {
  try {
    var baseAX = ${baseAccelX.toFixed(4)};
    var baseAY = ${baseAccelY.toFixed(4)};
    var baseGZ = ${baseGyroZ.toFixed(4)};
    var frameCount = 0;
    var maxActiveFrames = 600;  // ~10s at 60Hz
    var activeInterval = 16;    // ~60Hz
    var idleInterval = 1000;    // 1Hz after settle

    function gaussNoise(stddev) {
      var u1 = Math.random(), u2 = Math.random();
      return stddev * Math.sqrt(-2 * Math.log(u1 || 0.001)) * Math.cos(2 * Math.PI * u2);
    }

    function fireMotion() {
      frameCount++;
      var accel = {
        x: baseAX + gaussNoise(0.15),
        y: baseAY + gaussNoise(0.15),
        z: 9.81 + gaussNoise(0.3)
      };
      var accelGravity = {
        x: accel.x + gaussNoise(0.02),
        y: accel.y + gaussNoise(0.02),
        z: accel.z
      };
      var rotation = {
        alpha: gaussNoise(0.4),
        beta: gaussNoise(0.8),
        gamma: baseGZ + gaussNoise(0.5)
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
        // Fallback for browsers that don't support DeviceMotionEvent constructor
        var fallback = new Event('devicemotion');
        fallback.acceleration = accel;
        fallback.accelerationIncludingGravity = accelGravity;
        fallback.rotationRate = rotation;
        fallback.interval = activeInterval;
        window.dispatchEvent(fallback);
      }

      if (frameCount < maxActiveFrames) {
        setTimeout(fireMotion, activeInterval + Math.floor(Math.random() * 4));
      } else {
        // Switch to idle 1Hz
        setInterval(fireMotion, idleInterval);
      }
    }

    // Start after a brief settle
    setTimeout(fireMotion, 100 + Math.floor(Math.random() * 200));

    // Also patch DeviceOrientationEvent for compass/tilt
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
        var fallback = new Event('deviceorientation');
        fallback.alpha = orientAlpha + gaussNoise(0.3);
        fallback.beta = orientBeta + gaussNoise(0.5);
        fallback.gamma = orientGamma + gaussNoise(0.3);
        fallback.absolute = false;
        window.dispatchEvent(fallback);
      }
    }

    setInterval(fireOrientation, 200 + Math.floor(Math.random() * 100));
  } catch { /* intentional */ }
})();
  `.trim();
}

export function getDynamicBatterySpoofScript(seed: number): string {
  const initialLevel = ((seed % 60) + 30) / 100; // 0.30 – 0.89
  const isCharging = (seed % 3) !== 0;

  return `
(function() {
  try {
    var level = ${initialLevel.toFixed(2)};
    var charging = ${isCharging};
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
    }

    // Simulate drain/charge over time
    setInterval(function() {
      var delta = charging ? 0.01 : -0.005;
      level = Math.max(0.05, Math.min(0.99, level + delta + (Math.random() - 0.5) * 0.005));
      // Randomly toggle charging state (~5% chance per minute)
      if (Math.random() < 0.05) {
        charging = !charging;
        if (batteryData.onchargingchange) batteryData.onchargingchange();
        listeners.chargingchange.forEach(function(fn) { try { fn(); } catch { /* intentional */ } });
      }
      if (batteryData.onlevelchange) batteryData.onlevelchange();
      listeners.levelchange.forEach(function(fn) { try { fn(); } catch { /* intentional */ } });
    }, 60000);
  } catch { /* intentional */ }
})();
  `.trim();
}
