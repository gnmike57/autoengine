import { expect, test, describe, vi, beforeEach, afterEach } from 'vitest';
import { healSelector } from '../../src/hermes/dom-healer.js';
import { Page } from 'playwright-core';

// Mock the actual module used by dom-healer
vi.mock("../../src/core/ollama-client.js", () => ({
  askLlama: vi.fn(),
}));

describe('healSelector', () => {
  let mockPage: unknown;
  let mockContext: unknown;
  let mockCDP: unknown;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let ollamaClient: any;

  beforeEach(async () => {
    vi.clearAllMocks();

    ollamaClient = await import("../../src/core/ollama-client.js");

    mockCDP = {
      send: vi.fn().mockResolvedValue({
        result: { value: JSON.stringify({ tag: 'button', id: 'new-login' }) }
      }),
      detach: vi.fn().mockResolvedValue(undefined)
    };

    mockContext = {
      newCDPSession: vi.fn().mockResolvedValue(mockCDP)
    };

    mockPage = {
      context: vi.fn().mockReturnValue(mockContext),
      evaluate: vi.fn().mockResolvedValue({ tag: 'button', id: 'new-login' })
    };
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  test('should fallback to null if askLlama throws', async () => {
    vi.mocked(ollamaClient.askLlama).mockRejectedValue(new Error("Connection refused"));
    const result = await healSelector(mockPage as Page, 'Login Button');
    expect(result).toBeNull();
  });

  test('should use askLlama and return healed selector', async () => {
    vi.mocked(ollamaClient.askLlama).mockResolvedValue('#new-login');

    const result = await healSelector(mockPage as Page, 'Login Button');

    expect(result).toBe('#new-login');
    expect(ollamaClient.askLlama).toHaveBeenCalled();

    // Verify the prompt contains the target description and DOM data
    const promptArg = vi.mocked(ollamaClient.askLlama).mock.calls[0]![0] as string;
    expect(promptArg).toContain('new-login');
  });

  test('should return null if AI returns NULL', async () => {
    vi.mocked(ollamaClient.askLlama).mockResolvedValue('NULL');

    const result = await healSelector(mockPage as Page, 'Ghost Button');
    expect(result).toBeNull();
  });
});
