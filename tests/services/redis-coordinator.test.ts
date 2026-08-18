import { describe, it, expect } from "vitest";
import {
  RedisCoordinator,
  getRedisCoordinator,
  _resetRedisCoordinator,
  isRedisConfigured
} from "../../src/services/redis-coordinator.js";

describe("Redis Coordinator", () => {
  it("should initialize with no URL and gracefully fallback all operations", async () => {
    const coordinator = new RedisCoordinator({ url: "" });
    expect(coordinator.isAvailable).toBe(false);

    // Push token without redis should return void without throwing
    await coordinator.pushToken("example.com", "jwt-token", "nonce-1");

    // Pop token should return null
    const token = await coordinator.popToken("example.com");
    expect(token).toBeNull();

    // Get queue depth should return 0
    const depth = await coordinator.getQueueDepth("wk:tokens:example.com");
    expect(depth).toBe(0);

    // Push blacklist vector without error
    await coordinator.pushBlacklistedVector("bad_user_agent_vector");

    // Get blacklist should return empty array
    const list = await coordinator.getBlacklistedVectors();
    expect(list).toEqual([]);
  });

  it("should manage singleton lifecycle", () => {
    _resetRedisCoordinator();
    const inst1 = getRedisCoordinator();
    const inst2 = getRedisCoordinator();
    expect(inst1).toBe(inst2);
    expect(typeof isRedisConfigured()).toBe("boolean");
  });
});
