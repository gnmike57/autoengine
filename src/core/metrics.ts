import * as promClient from 'prom-client';

// Initialize the default metrics (CPU, RAM, event loop lag, etc.)
promClient.collectDefaultMetrics({ prefix: 'automati_' });

export const engineRowsProcessed = new promClient.Counter({
  name: 'automati_rows_processed_total',
  help: 'Total number of rows processed by the engine',
  labelNames: ['outcome', 'backend'],
});

export const proxyQuarantineCount = new promClient.Counter({
  name: 'automati_proxy_quarantine_total',
  help: 'Total number of proxy ports quarantined',
  labelNames: ['proxyServer'],
});

export const activeSessions = new promClient.Gauge({
  name: 'automati_active_sessions_current',
  help: 'Current number of active browser sessions in the engine',
  labelNames: ['backend'],
});

export const loginAttemptDuration = new promClient.Histogram({
  name: 'automati_login_attempt_duration_seconds',
  help: 'Duration of a single login attempt (password submission) in seconds',
  labelNames: ['backend', 'site'],
  buckets: [1, 2, 5, 10, 20, 30, 60],
});

export const captchaBypassCount = new promClient.Counter({
  name: 'automati_captcha_bypass_total',
  help: 'Total number of times a captcha was bypassed or ignored',
  labelNames: ['site'],
});

export function getMetricsString(): Promise<string> {
  return promClient.register.metrics();
}
