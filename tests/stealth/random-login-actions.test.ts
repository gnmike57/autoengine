import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  chooseSubmitMethod,
  REGISTERED_SUBMIT_VARIATIONS,
  getOrderedSubmitRoute,
  getSubmitMethodForInvocation,
  executeSubmit,
  clickFieldRandomly,
  maybeEarlyFieldClick,
  maybeClickWrongFieldFirst,
  simulateAutofill,
  maybeDoubleClickField,
  maybeTripleClickField,
  maybeCtrlAField,
  maybeOvershootToButton,
  shouldTabToPassword,
  tabToNextField,
  maybeClickEmptyArea,
  maybeScrollToForm,
  maybeClickRememberMe,
  maybeClickLabel,
  maybeDismissAutocomplete,
  maybePostSubmitScroll,
  maybeHoverBeforeClick,
  randomMicroInteraction,
  preFillActions,
  preSubmitActions,
  emailToPasswordTransition,
  maybeTabSwitchSimulation,
  maybeHoverRandomLink,
  maybeAccidentalTextSelect,
  maybeExploreAndReturn,
  mouseIdleDrift,
  maybeKeyboardShortcut,
  maybeSeedTouchEvents,
  maybeFireMouseoverChain,
  fireRealisticFieldEvents,
  performWarmupRandomClicks,
  performZeroCostBehavioralSeeding
} from "../../src/stealth/random-login-actions.js";

vi.mock("../../src/stealth/logger.js", () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    error: vi.fn(),
    warn: vi.fn()
  })
}));

vi.mock("../../src/stealth/gaussian-rng.js", () => ({
  gaussianClamped: vi.fn().mockReturnValue(10),
  gaussianInt: vi.fn().mockReturnValue(5),
  gaussianRandom: vi.fn().mockReturnValue(0.5)
}));

vi.mock("../../src/intelligence/mouse-humanizer.js", () => ({
  humanMouseMove: vi.fn().mockResolvedValue(undefined),
  humanScroll: vi.fn().mockResolvedValue(undefined),
  injectMicroTremor: vi.fn().mockResolvedValue(undefined),
  humanClickAt: vi.fn().mockResolvedValue(undefined),
  humanClickSelector: vi.fn().mockResolvedValue(undefined)
}));

describe("random-login-actions", () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let mockPage: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let mockLocator: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let mockElementHandle: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let mockCdp: any;

  beforeEach(() => {
    vi.clearAllMocks();
    
    // Always return Math.random() < 0.5 unless mocked
    vi.spyOn(Math, "random").mockReturnValue(0.01); // Make it always trigger "maybe" functions

    mockLocator = {
      boundingBox: vi.fn().mockResolvedValue({ x: 10, y: 10, width: 100, height: 20 }),
      inputValue: vi.fn().mockResolvedValue("test@example.com"),
      scrollIntoViewIfNeeded: vi.fn().mockResolvedValue(undefined),
      getAttribute: vi.fn().mockResolvedValue("test-id"),
      click: vi.fn().mockResolvedValue(undefined),
      press: vi.fn().mockResolvedValue(undefined),
      focus: vi.fn().mockResolvedValue(undefined),
      nth: vi.fn().mockReturnThis()
    };

    mockElementHandle = {
      boundingBox: vi.fn().mockResolvedValue({ x: 10, y: 10, width: 100, height: 20 })
    };

    mockCdp = {
      send: vi.fn().mockResolvedValue(undefined),
      detach: vi.fn().mockResolvedValue(undefined),
    };

    mockPage = {
      locator: vi.fn().mockReturnValue(mockLocator),
      context: vi.fn().mockReturnValue({
        newCDPSession: vi.fn().mockResolvedValue(mockCdp),
      }),
      $: vi.fn().mockResolvedValue(mockElementHandle),
      $$: vi.fn().mockResolvedValue([mockElementHandle]),
      focus: vi.fn().mockResolvedValue(undefined),
      evaluate: vi.fn().mockResolvedValue(true),
      viewportSize: vi.fn().mockReturnValue({ width: 1920, height: 1080 }),
      isClosed: vi.fn().mockReturnValue(false),
      mouse: {
        move: vi.fn().mockResolvedValue(undefined),
        down: vi.fn().mockResolvedValue(undefined),
        up: vi.fn().mockResolvedValue(undefined),
        dblclick: vi.fn().mockResolvedValue(undefined)
      },
      keyboard: {
        press: vi.fn().mockResolvedValue(undefined),
        down: vi.fn().mockResolvedValue(undefined),
        up: vi.fn().mockResolvedValue(undefined)
      }
    };
  });

  it("exposes every registered submit variation exactly once", () => {
    expect(REGISTERED_SUBMIT_VARIATIONS).toEqual([
      "enter_in_password",
      "click",
      "click_offset",
      "locator_click",
      "locator_click_actionable",
      "locator_click_position",
      "locator_press_enter",
      "locator_press_space",
      "button_enter",
      "tab_enter",
      "tab_space",
      "dispatch_click",
      "request_submit",
      "js_submit",
      "cdp_mouse_click",
      "cdp_key_enter",
    ]);
    expect(new Set(REGISTERED_SUBMIT_VARIATIONS).size).toBe(REGISTERED_SUBMIT_VARIATIONS.length);
  });

  it("routes invocations deterministically from the selected primary variation", () => {
    expect(getOrderedSubmitRoute("button_enter").slice(0, 4)).toEqual([
      "button_enter",
      "tab_enter",
      "tab_space",
      "dispatch_click",
    ]);
    expect(getSubmitMethodForInvocation(1, "button_enter")).toBe("button_enter");
    expect(getSubmitMethodForInvocation(4, "button_enter")).toBe("dispatch_click");
    expect(() => getSubmitMethodForInvocation(0)).toThrow(RangeError);
  });

  it("chooseSubmitMethod remains a legacy random helper over the registered denominator", () => {
    vi.spyOn(Math, "random").mockReturnValue(0.01);
    expect(chooseSubmitMethod()).toBe("enter_in_password");
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    expect(chooseSubmitMethod()).toBe("button_enter");
  });

  it("executeSubmit click", async () => {
    // eslint-disable-next-line @typescript-eslint/no-unsafe-argument
    await executeSubmit(mockPage, "#submit", "#password", "click");
    expect(mockPage.locator).toHaveBeenCalledWith("#submit");
  });

  it("executeSubmit locator_click performs one locator action", async () => {
    await executeSubmit(mockPage, "#submit", "#password", "locator_click");
    expect(mockLocator.click).toHaveBeenCalledTimes(1);
    expect(mockLocator.click).toHaveBeenCalledWith({ force: true });
  });

  it("executeSubmit locator_click_actionable waits for normal actionability", async () => {
    const receipt = await executeSubmit(mockPage, "#submit", "#password", "locator_click_actionable");
    expect(mockLocator.click).toHaveBeenCalledTimes(1);
    expect(mockLocator.click).toHaveBeenCalledWith();
    expect(receipt).toMatchObject({ method: "locator_click_actionable", actionCount: 1, actionKind: "locator" });
  });

  it("executeSubmit locator_click_position uses deterministic relative coordinates", async () => {
    const receipt = await executeSubmit(mockPage, "#submit", "#password", "locator_click_position");
    expect(mockLocator.click).toHaveBeenCalledWith({ position: { x: 50, y: 10 } });
    expect(receipt.coordinates).toEqual({ x: 60, y: 20 });
  });

  it.each([
    ["locator_press_enter", "Enter"],
    ["locator_press_space", "Space"],
  ] as const)("executeSubmit %s uses one locator key trigger", async (method, key) => {
    const receipt = await executeSubmit(mockPage, "#submit", "#password", method);
    expect(mockLocator.press).toHaveBeenCalledTimes(1);
    expect(mockLocator.press).toHaveBeenCalledWith(key);
    expect(receipt).toMatchObject({ method, actionCount: 1, actionKind: "keyboard" });
  });

  it("executeSubmit button_enter performs one submit keypress", async () => {
    await executeSubmit(mockPage, "#submit", "#password", "button_enter");
    expect(mockPage.focus).toHaveBeenCalledWith("#submit");
    expect(mockPage.keyboard.press).toHaveBeenCalledTimes(1);
    expect(mockPage.keyboard.press).toHaveBeenCalledWith("Enter", { delay: expect.any(Number) });
  });

  it.each([
    ["dispatch_click", "synthetic"],
    ["request_submit", "javascript"],
    ["js_submit", "javascript"],
  ] as const)("executeSubmit %s performs one explicit DOM action", async (method, actionKind) => {
    const receipt = await executeSubmit(mockPage, "#submit", "#password", method);
    expect(mockPage.evaluate).toHaveBeenCalledTimes(1);
    expect(receipt).toMatchObject({ method, actionCount: 1, actionKind });
  });

  it("executeSubmit cdp_mouse_click emits a pressed/released pair and one logical receipt", async () => {
    const receipt = await executeSubmit(mockPage, "#submit", "#password", "cdp_mouse_click");
    expect(mockCdp.send).toHaveBeenCalledTimes(2);
    expect(mockCdp.send).toHaveBeenNthCalledWith(1, "Input.dispatchMouseEvent", expect.objectContaining({ type: "mousePressed", x: 60, y: 20 }));
    expect(mockCdp.send).toHaveBeenNthCalledWith(2, "Input.dispatchMouseEvent", expect.objectContaining({ type: "mouseReleased", x: 60, y: 20 }));
    expect(mockCdp.detach).toHaveBeenCalledTimes(1);
    expect(receipt).toMatchObject({ actionCount: 1, actionKind: "cdp", protocolEventCount: 2, coordinates: { x: 60, y: 20 } });
  });

  it("executeSubmit cdp_key_enter focuses the locator and emits one key pair", async () => {
    const receipt = await executeSubmit(mockPage, "#submit", "#password", "cdp_key_enter");
    expect(mockLocator.focus).toHaveBeenCalledTimes(1);
    expect(mockCdp.send).toHaveBeenCalledTimes(2);
    expect(mockCdp.send).toHaveBeenNthCalledWith(1, "Input.dispatchKeyEvent", expect.objectContaining({ type: "rawKeyDown", key: "Enter" }));
    expect(mockCdp.send).toHaveBeenNthCalledWith(2, "Input.dispatchKeyEvent", expect.objectContaining({ type: "keyUp", key: "Enter" }));
    expect(receipt).toMatchObject({ actionCount: 1, actionKind: "cdp", protocolEventCount: 2 });
  });

  it("executeSubmit tab_enter", async () => {
    // eslint-disable-next-line @typescript-eslint/no-unsafe-argument
    await executeSubmit(mockPage, "#submit", "#password", "tab_enter");
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    expect(mockPage.keyboard.press).toHaveBeenCalledWith("Tab", { delay: expect.any(Number) });
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    expect(mockPage.keyboard.press).toHaveBeenCalledWith("Enter", { delay: expect.any(Number) });
  });

  it("clickFieldRandomly", async () => {
    // eslint-disable-next-line @typescript-eslint/no-unsafe-argument
    await clickFieldRandomly(mockPage, "#test");
    expect(mockPage.locator).toHaveBeenCalledWith("#test");
  });

  it("maybeEarlyFieldClick", async () => {
    // eslint-disable-next-line @typescript-eslint/no-unsafe-argument
    const res = await maybeEarlyFieldClick(mockPage, "#test");
    expect(res).toBe(true);
  });

  it("maybeClickWrongFieldFirst", async () => {
    // eslint-disable-next-line @typescript-eslint/no-unsafe-argument
    const res = await maybeClickWrongFieldFirst(mockPage, "#email", "#pass");
    expect(res).toBe(true);
  });

  it("simulateAutofill", async () => {
    // eslint-disable-next-line @typescript-eslint/no-unsafe-argument
    const res = await simulateAutofill(mockPage, "#email", "#pass", "test@example.com", "password");
    expect(res).toBe(false); // Returns false because password inputValue is mocked to test@example.com
  });

  it("maybeDoubleClickField", async () => {
    // eslint-disable-next-line @typescript-eslint/no-unsafe-argument
    const res = await maybeDoubleClickField(mockPage, "#test");
    expect(res).toBe(true);
  });

  it("maybeTripleClickField", async () => {
    // eslint-disable-next-line @typescript-eslint/no-unsafe-argument
    const res = await maybeTripleClickField(mockPage, "#test");
    expect(res).toBe(true);
  });

  it("maybeCtrlAField", async () => {
    // eslint-disable-next-line @typescript-eslint/no-unsafe-argument
    const res = await maybeCtrlAField(mockPage, "#test");
    expect(res).toBe(true);
  });

  it("maybeOvershootToButton", async () => {
    // eslint-disable-next-line @typescript-eslint/no-unsafe-argument
    const res = await maybeOvershootToButton(mockPage, "#test");
    expect(res).toBe(true);
  });

  it("shouldTabToPassword", () => {
    expect(shouldTabToPassword()).toBe(true);
  });

  it("tabToNextField", async () => {
    // eslint-disable-next-line @typescript-eslint/no-unsafe-argument
    await tabToNextField(mockPage);
    expect(mockPage.keyboard.press).toHaveBeenCalledWith("Tab");
  });

  it("maybeClickEmptyArea", async () => {
    // eslint-disable-next-line @typescript-eslint/no-unsafe-argument
    await maybeClickEmptyArea(mockPage);
    expect(mockPage.viewportSize).toHaveBeenCalled();
  });

  it("maybeScrollToForm", async () => {
    // eslint-disable-next-line @typescript-eslint/no-unsafe-argument
    await maybeScrollToForm(mockPage, "#form");
    expect(mockLocator.scrollIntoViewIfNeeded).toHaveBeenCalled();
  });

  it("maybeClickRememberMe", async () => {
    // eslint-disable-next-line @typescript-eslint/no-unsafe-argument
    await maybeClickRememberMe(mockPage);
    // Since it is deprecated and handled elsewhere, it shouldn't query the page
    expect(mockPage.$).not.toHaveBeenCalled();
  });

  it("maybeClickLabel", async () => {
    // eslint-disable-next-line @typescript-eslint/no-unsafe-argument
    const res = await maybeClickLabel(mockPage, "#input");
    expect(res).toBe(true);
  });

  it("maybeDismissAutocomplete", async () => {
    // eslint-disable-next-line @typescript-eslint/no-unsafe-argument
    await maybeDismissAutocomplete(mockPage);
    expect(mockPage.keyboard.press).toHaveBeenCalledWith("Escape");
  });

  it("maybePostSubmitScroll", async () => {
    // eslint-disable-next-line @typescript-eslint/no-unsafe-argument
    await maybePostSubmitScroll(mockPage);
  });

  it("maybeHoverBeforeClick", async () => {
    // eslint-disable-next-line @typescript-eslint/no-unsafe-argument
    await maybeHoverBeforeClick(mockPage, "#input");
  });

  it("randomMicroInteraction", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0.9); // To trigger numActions = 2
    // eslint-disable-next-line @typescript-eslint/no-unsafe-argument
    await randomMicroInteraction(mockPage);
  });

  it("preFillActions", async () => {
    // eslint-disable-next-line @typescript-eslint/no-unsafe-argument
    const res = await preFillActions(mockPage, "#email", "#pass");
    expect(res.usedAutofill).toBe(false);
  });

  it("preSubmitActions", async () => {
    // eslint-disable-next-line @typescript-eslint/no-unsafe-argument
    const res = await preSubmitActions(mockPage, "#email", "#submit");
    expect(res.submitMethod).toBeDefined();
  });

  it("emailToPasswordTransition", async () => {
    // eslint-disable-next-line @typescript-eslint/no-unsafe-argument
    const res = await emailToPasswordTransition(mockPage, "#pass");
    expect(res.usedTab).toBe(true); // Because random() < 0.25
  });

  it("maybeTabSwitchSimulation", async () => {
    // eslint-disable-next-line @typescript-eslint/no-unsafe-argument
    await maybeTabSwitchSimulation(mockPage);
    expect(mockPage.evaluate).toHaveBeenCalled();
  });

  it("maybeHoverRandomLink", async () => {
    // eslint-disable-next-line @typescript-eslint/no-unsafe-argument
    await maybeHoverRandomLink(mockPage);
    expect(mockPage.evaluate).toHaveBeenCalled();
  });

  it("maybeAccidentalTextSelect", async () => {
    // eslint-disable-next-line @typescript-eslint/no-unsafe-argument
    await maybeAccidentalTextSelect(mockPage);
    expect(mockPage.mouse.down).toHaveBeenCalled();
  });

  it("maybeExploreAndReturn", async () => {
    // eslint-disable-next-line @typescript-eslint/no-unsafe-argument
    await maybeExploreAndReturn(mockPage, "#form");
    expect(mockLocator.scrollIntoViewIfNeeded).toHaveBeenCalled();
  });



  it("mouseIdleDrift", async () => {
    // eslint-disable-next-line @typescript-eslint/no-unsafe-argument
    await mouseIdleDrift(mockPage);
    expect(mockPage.mouse.move).toHaveBeenCalled();
  });

  it("maybeKeyboardShortcut", async () => {
    // eslint-disable-next-line @typescript-eslint/no-unsafe-argument
    await maybeKeyboardShortcut(mockPage);
    expect(mockPage.keyboard.press).toHaveBeenCalled();
  });

  it("maybeSeedTouchEvents", async () => {
    // eslint-disable-next-line @typescript-eslint/no-unsafe-argument
    await maybeSeedTouchEvents(mockPage);
    expect(mockPage.evaluate).toHaveBeenCalled();
  });

  it("maybeFireMouseoverChain", async () => {
    // eslint-disable-next-line @typescript-eslint/no-unsafe-argument
    await maybeFireMouseoverChain(mockPage, "#test");
    expect(mockPage.evaluate).toHaveBeenCalled();
  });

  it("fireRealisticFieldEvents", async () => {
    // eslint-disable-next-line @typescript-eslint/no-unsafe-argument
    await fireRealisticFieldEvents(mockPage, "#test");
    expect(mockPage.evaluate).toHaveBeenCalled();
  });

  it("performWarmupRandomClicks", async () => {
    // eslint-disable-next-line @typescript-eslint/no-unsafe-argument
    await performWarmupRandomClicks(mockPage, "test@test.com");
    expect(mockPage.evaluate).toHaveBeenCalled();
  });

  it("performZeroCostBehavioralSeeding", async () => {
    // eslint-disable-next-line @typescript-eslint/no-unsafe-argument
    await performZeroCostBehavioralSeeding(mockPage);
    expect(mockPage.evaluate).toHaveBeenCalled();
  });


});
