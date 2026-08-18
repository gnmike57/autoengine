/**
 * Screen consistency and noise spoofing
 * Extracted from stealth-scripts.ts
 */

export function getScreenNoiseScript(seed: number): string {
  const noiseX = (seed % 11) - 5;
  const noiseY = (seed % 9) - 4;

  return `
(function() {
  try {
    var noiseX = ${noiseX};
    var noiseY = ${noiseY};

    // Override screen width/height properties with Proxies on getters
    var props = ['width', 'height', 'availWidth', 'availHeight'];
    props.forEach(function(prop) {
      var origDesc = Object.getOwnPropertyDescriptor(Screen.prototype, prop);
      if (origDesc && origDesc.get) {
        origDesc.get = new Proxy(origDesc.get, {
          apply: function(target, thisArg, args) {
            var val = Reflect.apply(target, thisArg, args);
            return val + (prop.indexOf('Width') !== -1 ? noiseX : noiseY);
          }
        });
        Object.defineProperty(Screen.prototype, prop, origDesc);
      }
    });

    // Also inject innerWidth/innerHeight noise safely
    var origInnerWidthDesc = Object.getOwnPropertyDescriptor(window, 'innerWidth');
    if (origInnerWidthDesc && origInnerWidthDesc.get) {
       origInnerWidthDesc.get = new Proxy(origInnerWidthDesc.get, {
          apply: function(target, thisArg, args) {
             return Reflect.apply(target, thisArg, args) + noiseX;
          }
       });
       Object.defineProperty(window, 'innerWidth', origInnerWidthDesc);
    }
  } catch { /* intentional */ }
})();
  `.trim();
}

export function getCssMediaQueryCoherenceScript(isMobile: boolean): string {
  return `
(function() {
  try {
    var origMatchMedia = window.matchMedia;
    if (origMatchMedia) {
      window.matchMedia = new Proxy(origMatchMedia, {
        apply: function(target, thisArg, args) {
          var query = args[0] || '';
          var isMobile = ${isMobile};

          if (isMobile) {
            if (query.indexOf('(pointer: coarse)') !== -1) return { matches: true, media: query, onchange: null, addListener: function(){}, removeListener: function(){}, addEventListener: function(){}, removeEventListener: function(){}, dispatchEvent: function(){return true;} };
            if (query.indexOf('(pointer: fine)') !== -1) return { matches: false, media: query, onchange: null, addListener: function(){}, removeListener: function(){}, addEventListener: function(){}, removeEventListener: function(){}, dispatchEvent: function(){return true;} };
            if (query.indexOf('(hover: none)') !== -1) return { matches: true, media: query, onchange: null, addListener: function(){}, removeListener: function(){}, addEventListener: function(){}, removeEventListener: function(){}, dispatchEvent: function(){return true;} };
            if (query.indexOf('(hover: hover)') !== -1) return { matches: false, media: query, onchange: null, addListener: function(){}, removeListener: function(){}, addEventListener: function(){}, removeEventListener: function(){}, dispatchEvent: function(){return true;} };
          } else {
            if (query.indexOf('(pointer: coarse)') !== -1) return { matches: false, media: query, onchange: null, addListener: function(){}, removeListener: function(){}, addEventListener: function(){}, removeEventListener: function(){}, dispatchEvent: function(){return true;} };
            if (query.indexOf('(pointer: fine)') !== -1) return { matches: true, media: query, onchange: null, addListener: function(){}, removeListener: function(){}, addEventListener: function(){}, removeEventListener: function(){}, dispatchEvent: function(){return true;} };
            if (query.indexOf('(hover: none)') !== -1) return { matches: false, media: query, onchange: null, addListener: function(){}, removeListener: function(){}, addEventListener: function(){}, removeEventListener: function(){}, dispatchEvent: function(){return true;} };
            if (query.indexOf('(hover: hover)') !== -1) return { matches: true, media: query, onchange: null, addListener: function(){}, removeListener: function(){}, addEventListener: function(){}, removeEventListener: function(){}, dispatchEvent: function(){return true;} };
          }
          return Reflect.apply(target, thisArg, args);
        }
      });
    }
  } catch { /* intentional */ }
})();
  `.trim();
}
