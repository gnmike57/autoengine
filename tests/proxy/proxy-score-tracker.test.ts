import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { ProxyScoreTracker, proxyEntryKey } from "../../src/proxy/proxy-score-tracker.js";

describe("ProxyScoreTracker", () => {
  let tracker: ProxyScoreTracker;
  const p1 = { server: "proxy1.com", port: 8080 };
  const p2 = { server: "proxy2.com", port: 8080 };

  beforeEach(() => {
    vi.useFakeTimers();
    tracker = new ProxyScoreTracker({ minScore: 0.2, minTrials: 3 });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("favors successful proxies over failed ones", () => {
    const key1 = proxyEntryKey(p1);
    const key2 = proxyEntryKey(p2);

    // p1 has successes, p2 has failures
    tracker.record(key1, true);
    tracker.record(key1, true);
    tracker.record(key2, false);
    tracker.record(key2, false);

    const scores = tracker.getDetailedScores();
    const s1 = scores.find(s => s.key === key1);
    const s2 = scores.find(s => s.key === key2);

    expect(s1!.score).toBeGreaterThan(s2!.score);

    // With 100 picks, p1 should be picked overwhelmingly more often
    let p1Picks = 0;
    for (let i = 0; i < 100; i++) {
      const pick = tracker.weightedPick([p1, p2]);
      if (proxyEntryKey(pick!) === key1) p1Picks++;
    }
    expect(p1Picks).toBeGreaterThan(80);
  });

  it("quarantines failing proxies when trials >= minTrials and score < minScore", () => {
    const key1 = proxyEntryKey(p1);
    
    // 3 fails -> score is 0/(0+3+1) = 0
    tracker.record(key1, false);
    tracker.record(key1, false);
    tracker.record(key1, false);

    const pick = tracker.weightedPick([p1, p2]);
    expect(proxyEntryKey(pick!)).toBe(proxyEntryKey(p2)); // p1 is quarantined, should always pick p2
  });

  it("temporarily bans patterns via banPattern", () => {
    tracker.banPattern(/proxy1/, 5000); // Ban proxy1.com for 5 seconds
    
    // Pick should never be p1 while banned
    let p2Picks = 0;
    for (let i = 0; i < 10; i++) {
      const pick = tracker.weightedPick([p1, p2]);
      if (proxyEntryKey(pick!) === proxyEntryKey(p2)) p2Picks++;
    }
    expect(p2Picks).toBe(10);

    // Fast forward 6 seconds
    vi.advanceTimersByTime(6000);

    // Ban lifted, now p1 and p2 should have equal chance
    let p1Picks = 0;
    for (let i = 0; i < 100; i++) {
      const pick = tracker.weightedPick([p1, p2]);
      if (proxyEntryKey(pick!) === proxyEntryKey(p1)) p1Picks++;
    }
    expect(p1Picks).toBeGreaterThan(10);
  });

  it("excludes specific proxies if passed in exclude list", () => {
    const key1 = proxyEntryKey(p1);
    const pick = tracker.weightedPick([p1, p2], [key1]);
    expect(proxyEntryKey(pick!)).toBe(proxyEntryKey(p2));
  });

  it("decays older scores over time", () => {
    const key1 = proxyEntryKey(p1);
    tracker.record(key1, true); // 1 success
    
    const initialScore = tracker.getDetailedScores().find(s => s.key === key1)!.score;
    
    // Advance 2 hours (half-life)
    vi.advanceTimersByTime(2 * 60 * 60 * 1000);
    
    const decayedScore = tracker.getDetailedScores().find(s => s.key === key1)!.score;
    expect(decayedScore).toBeLessThan(initialScore);
  });

  it("respects LRU eviction for maxEntries limit", () => {
    const smallTracker = new ProxyScoreTracker({ maxEntries: 2 });
    smallTracker.record("key1", true);
    smallTracker.record("key2", true);
    smallTracker.record("key3", true); // Should evict key1
    
    const scores = smallTracker.getDetailedScores();
    expect(scores.length).toBe(2);
    expect(scores.find(s => s.key === "key1")).toBeUndefined();
    expect(scores.find(s => s.key === "key2")).toBeDefined();
    expect(scores.find(s => s.key === "key3")).toBeDefined();
  });
});
