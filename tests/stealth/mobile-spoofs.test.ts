import { describe, it, expect } from "vitest";
import {
  getMobilePlatformOverrideScript,
  getMobileTouchPointsScript,
  getDesktopTouchPointsScript,
  getMobileOntouchstartScript,
  getMobileOrientationScript,
  getMobileConnectionScript,
  getMobileWebGLRendererScript,
  getMobileVibrateScript,
  getMobileScreenDimensionsScript,
  getMobileBatteryScript,
  getMobilePointerTypeScript,
  emailToSeed
} from "../../src/stealth/mobile-spoofs.js";

describe("Mobile Spoofs Generator", () => {
  it("should generate valid JS injection scripts for mobile emulation", () => {
    const platform = getMobilePlatformOverrideScript();
    expect(platform).toContain("Linux armv8l");

    const touchPoints = getMobileTouchPointsScript();
    expect(touchPoints).toContain("maxTouchPoints");
    expect(touchPoints).toContain("5");

    const desktopTouch = getDesktopTouchPointsScript();
    expect(desktopTouch).toContain("maxTouchPoints");
    expect(desktopTouch).toContain("0");

    const ontouch = getMobileOntouchstartScript();
    expect(ontouch).toContain("ontouchstart");

    const orientation = getMobileOrientationScript();
    expect(orientation).toContain("portrait-primary");

    const conn = getMobileConnectionScript(12345);
    expect(conn).toContain("cellular");
    expect(conn).toContain("effectiveType");

    const webgl = getMobileWebGLRendererScript(42);
    expect(webgl).toContain("Qualcomm");

    const vibrate = getMobileVibrateScript();
    expect(vibrate).toContain("vibrate");

    const screens = getMobileScreenDimensionsScript(77);
    expect(screens).toContain("devicePixelRatio");

    const battery = getMobileBatteryScript(99);
    expect(battery).toContain("getBattery");

    const pointer = getMobilePointerTypeScript();
    expect(pointer).toContain("PointerEvent");
  });

  it("should calculate deterministic email seed", () => {
    const seed1 = emailToSeed("test@example.com");
    const seed2 = emailToSeed("TEST@EXAMPLE.COM");
    const seed3 = emailToSeed("other@example.com");

    expect(seed1).toBe(seed2);
    expect(seed1).not.toBe(seed3);
    expect(typeof seed1).toBe("number");
  });
});
