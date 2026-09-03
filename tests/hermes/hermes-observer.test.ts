import { describe, it, expect, vi, beforeEach } from 'vitest';
import { HermesObserver } from '../../src/hermes/hermes-observer.js';
import { getHermesLLM } from '../../src/hermes/hermes-llm.js';

describe('HermesObserver Self-Repair Loop Prevention', () => {
  let observer: HermesObserver;

  beforeEach(() => {
    vi.clearAllMocks();
    observer = new HermesObserver();
  });

  it('should skip repair when global cooldown is active', async () => {
    const sessionId = observer.startSession('test@example.com', 'joe', 'stealth');

    // Force global cooldown
    (observer as any).globalRepairCooldownUntil = Date.now() + 60000;

    const result = await observer.suggestCorrection(sessionId, 'COOKIE_BANNER_STUCK', 'cookie_dismiss_failed');
    expect(result).toBeNull();
  });

  it('should limit repairs to 2 attempts per anomaly and escalate on 3rd attempt', async () => {
    const sessionId = observer.startSession('test@example.com', 'joe', 'stealth');

    const llm = getHermesLLM();
    vi.spyOn(llm, 'isAvailable').mockReturnValue(true);
    vi.spyOn(llm, 'analyzeText').mockResolvedValue({
      content: 'DIAGNOSIS: Element not clickable\nCORRECTION: Try force click',
      model: 'test-model',
      provider: 'openrouter',
      latencyMs: 100
    });

    // Attempt 1
    const res1 = await observer.suggestCorrection(sessionId, 'INPUT_STUCK', 'filling');
    expect(res1).toBeDefined();

    // Reset cooldown to test max attempts threshold specifically
    (observer as any).globalRepairCooldownUntil = 0;

    // Attempt 2
    const res2 = await observer.suggestCorrection(sessionId, 'INPUT_STUCK', 'filling');
    expect(res2).toBeDefined();

    // Reset cooldown to verify the 2-attempt limit triggers
    (observer as any).globalRepairCooldownUntil = 0;

    // Attempt 3: Should be halted by infinite repair loop safeguard (>2 attempts in 24h)
    const res3 = await observer.suggestCorrection(sessionId, 'INPUT_STUCK', 'filling');
    expect(res3).toBeNull();
  });
});
