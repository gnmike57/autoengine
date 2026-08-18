import { describe, expect, it, vi } from "vitest";
import {
  enterTextWithVariant,
  resolveLoginSelectors,
} from "../../src/targets/login-step-variants.js";
import { summarizeLoginStepComparisons } from "../../src/targets/login-step-comparison.js";

interface FakeLocatorOptions {
  visible?: boolean;
  snapshot?: string;
  valueState?: { value: string };
}

function fakeLocator(options: FakeLocatorOptions = {}) {
  const state = options.valueState ?? { value: "" };
  const locator = {
    first: vi.fn(),
    isVisible: vi.fn().mockResolvedValue(options.visible ?? false),
    evaluate: vi.fn().mockResolvedValue(undefined),
    ariaSnapshot: vi.fn().mockResolvedValue(options.snapshot ?? ""),
    click: vi.fn().mockResolvedValue(undefined),
    fill: vi.fn().mockImplementation(async (value: string) => { state.value = value; }),
    pressSequentially: vi.fn().mockImplementation(async (value: string) => { state.value += value; }),
    inputValue: vi.fn().mockImplementation(async () => state.value),
  };
  locator.first.mockReturnValue(locator);
  return locator;
}

function makePage(input: {
  configuredVisible?: boolean;
  roleVisible?: boolean;
  ariaSnapshot?: string;
}) {
  const configured = fakeLocator({ visible: input.configuredVisible });
  const hidden = fakeLocator({ visible: false });
  const usernameRole = fakeLocator({ visible: input.roleVisible });
  const passwordLabel = fakeLocator({ visible: input.roleVisible });
  const submitRole = fakeLocator({ visible: input.roleVisible });
  const body = fakeLocator({ visible: true, snapshot: input.ariaSnapshot });

  const page = {
    locator: vi.fn((selector: string) => selector === "body" ? body : configured),
    getByRole: vi.fn((role: string) => {
      if (role === "textbox") return usernameRole;
      if (role === "button") return submitRole;
      return hidden;
    }),
    getByLabel: vi.fn(() => passwordLabel),
  };
  return { page, configured, usernameRole, passwordLabel, submitRole, body };
}

const configuredSelectors = { username: "#username", password: "#password", submit: "#submit" };

describe("login step variants", () => {
  it("keeps configured CSS as the zero-migration default", async () => {
    const { page } = makePage({ configuredVisible: true });
    const result = await resolveLoginSelectors(page as never, configuredSelectors, "configured_css");
    expect(result).toMatchObject({
      ...configuredSelectors,
      provenance: {
        variant: "configured_css",
        usernameSource: "configured-css",
        passwordSource: "configured-css",
        submitSource: "configured-css",
      },
    });
  });

  it("materializes role/label locators into stable selectors with provenance", async () => {
    const { page, usernameRole, passwordLabel, submitRole } = makePage({ roleVisible: true });
    const result = await resolveLoginSelectors(page as never, configuredSelectors, "role_label_discovery");
    expect(result.username).toBe('[data-automati-discovery="role-label-username"]');
    expect(result.password).toBe('[data-automati-discovery="role-label-password"]');
    expect(result.submit).toBe('[data-automati-discovery="role-label-submit"]');
    expect(result.provenance.variant).toBe("role_label_discovery");
    expect(usernameRole.evaluate).toHaveBeenCalledTimes(1);
    expect(passwordLabel.evaluate).toHaveBeenCalledTimes(1);
    expect(submitRole.evaluate).toHaveBeenCalledTimes(1);
  });

  it("captures a bounded ARIA snapshot and deterministic provenance hash", async () => {
    const { page } = makePage({ roleVisible: true, ariaSnapshot: "- textbox Email\n- textbox Password\n- button Log in" });
    const first = await resolveLoginSelectors(page as never, configuredSelectors, "aria_snapshot_discovery");
    const second = await resolveLoginSelectors(page as never, configuredSelectors, "aria_snapshot_discovery");
    expect(first.provenance.ariaSnapshot).toContain("button Log in");
    expect(first.provenance.ariaSnapshotSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(second.provenance.ariaSnapshotSha256).toBe(first.provenance.ariaSnapshotSha256);
  });

  it("pressSequentially entry is distinct from the default fallback and verifies the final value", async () => {
    const state = { value: "stale" };
    const locator = fakeLocator({ visible: true, valueState: state });
    const page = { locator: vi.fn(() => locator) };
    const fallback = vi.fn().mockResolvedValue(true);

    const ok = await enterTextWithVariant(page as never, "#username", "user@example.test", "press_sequentially_entry", fallback, 7);
    expect(ok).toBe(true);
    expect(fallback).not.toHaveBeenCalled();
    expect(locator.click).toHaveBeenCalledTimes(1);
    expect(locator.fill).toHaveBeenCalledWith("");
    expect(locator.pressSequentially).toHaveBeenCalledWith("user@example.test", { delay: 7 });
  });

  it("input_text delegates unchanged to the existing driver", async () => {
    const page = { locator: vi.fn() };
    const fallback = vi.fn().mockResolvedValue(true);
    await expect(enterTextWithVariant(page as never, "#password", "secret", "input_text", fallback)).resolves.toBe(true);
    expect(fallback).toHaveBeenCalledWith(page, "#password", "secret");
  });
});

describe("login step comparison statistics", () => {
  it("computes deterministic success, acceptance, evidence, drift, false-PASS, median, and p95 metrics", () => {
    const summary = summarizeLoginStepComparisons([
      { layer: "submit", variant: "locator_click_actionable", runId: "a", success: true, latencyMs: 10, acceptedSubmit: true, evidenceSignalCount: 3, driftFixturePassed: true, falsePass: false },
      { layer: "submit", variant: "locator_click_actionable", runId: "b", success: false, latencyMs: 30, acceptedSubmit: false, evidenceSignalCount: 1, driftFixturePassed: false, falsePass: true },
      { layer: "submit", variant: "locator_click_actionable", runId: "c", success: true, latencyMs: 20, acceptedSubmit: true, evidenceSignalCount: 2, driftFixturePassed: true, falsePass: false },
    ]);
    expect(summary).toEqual([expect.objectContaining({
      variant: "locator_click_actionable",
      runs: 3,
      successCount: 2,
      successRate: 0.666667,
      acceptedSubmitRate: 0.666667,
      evidenceCompleteRate: 0.666667,
      driftPassRate: 0.666667,
      falsePassCount: 1,
      medianLatencyMs: 20,
      p95LatencyMs: 30,
    })]);
  });

  it("rejects invalid latency rather than corrupting the ranking", () => {
    expect(() => summarizeLoginStepComparisons([
      { layer: "entry", variant: "press_sequentially_entry", runId: "x", success: true, latencyMs: -1 },
    ])).toThrow(RangeError);
  });
});
