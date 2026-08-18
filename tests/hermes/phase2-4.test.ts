import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { scanForRequeue } from '../../src/hermes/batch-requeuer.js';
import { StrategyEngine } from '../../src/hermes/strategy-engine.js';
import { OutcomeTracker } from '../../src/hermes/outcome-tracker.js';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';

describe('Hermes Phase 2-4 Unit Tests', () => {
  const TEST_DB_PATH = path.join(process.cwd(), 'test-automation.db');

  beforeEach(() => {
    // Setup test DB for batch requeuer
    const db = new Database(TEST_DB_PATH);
    db.exec(`
      DROP TABLE IF EXISTS credentials;
      CREATE TABLE IF NOT EXISTS credentials (
        email TEXT PRIMARY KEY,
        passwords TEXT,
        outcome TEXT,
        last_tested_at TEXT,
        retry_count INTEGER DEFAULT 0
      )
    `);
    
    // Seed some data
    const insert = db.prepare('INSERT INTO credentials (email, passwords, outcome, last_tested_at, retry_count) VALUES (?, ?, ?, ?, ?)');
    insert.run('term1@test.com', '["p1"]', 'success', new Date().toISOString(), 0); // Terminal
    insert.run('requeue1@test.com', '["p2"]', 'error', new Date(Date.now() - 3600000).toISOString(), 1); // Should requeue
    insert.run('cooldown@test.com', '["p3"]', 'api-error', new Date(Date.now() - 10000).toISOString(), 1); // Should skip (cooldown)
    insert.run('untested@test.com', '["p4"]', null, null, 0); // Should requeue
    db.close();
  });

  afterEach(() => {
    if (fs.existsSync(TEST_DB_PATH)) fs.unlinkSync(TEST_DB_PATH);
    if (fs.existsSync(TEST_DB_PATH + '-wal')) fs.unlinkSync(TEST_DB_PATH + '-wal');
    if (fs.existsSync(TEST_DB_PATH + '-shm')) fs.unlinkSync(TEST_DB_PATH + '-shm');
  });

  describe('Batch Requeuer', () => {
    it('should correctly identify eligible credentials and skip terminal/cooldown', () => {
      const result = scanForRequeue({ dbPath: TEST_DB_PATH });
      expect(result.totalScanned).toBe(4);
      expect(result.terminalCount).toBe(1);
      expect(result.cooldownCount).toBe(1);
      expect(result.credentials.length).toBe(2);
      
      const emails = result.credentials.map(c => c.email);
      expect(emails).toContain('requeue1@test.com');
      expect(emails).toContain('untested@test.com');
    });
  });

  describe('Strategy Engine (UCB1)', () => {
    it('should select untested backends first (Exploration)', () => {
      const engine = new StrategyEngine({ availableBackends: ['stealth', 'zendriver'] });
      
      const plan = engine.plan();
      // Since both are 0, it will pick the first one with Infinity score
      expect(plan.backend).toBe('stealth');
    });

    it('should balance exploration and exploitation using UCB1', () => {
      const engine = new StrategyEngine({ availableBackends: ['stealth', 'zendriver'] });
      
      // Simulate zendriver having a few tests with 100% success
      engine.recordBatch({ backend: 'zendriver', proxyPool: 'off', concurrency: 1, total: 3, successes: 3, blocks: 0, errors: 0, noaccount: 0, durationMs: 1000, successRate: 100 });
      
      // Since stealth is untested, its UCB1 score is Infinity, so it should be picked for exploration
      const plan1 = engine.plan();
      expect(plan1.backend).toBe('stealth');
      
      // Give stealth some terrible results
      engine.recordBatch({ backend: 'stealth', proxyPool: 'off', concurrency: 1, total: 10, successes: 1, blocks: 0, errors: 9, noaccount: 0, durationMs: 1000, successRate: 10 });
      
      // Now zendriver should have a higher score
      const plan2 = engine.plan();
      expect(plan2.backend).toBe('zendriver');
    });
  });

  describe('Outcome Tracker', () => {
    it('should track outcomes and trigger alerts on thresholds', () => {
      const alertCallback = vi.fn();
      const tracker = new OutcomeTracker({ successRateThreshold: 50, blockRateThreshold: 20, onAlert: alertCallback });
      
      // Add 5 successes
      for (let i = 0; i < 5; i++) tracker.record('success', 'stealth', 'off');
      expect(alertCallback).not.toHaveBeenCalled();
      
      // Add 10 blocks to trigger low success and high block rate
      for (let i = 0; i < 10; i++) tracker.record('blocked', 'stealth', 'off');
      
      // Should have triggered alert on the 5th total (or later) when block > 20%
      expect(alertCallback).toHaveBeenCalled();
      
      const snapshot = tracker.getSnapshot('5min');
      expect(snapshot).not.toBeNull();
      expect(snapshot?.total).toBe(15);
      expect(snapshot?.successes).toBe(5);
      expect(snapshot?.failures).toBe(10);
      expect(snapshot?.blockRate).toBeGreaterThan(60);
    });
  });
});
