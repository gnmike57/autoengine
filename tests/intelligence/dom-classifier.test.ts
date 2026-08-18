import { describe, it, expect, vi } from "vitest";
import { injectDualClassifier } from "../../src/intelligence/dom-classifier.js";

describe("DOM Classifier", () => {
  it("should inject dual classifier init script into page", async () => {
    const addInitScript = vi.fn().mockResolvedValue(undefined);
    const mockPage: any = { addInitScript };

    await injectDualClassifier(mockPage, "joe");
    expect(addInitScript).toHaveBeenCalledTimes(1);
  });
});
