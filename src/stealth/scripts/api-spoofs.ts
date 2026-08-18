/**
 * Battery API Spoofing — Improvement #8
 *
 * Fingerprinters check navigator.getBattery() for consistency.
 * Automation environments return inconsistent or missing battery data.
 * This provides a realistic, deterministic battery state per profile.
 */
export function getBatteryApiSpoofScript(seed: number): string {
    const level = ((seed % 70) + 30) / 100;
    const charging = (seed % 3) !== 0;
    const chargingTime = charging ? Math.floor((1 - level) * 3600) : Infinity;
    const dischargingTime = charging ? Infinity : Math.floor(level * 14400);
    return `
(function() {
  try {
    var batteryData = {
      charging: ${charging},
      chargingTime: ${chargingTime === Infinity ? 'Infinity' : chargingTime},
      dischargingTime: ${dischargingTime === Infinity ? 'Infinity' : dischargingTime},
      level: ${level.toFixed(2)},
      addEventListener: function() {},
      removeEventListener: function() {},
      dispatchEvent: function() { return true; }
    };
    Object.defineProperty(batteryData, 'onchargingchange', { get: function() { return null; }, set: function() {}, configurable: true });
    Object.defineProperty(batteryData, 'onchargingtimechange', { get: function() { return null; }, set: function() {}, configurable: true });
    Object.defineProperty(batteryData, 'ondischargingtimechange', { get: function() { return null; }, set: function() {}, configurable: true });
    Object.defineProperty(batteryData, 'onlevelchange', { get: function() { return null; }, set: function() {}, configurable: true });

    if (Navigator.prototype.getBattery) {
      Navigator.prototype.getBattery = new Proxy(Navigator.prototype.getBattery, {
        apply: function() { return Promise.resolve(batteryData); }
      });
    } else if (navigator.getBattery) {
      Object.defineProperty(navigator, 'getBattery', {
        value: function() { return Promise.resolve(batteryData); },
        configurable: true, writable: true
      });
    }
  } catch { /* intentional */ }
})();
`;
}

/**
 * Permissions API Alignment — Improvement #9
 *
 * Fingerprinters check navigator.permissions.query() for notification,
 * geolocation, camera, and microphone permission states. Automation
 * environments return incorrect defaults. This aligns with a realistic
 * fresh-user profile.
 */
export function getPermissionsApiSpoofScript(seed: number): string {
    const notifState = (seed % 5) === 0 ? "denied" : "prompt";
    const geoState = "prompt";
    const camState = "prompt";
    const micState = "prompt";
    return `
(function() {
  try {
    var permStates = {
      "notifications": "${notifState}",
      "geolocation": "${geoState}",
      "camera": "${camState}",
      "microphone": "${micState}",
      "persistent-storage": "prompt",
      "push": "${notifState}",
      "midi": "prompt",
      "background-sync": "granted",
      "accelerometer": "granted",
      "gyroscope": "granted",
      "magnetometer": "granted",
      "clipboard-read": "prompt",
      "clipboard-write": "granted"
    };

    var permProto = Object.getPrototypeOf(navigator.permissions) || Permissions.prototype;
    if (permProto && permProto.query) {
      permProto.query = new Proxy(permProto.query, {
        apply: function(target, thisArg, args) {
          var desc = args[0];
          var name = desc && desc.name;
          if (name && permStates[name] !== undefined) {
            return Promise.resolve({
              name: name,
              state: permStates[name],
              status: permStates[name],
              onchange: null,
              addEventListener: function() {},
              removeEventListener: function() {},
              dispatchEvent: function() { return true; }
            });
          }
          return Reflect.apply(target, thisArg, args);
        }
      });
    }
  } catch { /* intentional */ }
})();
`;
}

/**
 * Speech Synthesis Voices Alignment — Improvement #10
 *
 * speechSynthesis.getVoices() returns OS-specific voice lists.
 * A "Windows" profile returning macOS voices is suspicious.
 */
export function getSpeechVoicesSpoofScript(os: "windows" | "macos" | "linux" | "android"): string {
    const voicesByOS: Record<string, Array<{ name: string; lang: string; local: boolean }>> = {
            windows: [
              { name: "Microsoft David - English (United States)", lang: "en-US", local: true },
              { name: "Microsoft Zira - English (United States)", lang: "en-US", local: true },
              { name: "Microsoft Mark - English (United States)", lang: "en-US", local: true },
              { name: "Google US English", lang: "en-US", local: false },
              { name: "Google UK English Female", lang: "en-GB", local: false },
              { name: "Google UK English Male", lang: "en-GB", local: false },
            ],
            macos: [
              { name: "Alex", lang: "en-US", local: true },
              { name: "Samantha", lang: "en-US", local: true },
              { name: "Victoria", lang: "en-US", local: true },
              { name: "Daniel", lang: "en-GB", local: true },
              { name: "Karen", lang: "en-AU", local: true },
              { name: "Google US English", lang: "en-US", local: false },
            ],
            linux: [
              { name: "Google US English", lang: "en-US", local: false },
              { name: "Google UK English Female", lang: "en-GB", local: false },
            ],
            android: [
              { name: "English (United States)", lang: "en-US", local: true },
              { name: "English (United Kingdom)", lang: "en-GB", local: true },
              { name: "Google US English", lang: "en-US", local: false },
            ],
          };
    const voices = voicesByOS[os] || voicesByOS.windows;
    return `
(function() {
  try {
    var voices = ${JSON.stringify(voices)}.map(function(v) {
      return {
        name: v.name,
        lang: v.lang,
        localService: v.local,
        default: false,
        voiceURI: v.name
      };
    });
    if (voices.length > 0) voices[0].default = true;

    Object.defineProperty(speechSynthesis, 'getVoices', {
      value: function() { return voices; },
      configurable: true, writable: true
    });

    // Trigger the onvoiceschanged event after a short delay
    setTimeout(function() {
      try {
        if (speechSynthesis.onvoiceschanged) speechSynthesis.onvoiceschanged();
        speechSynthesis.dispatchEvent(new Event('voiceschanged'));
      } catch { /* intentional */ }
    }, 100);
  } catch { /* intentional */ }
})();
`;
}

/**
 * Anti-VM Detection — ensures hardware fingerprints look like real consumer
 * hardware, not virtualized guests (VirtualBox, VMware, QEMU, etc.).
 * FingerprintJS checks WebGL renderer strings, hardware concurrency,
 * and memory for VM-typical values.
 */
export function getAntiVmDetectionScript(): string {
    return `
(function() {
  try {
    // Block VM-indicator strings from appearing in any getParameter result
    var vmPatterns = /virtual|vmware|vbox|qemu|parallels|hyperv|bhyve|kvm|xen/i;

    // Patch WebGL to filter out VM renderer strings that may leak
    var origGetParam = WebGLRenderingContext.prototype.getParameter;
    var patchedGetParam = function(parameter) {
      var result = origGetParam.call(this, parameter);
      // UNMASKED_VENDOR (37445) and UNMASKED_RENDERER (37446)
      // are already handled by webgl spoof — this catches extension queries
      if (typeof result === "string" && vmPatterns.test(result)) {
        return result.replace(vmPatterns, "");
      }
      return result;
    };
    // Only patch if our WebGL spoof hasn't already overridden it
    var currentGetParam = WebGLRenderingContext.prototype.getParameter;
    if (currentGetParam === origGetParam) {
      Object.defineProperty(WebGLRenderingContext.prototype, "getParameter", {
        value: patchedGetParam,
        configurable: true, writable: true
      });
    }

    // Ensure deviceMemory looks like consumer hardware (4-16 GB)
    if (navigator.deviceMemory && navigator.deviceMemory < 4) {
      Object.defineProperty(navigator, 'deviceMemory', {
        get: function() { return 8; },
        configurable: true
      });
    }

    // Ensure hardwareConcurrency looks like consumer CPU (4-16 cores)
    if (navigator.hardwareConcurrency && (navigator.hardwareConcurrency < 2 || navigator.hardwareConcurrency > 32)) {
      Object.defineProperty(navigator, 'hardwareConcurrency', {
        get: function() { return 8; },
        configurable: true
      });
    }
  } catch { /* intentional */ }
})();
`;
}

/**
 * Incognito Mode Detection Evasion — patches storage quota estimation
 * and filesystem API behaviors that fingerprinters use to detect private
 * browsing. In incognito, storage quota is typically much smaller and
 * filesystem API access times are different.
 */
export function getIncognitoEvasionScript(): string {
    return `
(function() {
  try {
    // Patch StorageManager.estimate() — incognito has reduced quota
    if (navigator.storage && navigator.storage.estimate) {
      var origEstimate = navigator.storage.estimate.bind(navigator.storage);
      Object.defineProperty(navigator.storage, 'estimate', {
        value: function() {
          return origEstimate().then(function(est) {
            // Normal Chrome gives ~60% of disk. Incognito gives much less.
            // Ensure quota looks like normal mode (>= 1GB)
            if (est.quota && est.quota < 1073741824) {
              return { quota: 268435456000, usage: est.usage || 0 };
            }
            return est;
          });
        },
        configurable: true, writable: true
      });
    }

    // Patch webkitRequestFileSystem — incognito throws error
    if (window.webkitRequestFileSystem) {
      var orig = window.webkitRequestFileSystem;
      window.webkitRequestFileSystem = function(type, size, success, error) {
        orig.call(window, type, size, success, function(err) {
          // In incognito, this errors with SECURITY_ERR
          // Fake a successful response instead
          if (success) {
            success({ name: '', root: { fullPath: '/', isFile: false, isDirectory: true } });
          }
        });
      };
    }

    // Patch IndexedDB open — incognito may have restrictions
    if (window.indexedDB) {
      var origOpen = window.indexedDB.open.bind(window.indexedDB);
      Object.defineProperty(window.indexedDB, 'open', {
        value: function(name, version) {
          try {
            return origOpen(name, version);
          } catch (e) {
            // Return a fake request that looks successful
            var fakeReq = {};
            fakeReq.result = null;
            fakeReq.onerror = null;
            fakeReq.onsuccess = null;
            setTimeout(function() {
              if (fakeReq.onsuccess) fakeReq.onsuccess({ target: fakeReq });
            }, 10);
            return fakeReq;
          }
        },
        configurable: true, writable: true
      });
    }
  } catch { /* intentional */ }
})();
`;
}

/**
 * Developer Tools Detection Evasion — prevents detection of open devtools.
 * FingerprintJS checks for devtools via console.log timing, window size
 * discrepancies, and debugger statement timing.
 */
export function getDevToolsEvasionScript(): string {
    return `
(function() {
  try {
    // Patch console methods that devtools detection relies on
    // Some detectors use toString() on console methods to check for overrides
    var nativeLog = console.log;
    var nativeToString = Function.prototype.toString;

    // Prevent debugger-based detection timing
    // Override the debugging protocol that some fingerprinters probe
    Object.defineProperty(window, '__REACT_DEVTOOLS_GLOBAL_HOOK__', {
      get: function() { return undefined; },
      set: function() {},
      configurable: true
    });

    // Ensure window.outerWidth/outerHeight match expectations
    // (devtools open causes outerWidth to differ from innerWidth significantly)
    // Only override if the native difference is suspicious (>100px = devtools)
    // If already reasonable, leave native values alone to avoid creating mismatches
    var nativeOuter = window.outerWidth;
    var nativeInner = window.innerWidth;
    var diff = Math.abs(nativeOuter - nativeInner);

    if (diff > 100 || nativeOuter === 0) {
      Object.defineProperty(window, 'outerWidth', {
        get: function() {
          var inner = window.innerWidth;
          // Realistic: outerWidth = innerWidth + 14-16px (borders)
          return inner > 0 ? inner + 16 : 1920;
        },
        configurable: true
      });
      Object.defineProperty(window, 'outerHeight', {
        get: function() {
          var inner = window.innerHeight;
          // Realistic: outerHeight = innerHeight + 79-88px (chrome UI + borders)
          return inner > 0 ? inner + 88 : 1040;
        },
        configurable: true
      });
    }

    // Prevent Firebug detection
    Object.defineProperty(window, '__firebug', {
      get: function() { return undefined; },
      set: function() {},
      configurable: true
    });
  } catch { /* intentional */ }
})();
`;
}

/**
 * Notification API Consistency — ensures Notification.permission matches
 * what navigator.permissions.query returns for notifications.
 */
export function getNotificationConsistencyScript(seed: number): string {
    const notifState = (seed % 5) === 0 ? "denied" : "default";
    return `
(function() {
  try {
    if (typeof Notification !== "undefined") {
      Object.defineProperty(Notification, 'permission', {
        get: function() { return "${notifState}"; },
        configurable: true
      });
    }
  } catch { /* intentional */ }
})();
`;
}

/**
 * Screen Consistency — ensures screen.width/height, availWidth/availHeight,
 * and colorDepth are all consistent and realistic.
 */
export function getScreenConsistencyScript(): string {
    return `
(function() {
  try {
    // Ensure colorDepth and pixelDepth are consistent (always 24 on most displays)
    Object.defineProperty(screen, 'colorDepth', {
      get: function() { return 24; },
      configurable: true
    });
    Object.defineProperty(screen, 'pixelDepth', {
      get: function() { return 24; },
      configurable: true
    });

    // Ensure screen dimensions include taskbar offset
    // availHeight should be slightly less than height (taskbar)
    var realHeight = screen.height;
    if (screen.availHeight === screen.height) {
      Object.defineProperty(screen, 'availHeight', {
        get: function() { return realHeight - 40; },
        configurable: true
      });
    }

    // Ensure availTop is set (0 on most systems)
    if (typeof screen.availTop === "undefined" || screen.availTop === undefined) {
      Object.defineProperty(screen, 'availTop', {
        get: function() { return 0; },
        configurable: true
      });
    }
    if (typeof screen.availLeft === "undefined" || screen.availLeft === undefined) {
      Object.defineProperty(screen, 'availLeft', {
        get: function() { return 0; },
        configurable: true
      });
    }

    // Ensure window.devicePixelRatio is reasonable
    if (!window.devicePixelRatio || window.devicePixelRatio < 0.5 || window.devicePixelRatio > 4) {
      Object.defineProperty(window, 'devicePixelRatio', {
        get: function() { return 1; },
        configurable: true
      });
    }
  } catch { /* intentional */ }
})();
`;
}

/**
 * Performance.now() timing jitter — Joe Fortune checks Performance.now() and
 * getEntriesByType(). Without noise, every session on the same host produces
 * identical timing fingerprints, enabling cross-session correlation.
 */
export function getPerformanceTimingSpoofScript(seed: number): string {
    return `
(function() {
  try {
    var seed = ${seed};
    var offset = ((seed % 1000) / 1000) * 0.1; // 0-0.1ms deterministic offset
    var jitterScale = 0.05; // ±0.05ms per call
    var callCount = 0;

    function deterministicJitter() {
      callCount++;
      var t = 10000 * Math.sin(seed + callCount);
      return (t - Math.floor(t) - 0.5) * 2 * jitterScale + offset;
    }

    if (Performance.prototype.now) {
      Performance.prototype.now = new Proxy(Performance.prototype.now, {
        apply: function(target, thisArg, args) {
          return Reflect.apply(target, thisArg, args) + deterministicJitter();
        }
      });
    }

    // Patch getEntriesByType to add micro-noise to navigation timing entries
    if (Performance.prototype.getEntriesByType) {
      Performance.prototype.getEntriesByType = new Proxy(Performance.prototype.getEntriesByType, {
        apply: function(target, thisArg, args) {
          var entries = Reflect.apply(target, thisArg, args);
          if (args[0] === 'navigation' && entries.length > 0) {
            return entries.map(function(entry) {
              try {
                var obj = {};
                for (var k in entry) {
                  if (typeof entry[k] === 'number' && entry[k] > 0) {
                    obj[k] = entry[k] + deterministicJitter();
                  } else {
                    obj[k] = entry[k];
                  }
                }
                obj.toJSON = function() { return obj; };
                return obj;
              } catch(e) { return entry; }
            });
          }
          return entries;
        }
      });
    }
  } catch { /* intentional */ }
})();
  `.trim();
}

/**
 * Gamepads API — both sites check navigator.getGamepads(). Headless/automation
 * environments sometimes return undefined instead of an empty array, flagging
 * the session as non-human.
 */
export function getGamepadsSpoofScript(): string {
    return `
(function() {
  try {
    // Desktop user with no gamepad: return a 4-slot null array (Chrome default)
    if (Navigator.prototype.getGamepads) {
      Navigator.prototype.getGamepads = new Proxy(Navigator.prototype.getGamepads, {
        apply: function() { return [null, null, null, null]; }
      });
    }
  } catch { /* intentional */ }
})();
  `.trim();
}

/**
 * Device Orientation/Motion — both sites check DeviceOrientationEvent and
 * DeviceMotionEvent constructors. Desktop Chrome exposes these as constructors
 * but they fire events with null sensor data (no gyroscope/accelerometer).
 * Automation environments sometimes lack these entirely.
 */
export function getDeviceOrientationSpoofScript(): string {
    return `
(function() {
  try {
    // Ensure constructors exist and are callable (Chrome desktop has them)
    if (typeof DeviceOrientationEvent === 'undefined') {
      window.DeviceOrientationEvent = function(type, init) {
        return new Event(type, init);
      };
      window.DeviceOrientationEvent.prototype = Event.prototype;
    }
    if (typeof DeviceMotionEvent === 'undefined') {
      window.DeviceMotionEvent = function(type, init) {
        return new Event(type, init);
      };
      window.DeviceMotionEvent.prototype = Event.prototype;
    }

    // Ensure addEventListener for these events doesn't throw
    var origAdd = EventTarget.prototype.addEventListener;
    var sensorEvents = ['deviceorientation', 'devicemotion'];
    EventTarget.prototype.addEventListener = function(type, listener, options) {
      // Allow binding but never fire (desktop has no sensors)
      return origAdd.call(this, type, listener, options);
    };
    EventTarget.prototype.addEventListener.toString = function() { return "function addEventListener() { [native code] }"; };
  } catch { /* intentional */ }
})();
  `.trim();
}

/**
 * Geolocation API — both sites probe navigator.geolocation. A real browser
 * has the API present but returns PERMISSION_DENIED when the user hasn't
 * granted access. Automation envs sometimes have missing or broken geolocation.
 */
export function getGeolocationSpoofScript(): string {
    return `
(function() {
  try {
    if (navigator.geolocation) {
      var geoProto = Object.getPrototypeOf(navigator.geolocation) || Geolocation.prototype;
      if (geoProto && geoProto.getCurrentPosition) {
        geoProto.getCurrentPosition = new Proxy(geoProto.getCurrentPosition, {
          apply: function(target, thisArg, args) {
            var error = args[1];
            if (typeof error === 'function') {
              setTimeout(function() {
                error({ code: 1, message: 'User denied Geolocation', PERMISSION_DENIED: 1, POSITION_UNAVAILABLE: 2, TIMEOUT: 3 });
              }, 50 + Math.floor(Math.random() * 100));
            }
          }
        });
        geoProto.watchPosition = new Proxy(geoProto.watchPosition, {
          apply: function(target, thisArg, args) {
            var error = args[1];
            if (typeof error === 'function') {
              setTimeout(function() {
                error({ code: 1, message: 'User denied Geolocation', PERMISSION_DENIED: 1, POSITION_UNAVAILABLE: 2, TIMEOUT: 3 });
              }, 50);
            }
            return 0;
          }
        });
      }
    }
  } catch { /* intentional */ }
})();
  `.trim();
}

/**
 * IndexedDB fingerprint — both sites check indexedDB.databases(). Automation
 * sessions start with zero databases, which is unusual for a real browser that
 * has system databases from extensions and cached data.
 */
export function getIndexedDBConsistencyScript(): string {
    return `
(function() {
  try {
    if (window.indexedDB && indexedDB.databases) {
      var origDatabases = indexedDB.databases.bind(indexedDB);
      Object.defineProperty(indexedDB, 'databases', {
        value: function() {
          return origDatabases().then(function(dbs) {
            // Real Chrome always has at least a few system databases
            if (dbs.length === 0) {
              return [
                { name: '__browser_history_cache', version: 1 },
                { name: 'pref_store', version: 1 }
              ];
            }
            return dbs;
          }).catch(function() {
            // If databases() throws (some envs), return fake list
            return [{ name: '__browser_history_cache', version: 1 }];
          });
        },
        configurable: true, writable: true
      });
      indexedDB.databases.toString = function() { return "function databases() { [native code] }"; };
    }
  } catch { /* intentional */ }
})();
  `.trim();
}

/**
 * Clipboard API — both sites check navigator.clipboard. Real browsers have
 * the API present but readText/writeText reject with NotAllowedError when
 * the user hasn't granted clipboard permission (realistic for fresh profiles).
 */
export function getClipboardConsistencyScript(): string {
    return `
(function() {
  try {
    var clipProto = navigator.clipboard ? Object.getPrototypeOf(navigator.clipboard) || Clipboard.prototype : null;
    if (clipProto && clipProto.readText) {
      clipProto.readText = new Proxy(clipProto.readText, {
        apply: function() { return Promise.reject(new DOMException('Read permission denied.', 'NotAllowedError')); }
      });
    }
    if (clipProto && clipProto.writeText) {
      clipProto.writeText = new Proxy(clipProto.writeText, {
        apply: function() { return Promise.resolve(); }
      });
    }
    // Strict rejection for document.execCommand('paste')
    if (document.execCommand) {
      document.execCommand = new Proxy(document.execCommand, {
        apply: function(target, thisArg, args) {
          if (args[0] === 'paste') return false;
          return Reflect.apply(target, thisArg, args);
        }
      });
    }
  } catch { /* intentional */ }
})();
  `.trim();
}

/**
 * reCAPTCHA v3 scores sessions 0.0-1.0 based on behavioral telemetry collected
 * from page load. Both Joe Fortune and Ignition run invisible v3. The score
 * is computed from: mouse movement, scroll events, focus/blur patterns, timing
 * between page load and form interaction, and DOM engagement signals.
 *
 * This script seeds realistic behavioral events immediately at page load,
 * BEFORE the reCAPTCHA JS evaluates, to maximize the score.
 */
/**
 * WebUSB API Spoofing — Improvement #1
 *
 * Scrapfly detects `navigator.usb` and `navigator.usb.getDevices` fingerprinting
 * at 80% confidence on Joe Fortune. Real browsers have this API but users rarely
 * have USB devices connected. Return empty device list.
 */
export function getWebUsbSpoofScript(): string {
    return `
(function() {
  try {
    if (navigator.usb) {
      var usbProto = Object.getPrototypeOf(navigator.usb) || USB.prototype;
      if (usbProto && usbProto.getDevices) {
        usbProto.getDevices = new Proxy(usbProto.getDevices, {
          apply: function() { return Promise.resolve([]); }
        });
        usbProto.requestDevice = new Proxy(usbProto.requestDevice, {
          apply: function() { return Promise.reject(new DOMException('No device selected.', 'NotFoundError')); }
        });
      } else {
        navigator.usb.getDevices = new Proxy(navigator.usb.getDevices, {
          apply: function() { return Promise.resolve([]); }
        });
        navigator.usb.requestDevice = new Proxy(navigator.usb.requestDevice, {
          apply: function() { return Promise.reject(new DOMException('No device selected.', 'NotFoundError')); }
        });
      }
    }
  } catch { /* intentional */ }
})();
  `.trim();
}

/**
 * navigator.connection Spoofing — Improvement #6
 *
 * Fingerprinters probe NetworkInformation to correlate network quality with
 * geolocation. A datacenter's downlink:10/rtt:0 on a "residential" IP is suspicious.
 * We return values typical of an Australian residential ADSL/cable connection.
 */
export function getNavigatorConnectionSpoofScript(seed: number): string {
    const downlink = 5 + (seed % 20);
    const rtt = 20 + (seed % 80);
    const effectiveType = '4g';
    return `
(function() {
  try {
    var connData = {
      downlink: ${downlink},
      effectiveType: '${effectiveType}',
      rtt: ${rtt},
      saveData: false,
      type: 'wifi',
      onchange: null
    };
    if (navigator.connection) {
      var proto = Object.getPrototypeOf(navigator.connection) || NetworkInformation.prototype;
      if (proto) {
        for (var k in connData) {
          try {
            var origDesc = Object.getOwnPropertyDescriptor(proto, k);
            if (origDesc && origDesc.get) {
              (function(key, val) {
                origDesc.get = new Proxy(origDesc.get, {
                  apply: function() { return val; }
                });
                Object.defineProperty(proto, key, origDesc);
              })(k, connData[k]);
            } else {
              Object.defineProperty(navigator.connection, k, {
                get: function(val) { return function() { return val; }; }(connData[k]),
                configurable: true
              });
            }
          } catch { /* intentional */ }
        }
      }
    }
  } catch { /* intentional */ }
})();
  `.trim();
}

/**
 * performance.memory Spoofing — Improvement #7
 *
 * Headless/automated browsers have distinctive memory profiles.
 * Return values typical of a real Chrome session.
 */
export function getPerformanceMemorySpoofScript(): string {
    return `
(function() {
  try {
    if (performance && performance.memory) {
      var memData = {
        jsHeapSizeLimit: 2172649472,
        totalJSHeapSize: 35194484 + Math.floor(Math.random() * 10000000),
        usedJSHeapSize: 28847932 + Math.floor(Math.random() * 8000000)
      };
      var origDesc = Object.getOwnPropertyDescriptor(Performance.prototype, 'memory');
      if (origDesc && origDesc.get) {
        origDesc.get = new Proxy(origDesc.get, {
          apply: function() { return memData; }
        });
        Object.defineProperty(Performance.prototype, 'memory', origDesc);
      } else {
        Object.defineProperty(performance, 'memory', {
          get: function() { return memData; },
          configurable: true
        });
      }
    }
  } catch { /* intentional */ }
})();
  `.trim();
}

/**
 * CSS.supports() Fingerprinting Spoofing — Improvement #2
 * Matches modern Chrome support for CSS properties.
 */
export function getCSSSupportsSpoofScript(chromeVersion: number): string {
    return `
(function() {
  try {
    var chromeVer = ${chromeVersion};
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
      'text-decoration-thickness': true
    };

    CSS.supports = function() {
      var conditionText = arguments[0];
      if (arguments.length === 1) {
        var match = conditionText.match(/\\(([\\w-]+)\\s*:/);
        if (match && supportedFeatures[match[1]]) return true;
        // Also support @container queries if queried directly
        if (conditionText.indexOf('@container') !== -1) return true;
      } else if (arguments.length === 2) {
        var property = arguments[0];
        if (supportedFeatures[property]) return true;
      }
      return origSupports.apply(this, arguments);
    };
    CSS.supports.toString = function() { return "function supports() { [native code] }"; };
  } catch { /* intentional */ }
})();
  `.trim();
}

/**
 * document.featurePolicy / Permissions-Policy Alignment — Improvement #10
 */
export function getFeaturePolicyScript(): string {
    return `
(function() {
  try {
    if (document.featurePolicy && document.featurePolicy.allowsFeature) {
      var origAllows = document.featurePolicy.allowsFeature.bind(document.featurePolicy);
      document.featurePolicy.allowsFeature = function(feature) {
        var restricted = ['ch-ua-full-version', 'ch-ua-platform-version', 'ch-ua-model', 'ch-ua-arch', 'ch-ua-bitness', 'ch-ua-wow64'];
        if (restricted.indexOf(feature) !== -1) return false;
        return origAllows(feature);
      };
      document.featurePolicy.allowsFeature.toString = function() { return "function allowsFeature() { [native code] }"; };
    }
  } catch { /* intentional */ }
})();
  `.trim();
}

/**
 * SharedArrayBuffer / Cross-Origin Isolation Check — Improvement #8
 */
export function getCrossOriginIsolationScript(): string {
    return `
(function() {
  try {
    if ('crossOriginIsolated' in window) {
      Object.defineProperty(window, 'crossOriginIsolated', {
        get: function() { return false; },
        configurable: true
      });
    }
    if (typeof SharedArrayBuffer === 'undefined') {
      window.SharedArrayBuffer = function SharedArrayBuffer(length) {
        return new ArrayBuffer(length);
      };
    }
  } catch { /* intentional */ }
})();
  `.trim();
}
