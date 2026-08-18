import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { detectAndSolveCaptcha, detectCaptchaType, isReCaptchaV3Only } from '../../src/services/captcha-solver.js';
import { Page } from 'playwright-core';

describe('captcha-solver', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('returns false if no captcha detected', async () => {
    const mockPage = {
      evaluate: vi.fn().mockResolvedValue(null),
    } as unknown as Page;

    const result = await detectAndSolveCaptcha(mockPage);
    expect(result).toBe(false);
  });

  it('returns false for reCAPTCHA v3 (score-based, no puzzle solve needed)', async () => {
    const mockPage = {
      evaluate: vi.fn().mockResolvedValue("recaptcha-v3"),
    } as unknown as Page;

    const result = await detectAndSolveCaptcha(mockPage);
    expect(result).toBe(false); // v3 is handled by stealth scripts, not puzzle solver
  });

  it('returns false for visual CAPTCHAs (unexpected on target sites)', async () => {
    const mockPage = {
      evaluate: vi.fn().mockResolvedValue("recaptcha-v2"),
    } as unknown as Page;

    const result = await detectAndSolveCaptcha(mockPage);
    expect(result).toBe(false); // Visual CAPTCHAs indicate detection failure
  });

  it('handles evaluate throwing during detection phase', async () => {
    const mockPage = {
      evaluate: vi.fn().mockRejectedValueOnce(new Error('Navigation occurred')),
    } as unknown as Page;

    const result = await detectAndSolveCaptcha(mockPage);
    expect(result).toBe(false);
  });

  it('detectCaptchaType returns null when no captcha present', async () => {
    const mockPage = {
      evaluate: vi.fn().mockResolvedValue(null),
    } as unknown as Page;

    const result = await detectCaptchaType(mockPage);
    expect(result).toBe(null);
  });

  it('detectCaptchaType returns recaptcha-v3 for invisible reCAPTCHA', async () => {
    const mockPage = {
      evaluate: vi.fn().mockResolvedValue("recaptcha-v3"),
    } as unknown as Page;

    const result = await detectCaptchaType(mockPage);
    expect(result).toBe("recaptcha-v3");
  });

  it('detectCaptchaType handles evaluate errors gracefully', async () => {
    const mockPage = {
      evaluate: vi.fn().mockRejectedValue(new Error("frame detached")),
    } as unknown as Page;

    const result = await detectCaptchaType(mockPage);
    expect(result).toBe(null);
  });

  it('isReCaptchaV3Only returns true for v3', async () => {
    const mockPage = {
      evaluate: vi.fn().mockResolvedValue("recaptcha-v3"),
    } as unknown as Page;

    const result = await isReCaptchaV3Only(mockPage);
    expect(result).toBe(true);
  });

  it('isReCaptchaV3Only returns false for non-v3 types', async () => {
    const mockPage = {
      evaluate: vi.fn().mockResolvedValue("turnstile"),
    } as unknown as Page;

    const result = await isReCaptchaV3Only(mockPage);
    expect(result).toBe(false);
  });
});
