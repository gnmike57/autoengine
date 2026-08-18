import { expect, test, describe, vi, beforeEach, afterEach } from 'vitest';
import { verifyLoginSuccessVisually } from '../../src/hermes/visual-verifier.js';
import { Page } from 'playwright-core';

describe('verifyLoginSuccessVisually', () => {
  let mockPage: unknown;
  let mockContext: unknown;
  let mockCDP: unknown;

  beforeEach(() => {
    vi.clearAllMocks();
    process.env.DISABLE_VISUAL_VERIFICATION = 'false';

    mockCDP = {
      send: vi.fn().mockResolvedValue({ data: 'mock_base64_image' }),
      detach: vi.fn().mockResolvedValue(undefined)
    };

    mockContext = {
      newCDPSession: vi.fn().mockResolvedValue(mockCDP)
    };

    mockPage = {
      context: vi.fn().mockReturnValue(mockContext),
      screenshot: vi.fn().mockResolvedValue(Buffer.from('mock_base64_image'))
    };
  });

  afterEach(() => {
    delete process.env.DISABLE_VISUAL_VERIFICATION;
  });

  test('should fallback to true if DISABLE_VISUAL_VERIFICATION is true', async () => {
    process.env.DISABLE_VISUAL_VERIFICATION = 'true';
    const result = await verifyLoginSuccessVisually(mockPage as Page);
    expect(result).toBe(true);
  });

  test('should construct correct local server payload and return true on YES', async () => {
    const fetchSpy = vi.spyOn(global, 'fetch').mockImplementation(() => 
      Promise.resolve({
        json: () => Promise.resolve({ choices: [{ message: { content: 'YES' } }] })
      } as Response)
    );

    const result = await verifyLoginSuccessVisually(mockPage as Page);
    
    expect(result).toBe(true);
    expect(fetchSpy).toHaveBeenCalled();
    
    const fetchArgs = fetchSpy.mock.calls[0]!;
    expect(fetchArgs[0]).toBe('http://127.0.0.1:8080/v1/chat/completions');
    
    const req = fetchArgs[1] as RequestInit;
    expect(req.method).toBe('POST');
    expect((req.headers as any)['Authorization']).toBe('Bearer local-dummy-key');
    
    const body = JSON.parse(req.body as string);
    expect(body.model).toBe('minicpm-v-2_6-local');
    expect(body.messages[0].content[1].image_url.url).toBe('data:image/jpeg;base64,mock_base64_image');

    fetchSpy.mockRestore();
  });

  test('should return false if AI rejects success', async () => {
    const fetchSpy = vi.spyOn(global, 'fetch').mockImplementation(() => 
      Promise.resolve({
        json: () => Promise.resolve({ choices: [{ message: { content: 'NO' } }] })
      } as Response)
    );

    const result = await verifyLoginSuccessVisually(mockPage as Page);
    expect(result).toBe(false);

    fetchSpy.mockRestore();
  });
});
