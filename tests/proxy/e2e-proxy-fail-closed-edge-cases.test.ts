import { describe, it, expect } from "vitest";
import {
  ProxyScoreTracker,
  proxyEntryKey
} from "../../src/proxy/proxy-score-tracker.js";
import { type ProxyEntry } from "../../backends/index.js";

describe("E2E Proxy Fail-Closed Invariants & Reputation Edge Cases", () => {
  it("Invariant: Sticky-residential sessions generate unique proxy keys by server#username", () => {
    const proxy1: ProxyEntry = {
      server: "http://gateway.proxies.io:8000",
      username: "session-abc-1",
      password: "secretPassword",
      protocol: "http"
    };

    const proxy2: ProxyEntry = {
      server: "http://gateway.proxies.io:8000",
      username: "session-xyz-2",
      password: "secretPassword",
      protocol: "http"
    };

    const key1 = proxyEntryKey(proxy1);
    const key2 = proxyEntryKey(proxy2);

    expect(key1).not.toBe(key2);
    expect(key1).toContain("session-abc-1");
    expect(key2).toContain("session-xyz-2");
  });

  it("Edge Case: Quarantine bad proxies after repeated failures without crashing pool selection", () => {
    const tracker = new ProxyScoreTracker({
      minTrials: 3,
      minScore: 0.2
    });

    const goodProxy: ProxyEntry = {
      server: "http://1.1.1.1:8080",
      username: "good-user",
      password: "pwd",
      protocol: "http"
    };

    const badProxy: ProxyEntry = {
      server: "http://2.2.2.2:8080",
      username: "bad-user",
      password: "pwd",
      protocol: "http"
    };

    const goodKey = proxyEntryKey(goodProxy);
    const badKey = proxyEntryKey(badProxy);

    // Record good proxy successes
    tracker.record(goodKey, true, goodProxy.server);
    tracker.record(goodKey, true, goodProxy.server);

    // Record bad proxy failures
    tracker.record(badKey, false, badProxy.server);
    tracker.record(badKey, false, badProxy.server);
    tracker.record(badKey, false, badProxy.server);
    tracker.record(badKey, false, badProxy.server);

    const detailed = tracker.getDetailedScores();
    const badInfo = detailed.find(d => d.key === badKey);
    const goodInfo = detailed.find(d => d.key === goodKey);

    expect(goodInfo?.score).toBeGreaterThan(badInfo?.score ?? 0);
    expect(badInfo?.isJailed).toBe(true);

    // Weighted pick must favor the healthy proxy
    const pool = [goodProxy, badProxy];
    const picked = tracker.weightedPick(pool);
    expect(picked).toBe(goodProxy);
  });

  it("Edge Case: Empty pool returns undefined safely without throwing exceptions", () => {
    const tracker = new ProxyScoreTracker();
    const picked = tracker.weightedPick([]);
    expect(picked).toBeUndefined();
  });
});
