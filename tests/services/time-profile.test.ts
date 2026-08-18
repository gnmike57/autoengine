import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { getTimeOfDayMultiplier, getTimeOfDaySloppiness } from '../../src/services/time-profile.js';

describe('time-profile', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  // Helper to set specific hour
  const setHour = (hour: number) => {
    const date = new Date();
    date.setHours(hour, 0, 0, 0);
    vi.setSystemTime(date);
  };

  describe('getTimeOfDayMultiplier', () => {
    it('returns slower multiplier at night (1-5 AM)', () => {
      setHour(3);
      const val = getTimeOfDayMultiplier();
      expect(val).toBeGreaterThanOrEqual(1.15);
      expect(val).toBeLessThanOrEqual(1.7);
    });

    it('returns early morning multiplier (6-8 AM)', () => {
      setHour(7);
      const val = getTimeOfDayMultiplier();
      expect(val).toBeGreaterThanOrEqual(0.95);
      expect(val).toBeLessThanOrEqual(1.25);
    });

    it('returns peak focus multiplier (9-12 AM)', () => {
      setHour(10);
      const val = getTimeOfDayMultiplier();
      expect(val).toBeGreaterThanOrEqual(0.75);
      expect(val).toBeLessThanOrEqual(1.05);
    });

    it('returns post-lunch multiplier (13-14 PM)', () => {
      setHour(13);
      const val = getTimeOfDayMultiplier();
      expect(val).toBeGreaterThanOrEqual(0.92);
      expect(val).toBeLessThanOrEqual(1.2);
    });

    it('returns afternoon focus multiplier (15-17 PM)', () => {
      setHour(16);
      const val = getTimeOfDayMultiplier();
      expect(val).toBeGreaterThanOrEqual(0.8);
      expect(val).toBeLessThanOrEqual(1.05);
    });

    it('returns evening multiplier (18-21 PM)', () => {
      setHour(19);
      const val = getTimeOfDayMultiplier();
      expect(val).toBeGreaterThanOrEqual(0.9);
      expect(val).toBeLessThanOrEqual(1.2);
    });

    it('returns late night multiplier (22-0 AM)', () => {
      setHour(23);
      const val = getTimeOfDayMultiplier();
      expect(val).toBeGreaterThanOrEqual(1.05);
      expect(val).toBeLessThanOrEqual(1.5);
    });
    
    it('handles hour 0 correctly', () => {
      setHour(0);
      const val = getTimeOfDayMultiplier();
      expect(val).toBeGreaterThanOrEqual(1.05);
      expect(val).toBeLessThanOrEqual(1.5);
    });

    it('returns fallback multiplier for invalid hours', () => {
      const originalGetHours = Date.prototype.getHours;
      Date.prototype.getHours = vi.fn().mockReturnValue(-1);
      const val = getTimeOfDayMultiplier();
      expect(val).toBeGreaterThanOrEqual(0.8);
      expect(val).toBeLessThanOrEqual(1.2);
      Date.prototype.getHours = originalGetHours;
    });
  });

  describe('getTimeOfDaySloppiness', () => {
    it('returns high sloppiness at night (1-5 AM)', () => {
      setHour(3);
      const val = getTimeOfDaySloppiness();
      expect(val).toBeGreaterThanOrEqual(0.3);
      expect(val).toBeLessThanOrEqual(0.85);
    });

    it('returns low sloppiness during peak focus (9-12 AM)', () => {
      setHour(10);
      const val = getTimeOfDaySloppiness();
      expect(val).toBeGreaterThanOrEqual(0.02);
      expect(val).toBeLessThanOrEqual(0.35);
    });

    it('returns moderate sloppiness late night (22-0 AM)', () => {
      setHour(23);
      const val = getTimeOfDaySloppiness();
      expect(val).toBeGreaterThanOrEqual(0.15);
      expect(val).toBeLessThanOrEqual(0.65);
    });
    
    it('handles hour 0 correctly', () => {
      setHour(0);
      const val = getTimeOfDaySloppiness();
      expect(val).toBeGreaterThanOrEqual(0.15);
      expect(val).toBeLessThanOrEqual(0.65);
    });

    it('returns default moderate sloppiness other times (e.g. 15 PM)', () => {
      setHour(15);
      const val = getTimeOfDaySloppiness();
      expect(val).toBeGreaterThanOrEqual(0.05);
      expect(val).toBeLessThanOrEqual(0.45);
    });
  });
});
