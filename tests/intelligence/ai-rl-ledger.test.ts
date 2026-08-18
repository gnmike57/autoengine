import { describe, it, expect, vi, beforeEach } from "vitest";
import fs from "fs";
import { RLLedger } from "../../src/intelligence/ai-rl-ledger.js";
import * as rng from "../../src/core/gaussian-rng.js";

vi.mock("fs", () => ({
  default: {
    existsSync: vi.fn(),
    readFileSync: vi.fn(),
    writeFileSync: vi.fn(),
  }
}));

describe("RLLedger", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("load and save", () => {
    it("loads empty data when file does not exist", () => {
      vi.mocked(fs.existsSync).mockReturnValue(false);
      const ledger = new RLLedger();
      
      // Access private data via any
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      expect((ledger as any).data).toEqual({});
    });

    it("loads data when file exists", () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({
        "testKey": { mean: 100, stdDev: 10, min: 50, max: 200, successes: 1, failures: 0 }
      }));
      
      const ledger = new RLLedger();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      expect((ledger as any).data).toHaveProperty("testKey");
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      expect((ledger as any).data["testKey"].mean).toBe(100);
    });

    it("handles JSON parse errors by initializing empty data", () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockImplementation(() => { throw new Error("Parse error"); });
      
      const ledger = new RLLedger();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      expect((ledger as any).data).toEqual({});
    });

    it("saves data to file", () => {
      vi.mocked(fs.existsSync).mockReturnValue(false);
      const ledger = new RLLedger();
      ledger.getTiming("scope1", "testKey", 100, 10, 50, 200); // this calls save() initially
      
      expect(fs.writeFileSync).toHaveBeenCalled();
      const call = vi.mocked(fs.writeFileSync).mock.calls[0];
      expect(call![0]).toContain("rl-timings.json");
      expect(call![1]).toContain("testKey");
    });

    it("swallows save errors silently", () => {
      vi.mocked(fs.writeFileSync).mockImplementation(() => { throw new Error("Disk full"); });
      const ledger = new RLLedger();
      expect(() => ledger.save()).not.toThrow();
    });
  });

  describe("getTiming", () => {
    it("initializes a new key with defaults and saves it", () => {
      vi.mocked(fs.existsSync).mockReturnValue(false);
      const ledger = new RLLedger();
      
      const val = ledger.getTiming("scope1", "newKey", 100, 10, 50, 200);
      expect(val).toBeGreaterThanOrEqual(50);
      expect(val).toBeLessThanOrEqual(200);
      
       
      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
      const data = (ledger as any).data["newKey"];
      expect(data).toMatchObject({
        mean: 100,
        stdDev: 10,
        min: 50,
        max: 200,
        successes: 0,
        failures: 0
      });
      expect(fs.writeFileSync).toHaveBeenCalled();
    });

    it("clamps the active mean and stdDev when they stray too far from defaults", () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({
        "strayKey": { mean: 9999, stdDev: 9999, min: 50, max: 200, successes: 10, failures: 0 }
      }));
      
      const ledger = new RLLedger();
      const spy = vi.spyOn(rng, "gaussianClamped");
      ledger.getTiming("scope1", "strayKey", 100, 10, 50, 200);
      
      expect(spy).toHaveBeenCalled();
      const [mean, stdDev] = spy.mock.calls[0]!;
      expect(mean).toBe(300); // max defaultMax * 1.5 = 200 * 1.5 = 300
      expect(stdDev).toBe(20); // max defaultStdDev * 2 = 10 * 2 = 20
      
      spy.mockRestore();
    });
    
    it("handles extremely low learned mean/stdDev by clamping to bottom bounds", () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({
        "lowKey": { mean: 1, stdDev: 1, min: 50, max: 200, successes: 10, failures: 0 }
      }));
      
      const ledger = new RLLedger();
      const spy = vi.spyOn(rng, "gaussianClamped");
      ledger.getTiming("scope1", "lowKey", 100, 10, 50, 200);
      
      const [mean, stdDev] = spy.mock.calls[0]!;
      expect(mean).toBe(25); // defaultMin * 0.5 = 50 * 0.5 = 25
      expect(stdDev).toBe(5); // defaultStdDev * 0.5 = 10 * 0.5 = 5
      
      spy.mockRestore();
    });
  });

  describe("reportOutcome", () => {
    it("ignores outcomes for unknown scopes", () => {
      const ledger = new RLLedger();
      expect(() => ledger.reportOutcome("unknownScope", true)).not.toThrow();
    });

    it("speeds up (reduces mean) when success is true", () => {
      vi.mocked(fs.existsSync).mockReturnValue(false);
      const ledger = new RLLedger();
      
      ledger.getTiming("scope1", "testKey", 100, 10, 50, 200);
      
       
      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
      const before = (ledger as any).data["testKey"].mean;
      ledger.reportOutcome("scope1", true);
       
      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
      const after = (ledger as any).data["testKey"].mean;
      
      // eslint-disable-next-line @typescript-eslint/no-unsafe-argument
      expect(after).toBeLessThan(before);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      expect((ledger as any).data["testKey"].successes).toBe(1);
    });

    it("slows down (increases mean) when success is false", () => {
      vi.mocked(fs.existsSync).mockReturnValue(false);
      const ledger = new RLLedger();
      
      ledger.getTiming("scope2", "testKey", 100, 10, 50, 200);
      
       
      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
      const before = (ledger as any).data["testKey"].mean;
      ledger.reportOutcome("scope2", false);
       
      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
      const after = (ledger as any).data["testKey"].mean;
      
      // eslint-disable-next-line @typescript-eslint/no-unsafe-argument
      expect(after).toBeGreaterThan(before);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      expect((ledger as any).data["testKey"].failures).toBe(1);
    });
    
    it("ignores keys in the scope that are somehow missing in data", () => {
      vi.mocked(fs.existsSync).mockReturnValue(false);
      const ledger = new RLLedger();
      
      ledger.getTiming("scope3", "missingDataKey", 100, 10, 50, 200);
      // Remove it manually to simulate error
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      delete (ledger as any).data["missingDataKey"];
      
      expect(() => ledger.reportOutcome("scope3", true)).not.toThrow();
    });
  });
});
