import { createLogger } from "./logger.js";

const log = createLogger("NetworkResilience");

export interface ResilienceConfig {
  maxRetries: number;
  baseDelayMs: number;
  maxDelayMs: number;
  circuitBreakerThreshold: number; // e.g., 5 failures
  circuitBreakerCooldownMs: number; // e.g., 60s
  contextName: string;
}

const DEFAULT_CONFIG: ResilienceConfig = {
  maxRetries: 3,
  baseDelayMs: 1000,
  maxDelayMs: 10000,
  circuitBreakerThreshold: 5,
  circuitBreakerCooldownMs: 60000,
  contextName: "NetworkRequest",
};

export class CircuitBreaker {
  private failures = 0;
  private lastFailureTime = 0;
  
  constructor(private config: ResilienceConfig) {}

  public recordFailure(): void {
    this.failures++;
    this.lastFailureTime = Date.now();
  }

  public recordSuccess(): void {
    if (this.failures > 0) {
      log.info(`[${this.config.contextName}] Circuit breaker reset after success.`);
    }
    this.failures = 0;
    this.lastFailureTime = 0;
  }

  public isOpen(): boolean {
    if (this.failures >= this.config.circuitBreakerThreshold) {
      const timeSinceFailure = Date.now() - this.lastFailureTime;
      if (timeSinceFailure < this.config.circuitBreakerCooldownMs) {
        return true;
      }
      // Half-open state: we allow one request through to test
      return false;
    }
    return false;
  }
  
  public getRemainingCooldownSecs(): number {
    if (!this.isOpen()) return 0;
    return Math.ceil((this.config.circuitBreakerCooldownMs - (Date.now() - this.lastFailureTime)) / 1000);
  }
}

// Global registry of circuit breakers by context
const circuitBreakers = new Map<string, CircuitBreaker>();

export async function withResilience<T>(
  action: () => Promise<T>,
  options: Partial<ResilienceConfig> = {}
): Promise<T> {
  const config = { ...DEFAULT_CONFIG, ...options };
  
  let breaker = circuitBreakers.get(config.contextName);
  if (!breaker) {
    breaker = new CircuitBreaker(config);
    circuitBreakers.set(config.contextName, breaker);
  }

  if (breaker.isOpen()) {
    throw new Error(`CircuitBreakerOpen: [${config.contextName}] is open. Cooldown remaining: ${breaker.getRemainingCooldownSecs()}s`);
  }

  let lastError: any;
  
  for (let attempt = 1; attempt <= config.maxRetries; attempt++) {
    try {
      const result = await action();
      breaker.recordSuccess();
      return result;
    } catch (err: any) {
      lastError = err;
      
      // Don't retry if it's explicitly a client error (e.g. 401/403) unless it's a 429
      if (err.status && err.status >= 400 && err.status < 500 && err.status !== 429) {
        breaker.recordFailure();
        throw err;
      }
      
      if (attempt === config.maxRetries) {
        break;
      }

      // Calculate exponential backoff with jitter
      const exponentialDelay = Math.min(config.maxDelayMs, config.baseDelayMs * Math.pow(2, attempt - 1));
      const jitter = Math.random() * 0.3 * exponentialDelay; // 30% jitter
      const delay = exponentialDelay + jitter;
      
      log.warn(`[${config.contextName}] Attempt ${attempt}/${config.maxRetries} failed: ${err.message}. Retrying in ${Math.round(delay)}ms...`);
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }

  breaker.recordFailure();
  log.error(`[${config.contextName}] Failed after ${config.maxRetries} attempts. Error: ${lastError?.message}`);
  throw lastError;
}
