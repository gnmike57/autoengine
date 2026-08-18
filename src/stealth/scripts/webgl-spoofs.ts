export function getWebGLSpoofScript(vendor: string, renderer: string): string {
    return `
(function() {
  try {
    var vendor = ${JSON.stringify(vendor)};
    var renderer = ${JSON.stringify(renderer)};
    var getParameter = WebGLRenderingContext.prototype.getParameter;
    Object.defineProperty(WebGLRenderingContext.prototype, "getParameter", {
      value: function(parameter) {
        if (parameter === 37445) return vendor;
        if (parameter === 37446) return renderer;
        return getParameter.call(this, parameter);
      },
      configurable: true, writable: true
    });
    if (typeof WebGL2RenderingContext !== "undefined") {
      var getParameter2 = WebGL2RenderingContext.prototype.getParameter;
      Object.defineProperty(WebGL2RenderingContext.prototype, "getParameter", {
        value: function(parameter) {
          if (parameter === 37445) return vendor;
          if (parameter === 37446) return renderer;
          return getParameter2.call(this, parameter);
        },
        configurable: true, writable: true
      });
    }
  } catch { /* intentional */ }
})();
`;
}
