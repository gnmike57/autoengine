import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import {
  getCoordinateMap,
  saveCoordinateMap,
  resolveAbsoluteCoordinate,
  coordinateClick,
  type SiteCoordinateMap
} from "../../src/intelligence/coordinate-mapper.js";

describe("Coordinate Mapper", () => {
  const configDir = path.join(process.cwd(), "config", "coordinates");
  const testSite = "test-site-coords";
  const testFile = path.join(configDir, `${testSite}.json`);

  beforeEach(() => {
    if (fs.existsSync(testFile)) fs.unlinkSync(testFile);
  });

  afterEach(() => {
    if (fs.existsSync(testFile)) fs.unlinkSync(testFile);
  });

  it("should return null for non-existent site config", () => {
    expect(getCoordinateMap("non-existent-site")).toBeNull();
  });

  it("should save and load coordinate map", () => {
    const map: SiteCoordinateMap = {
      emailInput: { vw: 0.5, vh: 0.4 },
      passwordInput: { vw: 0.5, vh: 0.5 },
      submitButton: { vw: 0.5, vh: 0.6 }
    };

    saveCoordinateMap(testSite, map);
    const loaded = getCoordinateMap(testSite);
    expect(loaded).toEqual(map);
  });

  it("should resolve absolute pixel coordinates from viewport ratio", () => {
    const mockPage: any = {
      viewportSize: () => ({ width: 1000, height: 800 })
    };

    const coord = { vw: 0.5, vh: 0.25 };
    const { x, y } = resolveAbsoluteCoordinate(mockPage, coord);
    expect(x).toBe(500);
    expect(y).toBe(200);
  });

  it("should throw if page viewport size is not set", () => {
    const mockPage: any = {
      viewportSize: () => null
    };

    expect(() => resolveAbsoluteCoordinate(mockPage, { vw: 0.5, vh: 0.5 })).toThrow(
      "Viewport size is not set"
    );
  });

  it("should execute humanized mouse movement and click", async () => {
    const move = vi.fn().mockResolvedValue(undefined);
    const down = vi.fn().mockResolvedValue(undefined);
    const up = vi.fn().mockResolvedValue(undefined);

    const mockPage: any = {
      viewportSize: () => ({ width: 1200, height: 900 }),
      mouse: { move, down, up }
    };

    await coordinateClick(mockPage, { vw: 0.5, vh: 0.5 });
    expect(move).toHaveBeenCalled();
    expect(down).toHaveBeenCalled();
    expect(up).toHaveBeenCalled();
  });
});
