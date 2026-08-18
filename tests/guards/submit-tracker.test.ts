import { describe, it, expect, vi } from "vitest";
import { SubmitButtonStateTracker } from "../../src/guards/submit-tracker.js";

describe("SubmitButtonStateTracker", () => {
  it("should initialize with IDLE state and null baseline", () => {
    const mockPage: any = {};
    const tracker = new SubmitButtonStateTracker(mockPage, {
      submitSelector: "#submit",
      emailSelector: "#email",
      passwordSelector: "#password",
      siteName: "joe"
    });

    expect(tracker.getState()).toBe("IDLE");
    expect(tracker.getBaseline()).toBeNull();
  });

  it("should retrieve acceptance snapshot from page evaluation", async () => {
    const mockPage: any = {
      evaluate: vi.fn().mockResolvedValue({
        mutationCount: 3,
        errorTextChanged: true,
        buttonHtmlChanged: false,
        cloakStatus: "HTTP_200"
      })
    };

    const tracker = new SubmitButtonStateTracker(mockPage, {
      submitSelector: "#submit",
      emailSelector: "#email",
      passwordSelector: "#password",
      siteName: "joe"
    });

    const snapshot = await tracker.getAcceptanceSnapshot();
    expect(snapshot.state).toBe("IDLE");
    expect(snapshot.mutationCount).toBe(3);
    expect(snapshot.errorTextChanged).toBe(true);
    expect(snapshot.responseObserved).toBe(true);
  });
});
