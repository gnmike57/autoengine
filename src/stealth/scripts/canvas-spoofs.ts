export function getCanvasSpoofScript(seed: number): string {
    return `
(function() {
  try {
    var seed = ${seed};
    function getNoise(idx) {
      var t = 10000 * Math.sin(seed + idx);
      return t - Math.floor(t);
    }
    function applyNoise(data) {
      for (var i = 0; i < data.length; i += 4) {
        var noise = Math.floor(5 * getNoise(i)) - 2;
        data[i] = Math.max(0, Math.min(255, data[i] + noise));
        data[i+1] = Math.max(0, Math.min(255, data[i+1] + noise));
        data[i+2] = Math.max(0, Math.min(255, data[i+2] + noise));
      }
    }
    var originalToDataURL = HTMLCanvasElement.prototype.toDataURL;
    var originalToBlob = HTMLCanvasElement.prototype.toBlob;
    var originalGetImageData = CanvasRenderingContext2D.prototype.getImageData;

    Object.defineProperty(HTMLCanvasElement.prototype, "toDataURL", {
      value: function(type, encoderOptions) {
        if (this.width <= 800 && this.height <= 800 && this.width > 0 && this.height > 0) {
          try {
            var ctx = this.getContext("2d", { willReadFrequently: true });
            if (ctx) {
              var imageData = originalGetImageData.call(ctx, 0, 0, this.width, this.height);
              applyNoise(imageData.data);
              ctx.putImageData(imageData, 0, 0);
            }
          } catch { /* intentional */ }
        }
        return originalToDataURL.call(this, type, encoderOptions);
      },
      configurable: true, writable: true
    });

    Object.defineProperty(HTMLCanvasElement.prototype, "toBlob", {
      value: function(callback, type, encoderOptions) {
        if (this.width <= 800 && this.height <= 800 && this.width > 0 && this.height > 0) {
          try {
            var ctx = this.getContext("2d", { willReadFrequently: true });
            if (ctx) {
              var imageData = originalGetImageData.call(ctx, 0, 0, this.width, this.height);
              applyNoise(imageData.data);
              ctx.putImageData(imageData, 0, 0);
            }
          } catch { /* intentional */ }
        }
        return originalToBlob.call(this, callback, type, encoderOptions);
      },
      configurable: true, writable: true
    });

    Object.defineProperty(CanvasRenderingContext2D.prototype, "getImageData", {
      value: function(x, y, width, height, settings) {
        var imageData = originalGetImageData.call(this, x, y, width, height, settings);
        if (width <= 800 && height <= 800) {
          applyNoise(imageData.data);
        }
        return imageData;
      },
      configurable: true, writable: true
    });
  } catch { /* intentional */ }
})();
`;
}
