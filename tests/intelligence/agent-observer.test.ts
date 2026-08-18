import { describe, it, expect, vi } from "vitest";
import { AgentObserver } from "../../src/intelligence/agent-observer.js";
import { ConfigStore } from "../../src/core/config-store.js";

describe("AgentObserver", () => {
  it("should do nothing if enableAgentObservation is false", async () => {
    vi.spyOn(ConfigStore, "load").mockReturnValue({ enableAgentObservation: false } as any);

    const mockPage: any = {
      on: vi.fn(),
      evaluate: vi.fn()
    };

    await AgentObserver.attach(mockPage, "sess-test");
    expect(mockPage.on).not.toHaveBeenCalled();

    await AgentObserver.updateOverlay(mockPage, { state: "Running" });
    expect(mockPage.evaluate).not.toHaveBeenCalled();
  });

  it("should update overlay if enableAgentObservation is true", async () => {
    vi.spyOn(ConfigStore, "load").mockReturnValue({ enableAgentObservation: true } as any);

    const evaluate = vi.fn().mockResolvedValue(undefined);
    const mockPage: any = { evaluate };

    await AgentObserver.updateOverlay(mockPage, {
      state: "TESTING",
      attemptNumber: 1,
      totalAttempts: 4,
      email: "test@example.com",
      siteName: "joe"
    });

    expect(evaluate).toHaveBeenCalled();
  });
});
