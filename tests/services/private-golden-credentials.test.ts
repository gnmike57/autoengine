import { describe, expect, it } from "vitest";
import { loadPrivateGoldenCredential } from "../../src/services/private-golden-credentials.js";

describe("loadPrivateGoldenCredential", () => {
  it("loads a combined private environment value and preserves password colons", () => {
    const result = loadPrivateGoldenCredential("joe", {
      GOLDEN_CRED_JOE: "owner@example.test:password:with:colons",
    });
    expect(result).toEqual({
      email: "owner@example.test",
      password: "password:with:colons",
      source: "combined-environment",
    });
  });

  it("falls back to separate private environment values", () => {
    const result = loadPrivateGoldenCredential("ignition", {
      IGNITION_EMAIL: "owner@example.test",
      IGNITION_PASSWORD: "synthetic-password",
    });
    expect(result).toEqual({
      email: "owner@example.test",
      password: "synthetic-password",
      source: "separate-environment",
    });
  });

  it("rejects malformed combined values without including the value in the error", () => {
    expect(() => loadPrivateGoldenCredential("joe", {
      GOLDEN_CRED_JOE: "missing-delimiter",
    })).toThrow("invalid-private-golden-credential-format:joe");
    try {
      loadPrivateGoldenCredential("joe", { GOLDEN_CRED_JOE: "missing-delimiter" });
    } catch (error) {
      expect(String(error)).not.toContain("missing-delimiter");
    }
  });

  it("fails closed when no private credential exists", () => {
    expect(() => loadPrivateGoldenCredential("ignition", {})).toThrow(
      "private-golden-credential-unavailable:ignition",
    );
  });
});
