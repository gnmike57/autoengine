import { describe, it, expect } from 'vitest';
import { browserWarmer, BrowserWarmer } from '../../src/services/browser-warmer.js';

describe('browser-warmer', () => {
  it('start() does not throw and acts as a safe no-op', () => {
    expect(() => browserWarmer.start()).not.toThrow();
  });

  it('stop() does not throw and acts as a safe no-op', () => {
    expect(() => browserWarmer.stop()).not.toThrow();
  });

  it('consumeWarmedProfile() always returns null', () => {
    expect(browserWarmer.consumeWarmedProfile('any-session')).toBeNull();
  });

  it('class can be instantiated directly', () => {
    const warmer = new BrowserWarmer();
    expect(() => warmer.start()).not.toThrow();
    expect(warmer.consumeWarmedProfile('test')).toBeNull();
    expect(() => warmer.stop()).not.toThrow();
  });
});
