/**
 * Test 2: DynamicLimit — Concurrency Semaphore Correctness
 *
 * The custom semaphore controlling ALL engine concurrency.
 * A bug here causes deadlocks or runaway concurrency.
 *
 * DynamicLimit is a module-scoped class in engine.ts. We reimplement
 * its exact algorithm here for isolated unit testing.
 */
import { describe, it, expect } from "vitest";

// ── Exact reimplementation of DynamicLimit from engine.ts ──────────────────
class DynamicLimit {
  private active = 0;
  private waiters: Array<() => void> = [];
  private _max: number;
  private log?: (level: "WARN" | "INFO", msg: string) => void;
  private acquiring = false;
  private acquireQueue: Array<() => void> = [];

  constructor(initial: number, log?: (level: "WARN" | "INFO", msg: string) => void) {
    this._max = Math.max(1, initial);
    this.log = log;
  }

  get max(): number { return this._max; }
  get activeCount(): number { return this.active; }

  setMax(n: number): void {
    this._max = Math.max(1, n);
    this.drain();
  }

  private async acquireLock(): Promise<void> {
    if (!this.acquiring) {
      this.acquiring = true;
      return;
    }
    return new Promise<void>((resolve) => {
      this.acquireQueue.push(resolve);
    });
  }

  private releaseLock(): void {
    if (this.acquireQueue.length > 0) {
      const next = this.acquireQueue.shift()!;
      next();
    } else {
      this.acquiring = false;
    }
  }

  async acquire(): Promise<() => void> {
    await this.acquireLock();
    try {
      if (this.active < this._max) {
        this.active++;
        return () => this.release();
      }
      return new Promise<() => void>((resolve) => {
        this.waiters.push(() => {
          this.active++;
          resolve(() => this.release());
        });
      });
    } finally {
      this.releaseLock();
    }
  }

  private release(): void {
    if (this.active <= 0) {
      this.log?.("WARN", "DynamicLimit: release() called with active=0 — ignoring");
      return;
    }
    this.active--;
    this.drain();
  }

  private drain(): void {
    while (this.active < this._max && this.waiters.length > 0) {
      const w = this.waiters.shift()!;
      w();
    }
  }

  shutdown(): void {
    while (this.waiters.length > 0) {
      const w = this.waiters.shift()!;
      w();
    }
  }
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe("DynamicLimit", () => {
  it("acquire() resolves immediately when slots available", async () => {
    const dl = new DynamicLimit(3);
    const release = await dl.acquire();
    expect(dl.activeCount).toBe(1);
    expect(typeof release).toBe("function");
    release();
    expect(dl.activeCount).toBe(0);
  });

  it("acquire() blocks when at capacity, resolves when release() called", async () => {
    const dl = new DynamicLimit(1);
    const release1 = await dl.acquire();
    expect(dl.activeCount).toBe(1);

    let resolved = false;
    const p = dl.acquire().then(r => { resolved = true; return r; });

    // Give microtask a chance to resolve (it shouldn't)
    await new Promise(r => setTimeout(r, 10));
    expect(resolved).toBe(false);

    release1(); // Free the slot
    const release2 = await p;
    expect(resolved).toBe(true);
    expect(dl.activeCount).toBe(1);
    release2();
  });

  it("release() underflow guard does not go negative", () => {
    const warnings: string[] = [];
    const dl = new DynamicLimit(2, (level, msg) => { if (level === "WARN") warnings.push(msg); });
    // Force a release when active=0 (via internal method)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (dl as any).release();
    expect(dl.activeCount).toBe(0); // Should stay at 0, not -1
    expect(warnings.length).toBe(1);
    expect(warnings[0]).toContain("active=0");
  });

  it("setMax() mid-flight drains waiters if new max > active", async () => {
    const dl = new DynamicLimit(1);
    const r1 = await dl.acquire(); // active=1, max=1

    let waiterResolved = false;
    const p = dl.acquire().then(r => { waiterResolved = true; return r; });

    await new Promise(r => setTimeout(r, 10));
    expect(waiterResolved).toBe(false);

    dl.setMax(2); // Now max=2, active=1, should drain 1 waiter
    const r2 = await p;
    expect(waiterResolved).toBe(true);
    expect(dl.activeCount).toBe(2);
    r1();
    r2();
  });

  it("setMax(1) while active=5 doesn't kill active workers", async () => {
    const dl = new DynamicLimit(5);
    const releases: Array<() => void> = [];
    for (let i = 0; i < 5; i++) {
      releases.push(await dl.acquire());
    }
    expect(dl.activeCount).toBe(5);

    dl.setMax(1); // Lower max, but active stays at 5
    expect(dl.activeCount).toBe(5); // Existing workers aren't killed
    expect(dl.max).toBe(1);

    for (const r of releases) r();
    expect(dl.activeCount).toBe(0);
  });

  it("shutdown() resolves blocked waiters in the waiter queue", async () => {
    const dl = new DynamicLimit(1);
    const r1 = await dl.acquire(); // Fill the only slot

    // Queue a single waiter (it enters acquire, gets the lock, and adds itself to waiters)
    let resolved = false;
    const p = dl.acquire().then(r => { resolved = true; return r; });
    
    // Give it time to enter the waiter queue
    await new Promise(r => setTimeout(r, 20));
    expect(resolved).toBe(false);
    
    // shutdown() drains the waiter queue
    dl.shutdown();
    const r2 = await p;
    expect(resolved).toBe(true);
    // Cleanup
    r1();
    r2();
  });

  it("drain() processes waiters in FIFO order", async () => {
    const dl = new DynamicLimit(1);
    const r1 = await dl.acquire();

    const order: number[] = [];
    const p1 = dl.acquire().then(r => { order.push(1); return r; });
    const p2 = dl.acquire().then(r => { order.push(2); return r; });
    const p3 = dl.acquire().then(r => { order.push(3); return r; });

    r1(); // Release → should wake p1
    const rr1 = await p1;
    rr1(); // Release → should wake p2
    const rr2 = await p2;
    rr2(); // Release → should wake p3
    const rr3 = await p3;
    rr3();

    expect(order).toEqual([1, 2, 3]);
  });

  it("active count never exceeds max under 50 concurrent acquires", async () => {
    const dl = new DynamicLimit(3);
    let maxSeen = 0;

    const tasks = Array.from({ length: 50 }, async () => {
      const release = await dl.acquire();
      if (dl.activeCount > maxSeen) maxSeen = dl.activeCount;
      // Simulate brief work
      await new Promise(r => setTimeout(r, 1));
      release();
    });

    await Promise.all(tasks);
    expect(maxSeen).toBeLessThanOrEqual(3);
    expect(dl.activeCount).toBe(0);
  });

  it("minimum max is always 1, even when constructed with 0", () => {
    const dl = new DynamicLimit(0);
    expect(dl.max).toBe(1);
  });
});
