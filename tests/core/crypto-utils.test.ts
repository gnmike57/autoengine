import { describe, it, expect } from "vitest";
import { djb2Hash, emailDomainHash, emailHash, emailToFingerprintSeed } from "../../src/core/crypto-utils.js";

describe("crypto-utils", () => {
  it("djb2Hash produces stable non-negative integers", () => {
    expect(djb2Hash("test")).toBeGreaterThanOrEqual(0);
    expect(djb2Hash("test")).toBe(djb2Hash("test"));
    expect(djb2Hash("test1")).not.toBe(djb2Hash("test2"));
  });

  it("emailDomainHash hashes only the domain", () => {
    const hash1 = emailDomainHash("user@EXAMPLE.COM");
    const hash2 = emailDomainHash("other@example.com");
    expect(hash1).toBe(hash2);
    
    // Fallback if no @ symbol
    expect(emailDomainHash("example.com")).toBe(hash1);
  });

  it("emailDomainHash uses rotation to produce new hashes", () => {
    const hash0 = emailDomainHash("user@example.com", 0);
    const hash1 = emailDomainHash("user@example.com", 1);
    expect(hash0).not.toBe(hash1);
  });

  it("emailHash normalizes casing and whitespace", () => {
    const hash1 = emailHash(" USER@example.com ");
    const hash2 = emailHash("user@EXAMPLE.com");
    expect(hash1).toBe(hash2);
  });

  it("emailHash uses rotation to produce new hashes", () => {
    const hash0 = emailHash("user@example.com", 0);
    const hash1 = emailHash("user@example.com", 1);
    expect(hash0).not.toBe(hash1);
  });

  it("emailToFingerprintSeed produces stable 5 digit numbers", () => {
    const seed1 = emailToFingerprintSeed("test@example.com");
    expect(seed1).toBeGreaterThanOrEqual(10000);
    expect(seed1).toBeLessThanOrEqual(99999);
    
    const seed2 = emailToFingerprintSeed(" TEST@example.com ");
    expect(seed1).toBe(seed2);
  });

  it("emailToFingerprintSeed uses rotation to produce new seeds", () => {
    const seedRot0 = emailToFingerprintSeed("test@example.com", 0);
    const seedRot1 = emailToFingerprintSeed("test@example.com", 1);
    const seedRot2 = emailToFingerprintSeed("test@example.com", 2);
    
    expect(seedRot0).not.toBe(seedRot1);
    expect(seedRot1).not.toBe(seedRot2);
  });
});
