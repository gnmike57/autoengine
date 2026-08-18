import { describe, it, expect, vi, afterEach } from "vitest";
import { NativePoWPool } from "../../src/services/pow-pool.js";

describe("Native PoW Pool", () => {
  let pool: NativePoWPool;

  afterEach(() => {
    if (pool) pool.close();
  });

  it("should initialize with custom worker count", () => {
    pool = new NativePoWPool(4);
    expect(pool).toBeInstanceOf(NativePoWPool);
  });

  it("should reject pending tasks when pool is closed", async () => {
    pool = new NativePoWPool(2);
    const solvePromise = pool.solve("fake.jwt.token", 10);
    pool.close();

    await expect(solvePromise).rejects.toThrow("PoW Pool closed");
  });
});
