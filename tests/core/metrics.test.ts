import { describe, it, expect } from 'vitest';
import * as promClient from 'prom-client';
import {
  getMetricsString,
  engineRowsProcessed,
  proxyQuarantineCount,
  activeSessions,
  loginAttemptDuration,
  captchaBypassCount
} from '../../src/core/metrics.js';

describe('metrics', () => {
  it('registers all exported metrics', () => {
    expect(engineRowsProcessed).toBeInstanceOf(promClient.Counter);
    expect(proxyQuarantineCount).toBeInstanceOf(promClient.Counter);
    expect(activeSessions).toBeInstanceOf(promClient.Gauge);
    expect(loginAttemptDuration).toBeInstanceOf(promClient.Histogram);
    expect(captchaBypassCount).toBeInstanceOf(promClient.Counter);
  });

  it('getMetricsString() returns a valid prometheus payload containing the automati_ prefix', async () => {
    // Increment a metric to ensure it appears in the output
    engineRowsProcessed.inc({ outcome: 'success', backend: 'test' });
    
    const metricsString = await getMetricsString();
    
    expect(typeof metricsString).toBe('string');
    expect(metricsString.length).toBeGreaterThan(0);
    // It should contain the default metrics prefix and the manually registered ones
    expect(metricsString).toContain('automati_rows_processed_total');
    expect(metricsString).toContain('automati_proxy_quarantine_total');
  });
});
