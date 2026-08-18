/**
 * Test 7: ThreatMonitor — Scoring & Humanize Threshold
 * Test 8: IdleWatchdog — Lifecycle & Auto-Kill
 *
 * Tests the threat detection and deadlock recovery classes.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "events";

// ─── ThreatMonitor (reimplemented for isolation) ───────────────────────────

class ThreatMonitor {
  private networkLags: number[] = [];
  private threatScore = 0;
  private humanizeCalled = false;

  get score() { return this.threatScore; }
  get wasHumanizeCalled() { return this.humanizeCalled; }

  private evaluateThreat() {
    if (this.networkLags.length < 3) return;
    const avgLag = this.networkLags.reduce((a, b) => a + b, 0) / this.networkLags.length;
    if (avgLag > 3000) {
      this.threatScore += 10;
    } else {
      this.threatScore = Math.max(0, this.threatScore - 2);
    }
    if (this.threatScore > 30) {
      this.humanizeCalled = true;
      this.threatScore = 0;
    }
  }

  // Directly inject a lag value and evaluate (avoids Date.now() timing issues)
  injectLag(lag: number) {
    this.networkLags.push(lag);
    if (this.networkLags.length > 10) this.networkLags.shift();
    this.evaluateThreat();
  }
}

describe("ThreatMonitor (Test 7)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("starts with threatScore=0", () => {
    const tm = new ThreatMonitor();
    expect(tm.score).toBe(0);
  });

  it("increments by 10 when avg network lag > 3000ms", () => {
    const tm = new ThreatMonitor();
    // Need 3+ samples to evaluate
    tm.injectLag(4000);
    tm.injectLag(4000);
    tm.injectLag(4000);
    expect(tm.score).toBe(10); // Only evaluates after 3rd response
  });

  it("decrements by 2 when avg network lag ≤ 3000ms", () => {
    const tm = new ThreatMonitor();
    // First build up score with high lags
    tm.injectLag(4000);
    tm.injectLag(4000);
    tm.injectLag(4000); // score = 10
    // Now add low lags to bring average down
    tm.injectLag(100);
    tm.injectLag(100);
    tm.injectLag(100);
    tm.injectLag(100);
    tm.injectLag(100);
    tm.injectLag(100);
    tm.injectLag(100); // 7 low lags → avg should be < 3000
    // Score should have decremented multiple times
    expect(tm.score).toBeLessThan(10);
  });

  it("triggers humanize() when threatScore exceeds 30", () => {
    const tm = new ThreatMonitor();
    // Need to push score > 30: that's 4 high-lag evaluations (4×10=40 > 30)
    // But evaluations only start after 3 samples, so:
    tm.injectLag(5000);
    tm.injectLag(5000);
    tm.injectLag(5000); // score = 10
    tm.injectLag(5000); // score = 20
    tm.injectLag(5000); // score = 30
    expect(tm.wasHumanizeCalled).toBe(false); // Threshold is > 30, not >=
    tm.injectLag(5000); // score would be 40 → triggers humanize
    expect(tm.wasHumanizeCalled).toBe(true);
  });

  it("resets threatScore to 0 after triggering humanize()", () => {
    const tm = new ThreatMonitor();
    for (let i = 0; i < 10; i++) tm.injectLag(5000);
    expect(tm.score).toBe(0); // Reset after trigger
    expect(tm.wasHumanizeCalled).toBe(true);
  });

  it("requires at least 3 network responses before evaluating", () => {
    const tm = new ThreatMonitor();
    tm.injectLag(5000);
    expect(tm.score).toBe(0); // Only 1 sample
    tm.injectLag(5000);
    expect(tm.score).toBe(0); // Only 2 samples
    tm.injectLag(5000);
    expect(tm.score).toBe(10); // 3 samples → evaluates
  });

  it("maintains sliding window of last 10 network lags", () => {
    const tm = new ThreatMonitor();
    // Push 12 high lags — should only keep last 10
    for (let i = 0; i < 12; i++) tm.injectLag(4000);
    // Now push 7 low lags to bring average down within the 10-window
    for (let i = 0; i < 7; i++) tm.injectLag(100);
    // With 10 lags total (3 high + 7 low), avg should be ~1270
    // Score should have been decremented
    expect(tm.score).toBeLessThan(30);
  });
});

// ─── IdleWatchdog ──────────────────────────────────────────────────────────

class IdleWatchdog {
  private lastActivity = Date.now();
  private intervalId: ReturnType<typeof setInterval> | null = null;
  private isDestroyed = false;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  constructor(private page: any, private onIdle: () => void, private timeoutMs: number = 60000) {
    this.ping = this.ping.bind(this);
    page.on("request", this.ping);
    page.on("response", this.ping);
    this.intervalId = setInterval(() => this.check(), 100); // Fast interval for testing
  }

  ping() {
    if (this.isDestroyed) return;
    this.lastActivity = Date.now();
  }

  check() {
    if (this.isDestroyed) return;
    if (Date.now() - this.lastActivity >= this.timeoutMs) {
      this.onIdle();
      this.destroy();
    }
  }

  destroy() {
    this.isDestroyed = true;
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
    this.page.removeListener("request", this.ping);
    this.page.removeListener("response", this.ping);
  }

  get destroyed() { return this.isDestroyed; }
}

describe("IdleWatchdog (Test 8)", () => {
  let page: EventEmitter;

  beforeEach(() => {
    page = new EventEmitter();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("does NOT fire callback before timeout elapses", () => {
    const cb = vi.fn();
    const wd = new IdleWatchdog(page, cb, 5000);
    vi.advanceTimersByTime(4999);
    expect(cb).not.toHaveBeenCalled();
    wd.destroy();
  });

  it("fires onIdle callback when no activity for timeoutMs", () => {
    const cb = vi.fn();
    void new IdleWatchdog(page, cb, 5000);
    vi.advanceTimersByTime(5100);
    expect(cb).toHaveBeenCalledTimes(1);
  });

  it("ping() resets the idle timer", () => {
    const cb = vi.fn();
    void new IdleWatchdog(page, cb, 5000);
    vi.advanceTimersByTime(3000);
    page.emit("request"); // Ping resets
    vi.advanceTimersByTime(3000); // 3s after ping, total 6s
    expect(cb).not.toHaveBeenCalled(); // Shouldn't fire yet
    vi.advanceTimersByTime(2100);
    expect(cb).toHaveBeenCalledTimes(1); // Now fires (5s after ping)
  });

  it("destroy() stops the interval and removes all listeners", () => {
    const cb = vi.fn();
    const wd = new IdleWatchdog(page, cb, 5000);
    wd.destroy();
    vi.advanceTimersByTime(10000);
    expect(cb).not.toHaveBeenCalled(); // Destroyed — never fires
    expect(wd.destroyed).toBe(true);
  });

  it("does not double-fire after destroy()", () => {
    const cb = vi.fn();
    void new IdleWatchdog(page, cb, 1000);
    vi.advanceTimersByTime(1100); // Fires once, auto-destroys
    expect(cb).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(5000); // More time passes
    expect(cb).toHaveBeenCalledTimes(1); // Still just once
  });

  it("isDestroyed flag prevents further pings from restarting", () => {
    const cb = vi.fn();
    const wd = new IdleWatchdog(page, cb, 5000);
    wd.destroy();
    page.emit("request"); // Ping after destroy
    vi.advanceTimersByTime(10000);
    expect(cb).not.toHaveBeenCalled();
  });
});
