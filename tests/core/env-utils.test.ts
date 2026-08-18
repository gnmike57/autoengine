import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { getEnvInt, getEnvBool, getEnvString } from "../../src/core/env-utils.js";

describe("env-utils", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    vi.resetModules();
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  describe("getEnvInt", () => {
    it("returns default when unset or empty", () => {
      expect(getEnvInt("MISSING_KEY", 42)).toBe(42);
      process.env.TEST_EMPTY = "";
      expect(getEnvInt("TEST_EMPTY", 42)).toBe(42);
    });

    it("parses valid integers", () => {
      process.env.TEST_INT = "123";
      expect(getEnvInt("TEST_INT", 42)).toBe(123);
      
      process.env.TEST_INT_NEG = "-123";
      expect(getEnvInt("TEST_INT_NEG", 42)).toBe(-123);

      process.env.TEST_INT_TRIM = "  456  ";
      expect(getEnvInt("TEST_INT_TRIM", 42)).toBe(456);

      process.env.TEST_INT_PLUS = "+789";
      expect(getEnvInt("TEST_INT_PLUS", 42)).toBe(789);
    });

    it("logs warning and returns default for invalid integers", () => {
      // Not a finite number
      process.env.TEST_INVALID = "abc";
      expect(getEnvInt("TEST_INVALID", 42)).toBe(42);

      // Float instead of int
      process.env.TEST_FLOAT = "12.34";
      expect(getEnvInt("TEST_FLOAT", 42)).toBe(42);

      // Number mixed with string
      process.env.TEST_MIXED = "123abc";
      expect(getEnvInt("TEST_MIXED", 42)).toBe(42);
    });
  });

  describe("getEnvBool", () => {
    it("returns default when unset or empty", () => {
      expect(getEnvBool("MISSING_BOOL", true)).toBe(true);
      process.env.TEST_BOOL_EMPTY = "   ";
      expect(getEnvBool("TEST_BOOL_EMPTY", true)).toBe(true);
    });

    it("parses truthy values", () => {
      const truthy = ["1", "true", "yes", "on", " TRUE ", "Yes"];
      truthy.forEach((val, i) => {
        const key = `TEST_TRUTHY_${i}`;
        process.env[key] = val;
        expect(getEnvBool(key, false)).toBe(true);
      });
    });

    it("parses falsy values", () => {
      const falsy = ["0", "false", "no", "off", " FALSE ", "No"];
      falsy.forEach((val, i) => {
        const key = `TEST_FALSY_${i}`;
        process.env[key] = val;
        expect(getEnvBool(key, true)).toBe(false);
      });
    });

    it("logs warning and returns default for invalid booleans", () => {
      process.env.TEST_INVALID_BOOL = "maybe";
      expect(getEnvBool("TEST_INVALID_BOOL", true)).toBe(true);
      expect(getEnvBool("TEST_INVALID_BOOL", false)).toBe(false);
    });
  });

  describe("getEnvString", () => {
    it("returns default when unset or empty", () => {
      expect(getEnvString("MISSING_STR", "def")).toBe("def");
      process.env.TEST_STR_EMPTY = "   ";
      expect(getEnvString("TEST_STR_EMPTY", "def")).toBe("def");
      
      // Default parameter value
      expect(getEnvString("MISSING_STR_NO_DEF")).toBe("");
    });

    it("returns trimmed string when set", () => {
      process.env.TEST_STR = " hello world ";
      expect(getEnvString("TEST_STR", "def")).toBe("hello world");
    });
  });
});
