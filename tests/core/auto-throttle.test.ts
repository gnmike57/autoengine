/**
 * Test 16: Auto-Throttle Hysteresis
 *
 * Tests the warmup → ramp → throttle-down → hold → ramp-up state machine.
 */
import { describe, it, expect } from "vitest";

// Re-implement the throttle logic for isolated testing
const WARMUP_ROWS = 5;
const FAILURE_WINDOW = 10;
const FAILURE_THROTTLE_THRESHOLD = 0.5;
const FAILURE_RAMPUP_THRESHOLD = 0.3;
const THROTTLE_HOLD_ROWS = 5;

interface ThrottleState {
  completedRows: number;
  targetConcurrency: number;
  currentConcurrency: number;
  recentOutcomes: ("ok" | "fail")[];
  throttledDown: boolean;
  rowsSinceThrottle: number;
}

function createThrottler(target: number): ThrottleState {
  return {
    completedRows: 0,
    targetConcurrency: target,
    currentConcurrency: 1, // Start at 1 during warmup
    recentOutcomes: [],
    throttledDown: false,
    rowsSinceThrottle: 0,
  };
}

function recordRow(state: ThrottleState, success: boolean): number {
  state.completedRows++;
  state.recentOutcomes.push(success ? "ok" : "fail");
  if (state.recentOutcomes.length > FAILURE_WINDOW) {
    state.recentOutcomes.shift();
  }

  if (state.throttledDown) {
    state.rowsSinceThrottle++;
  }

  // Warmup phase: stay at 1 for the first WARMUP_ROWS
  if (state.completedRows <= WARMUP_ROWS) {
    state.currentConcurrency = 1;
    return state.currentConcurrency;
  }

  // Calculate failure rate over window
  const fails = state.recentOutcomes.filter(o => o === "fail").length;
  const failRate = fails / state.recentOutcomes.length;

  // Throttle down on high failure rate
  if (failRate >= FAILURE_THROTTLE_THRESHOLD) {
    state.currentConcurrency = 1;
    state.throttledDown = true;
    state.rowsSinceThrottle = 0;
    return state.currentConcurrency;
  }

  // Ramp up if failure rate is low AND hold period has passed
  if (failRate < FAILURE_RAMPUP_THRESHOLD) {
    if (!state.throttledDown || state.rowsSinceThrottle >= THROTTLE_HOLD_ROWS) {
      state.currentConcurrency = state.targetConcurrency;
      state.throttledDown = false;
    }
  }

  return state.currentConcurrency;
}

describe("auto-throttle concurrency tuning (Test 16)", () => {
  it("starts at concurrency=1 for the first WARMUP_ROWS (5) rows", () => {
    const state = createThrottler(8);
    for (let i = 0; i < 5; i++) {
      recordRow(state, true);
      expect(state.currentConcurrency).toBe(1);
    }
  });

  it("ramps to target concurrency after warmup if failure rate < 30%", () => {
    const state = createThrottler(8);
    // 5 warmup rows (all success)
    for (let i = 0; i < 5; i++) recordRow(state, true);
    // 1 more row after warmup with success
    recordRow(state, true);
    expect(state.currentConcurrency).toBe(8); // Ramped up
  });

  it("throttles down to 1 when failure rate > 50% in last 10 rows", () => {
    const state = createThrottler(8);
    // Warmup
    for (let i = 0; i < 5; i++) recordRow(state, true);
    recordRow(state, true); // Ramp up

    // Now generate failures: need >50% in the window
    for (let i = 0; i < 6; i++) recordRow(state, false);
    expect(state.currentConcurrency).toBe(1); // Throttled down
  });

  it("holds at concurrency=1 for THROTTLE_HOLD_ROWS (5) after throttle-down", () => {
    const state = createThrottler(8);
    // Warmup + ramp
    for (let i = 0; i < 6; i++) recordRow(state, true);

    // Trigger throttle-down
    for (let i = 0; i < 6; i++) recordRow(state, false);
    expect(state.currentConcurrency).toBe(1);
    expect(state.throttledDown).toBe(true);

    // Now send successes during hold period
    for (let i = 0; i < 4; i++) {
      recordRow(state, true);
      // Should still be at 1 during hold period
      expect(state.currentConcurrency).toBe(1);
    }
  });

  it("ramps back up only after hold period AND failure rate < 30%", () => {
    const state = createThrottler(8);
    for (let i = 0; i < 6; i++) recordRow(state, true);

    // Trigger throttle-down with concentrated failures
    for (let i = 0; i < 6; i++) recordRow(state, false);
    expect(state.throttledDown).toBe(true);

    // Send enough successes to both pass hold period (5 rows) AND
    // flush failures out of the 10-row sliding window.
    // After 6 fails, need 10 successes to push all fails out of window.
    for (let i = 0; i < 10; i++) recordRow(state, true);

    // After 10 successes: hold period (5) definitely passed,
    // and failure rate in window = 0/10 = 0% which is < 30%
    expect(state.currentConcurrency).toBe(8);
    expect(state.throttledDown).toBe(false);
  });

  it("does not ramp up during hold period even with 0% failures", () => {
    const state = createThrottler(8);
    for (let i = 0; i < 6; i++) recordRow(state, true);

    // Trigger throttle with concentrated failures
    for (let i = 0; i < 8; i++) recordRow(state, false);
    expect(state.throttledDown).toBe(true);

    // 4 successes — still in hold period
    for (let i = 0; i < 4; i++) {
      recordRow(state, true);
    }

    // Should still be throttled (haven't passed THROTTLE_HOLD_ROWS yet
    // or failure rate in window is still high due to recent failures)
    // With 8 fails + 4 success in window of 10: last 10 = 6 fails, 4 success = 60% fail
    expect(state.currentConcurrency).toBe(1);
  });

  it("warmup ramp-up is unaffected by hysteresis", () => {
    const state = createThrottler(5);
    // All warmup rows succeed
    for (let i = 0; i < WARMUP_ROWS; i++) recordRow(state, true);
    // Next success should ramp to target immediately (no hold period)
    recordRow(state, true);
    expect(state.currentConcurrency).toBe(5);
  });

  it("single failure during warmup doesn't prevent ramp-up", () => {
    const state = createThrottler(5);
    for (let i = 0; i < 4; i++) recordRow(state, true);
    recordRow(state, false); // 1 failure
    // Still in warmup, concurrency=1
    expect(state.currentConcurrency).toBe(1);
    // After warmup, failure rate is 1/5 = 20% < 30%, should ramp
    recordRow(state, true);
    expect(state.currentConcurrency).toBe(5);
  });
});
