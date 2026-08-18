/**
 * Test 5: getStmt — LRU Prepared Statement Cache
 * Test 12: Outcome Vocabulary Centralization
 * Test 13: encrypt/decrypt Identity Pass-Through (extends crypto-utils)
 *
 * Bundled together as they test database.ts internals.
 */
import { describe, it, expect } from "vitest";
import { encrypt, decrypt, CONFIDENT_OUTCOMES, TESTED_OUTCOMES } from "../../src/core/database.js";

describe("encrypt/decrypt identity pass-through (Rule 31)", () => {
  it("encrypt returns input unchanged", () => {
    expect(encrypt("password123")).toBe("password123");
  });

  it("decrypt returns input unchanged", () => {
    expect(decrypt("password123")).toBe("password123");
  });

  it("roundtrip: decrypt(encrypt(x)) === x for all inputs", () => {
    const inputs = ["", "hello", "P@ssw0rd!", '["pw1","pw2"]', "日本語テスト"];
    for (const input of inputs) {
      expect(decrypt(encrypt(input))).toBe(input);
    }
  });

  it("handles empty string", () => {
    expect(encrypt("")).toBe("");
    expect(decrypt("")).toBe("");
  });

  it("handles JSON array string (real password storage format)", () => {
    const json = '["password1","password2!","p@ss#3"]';
    expect(encrypt(json)).toBe(json);
    expect(decrypt(json)).toBe(json);
  });

  it("handles unicode characters", () => {
    const unicode = "пароль密码パスワード";
    expect(encrypt(unicode)).toBe(unicode);
    expect(decrypt(unicode)).toBe(unicode);
  });
});

describe("Outcome vocabulary centralization (Rule 45)", () => {
  it("CONFIDENT_OUTCOMES includes success, 2FA, noaccount, permdisabled, honeypot", () => {
    expect(CONFIDENT_OUTCOMES).toContain("success");
    expect(CONFIDENT_OUTCOMES).toContain("2FA");
    expect(CONFIDENT_OUTCOMES).toContain("noaccount");
    expect(CONFIDENT_OUTCOMES).toContain("permdisabled");
    expect(CONFIDENT_OUTCOMES).toContain("honeypot");
  });

  it("TESTED_OUTCOMES is a superset of CONFIDENT_OUTCOMES", () => {
    for (const outcome of CONFIDENT_OUTCOMES) {
      expect(TESTED_OUTCOMES, `TESTED_OUTCOMES should include '${outcome}'`).toContain(outcome);
    }
  });

  it("TESTED_OUTCOMES includes success-unconfirmed and blocked", () => {
    expect(TESTED_OUTCOMES).toContain("success-unconfirmed");
    expect(TESTED_OUTCOMES).toContain("blocked");
  });

  it("no duplicate values in CONFIDENT_OUTCOMES", () => {
    const set = new Set(CONFIDENT_OUTCOMES);
    expect(set.size).toBe(CONFIDENT_OUTCOMES.length);
  });

  it("no duplicate values in TESTED_OUTCOMES", () => {
    const set = new Set(TESTED_OUTCOMES);
    expect(set.size).toBe(TESTED_OUTCOMES.length);
  });

  it("CONFIDENT_OUTCOMES has exactly 5 entries", () => {
    expect(CONFIDENT_OUTCOMES.length).toBe(5);
  });
});
