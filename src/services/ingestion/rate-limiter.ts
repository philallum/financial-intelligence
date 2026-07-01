/**
 * Per-provider, per-cycle rate limit tracker for the Financial Intelligence Platform.
 *
 * Tracks API call counts against configured limits (daily + per-minute) and
 * prevents over-usage within a single ingestion cycle.
 */

export interface RateLimitConfig {
  /** Maximum requests per day */
  dailyLimit: number;
  /** Maximum requests per minute */
  perMinuteLimit: number;
}

export interface RateLimitState {
  /** Requests made in the current day (resets at midnight UTC) */
  dailyCount: number;
  /** Timestamp of the last daily counter reset */
  dailyResetAt: number;
  /** Timestamps of requests in the current sliding minute window */
  minuteWindow: number[];
}

export class RateLimiter {
  private readonly config: RateLimitConfig;
  private state: RateLimitState;
  private readonly providerName: string;

  constructor(providerName: string, config: RateLimitConfig) {
    this.providerName = providerName;
    this.config = config;
    this.state = {
      dailyCount: 0,
      dailyResetAt: this.getStartOfDayUTC(),
      minuteWindow: [],
    };
  }

  /**
   * Check whether a request can be made without exceeding limits.
   */
  canRequest(): boolean {
    this.pruneState();
    return (
      this.state.dailyCount < this.config.dailyLimit &&
      this.state.minuteWindow.length < this.config.perMinuteLimit
    );
  }

  /**
   * Record a request being made. Call this after a successful API call.
   */
  recordRequest(): void {
    this.pruneState();
    const now = Date.now();
    this.state.dailyCount++;
    this.state.minuteWindow.push(now);
  }

  /**
   * Get remaining daily requests.
   */
  getRemainingDaily(): number {
    this.pruneState();
    return Math.max(0, this.config.dailyLimit - this.state.dailyCount);
  }

  /**
   * Get remaining per-minute requests.
   */
  getRemainingPerMinute(): number {
    this.pruneState();
    return Math.max(0, this.config.perMinuteLimit - this.state.minuteWindow.length);
  }

  /**
   * Get the provider name this limiter tracks.
   */
  getProviderName(): string {
    return this.providerName;
  }

  /**
   * Reset all counters (useful for testing or forced resets).
   */
  reset(): void {
    this.state = {
      dailyCount: 0,
      dailyResetAt: this.getStartOfDayUTC(),
      minuteWindow: [],
    };
  }

  /**
   * Prune expired entries from the minute window and reset daily if needed.
   */
  private pruneState(): void {
    const now = Date.now();
    const startOfDay = this.getStartOfDayUTC();

    // Reset daily counter if we've crossed into a new UTC day
    if (startOfDay > this.state.dailyResetAt) {
      this.state.dailyCount = 0;
      this.state.dailyResetAt = startOfDay;
    }

    // Remove entries older than 60 seconds from minute window
    const oneMinuteAgo = now - 60_000;
    this.state.minuteWindow = this.state.minuteWindow.filter(
      (ts) => ts > oneMinuteAgo
    );
  }

  private getStartOfDayUTC(): number {
    const now = new Date();
    return Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  }
}

/**
 * Registry of rate limiters per provider. Singleton per ingestion service instance.
 */
export class RateLimitRegistry {
  private readonly limiters: Map<string, RateLimiter> = new Map();

  register(providerName: string, config: RateLimitConfig): void {
    this.limiters.set(providerName, new RateLimiter(providerName, config));
  }

  get(providerName: string): RateLimiter | undefined {
    return this.limiters.get(providerName);
  }

  canRequest(providerName: string): boolean {
    const limiter = this.limiters.get(providerName);
    if (!limiter) return false;
    return limiter.canRequest();
  }

  recordRequest(providerName: string): void {
    const limiter = this.limiters.get(providerName);
    limiter?.recordRequest();
  }

  resetAll(): void {
    for (const limiter of this.limiters.values()) {
      limiter.reset();
    }
  }
}

/**
 * Creates a pre-configured rate limit registry for all data providers.
 */
export function createDefaultRegistry(): RateLimitRegistry {
  const registry = new RateLimitRegistry();

  registry.register('twelve_data', { dailyLimit: 800, perMinuteLimit: 8 });
  registry.register('alpha_vantage', { dailyLimit: 25, perMinuteLimit: 5 });
  registry.register('finnhub', { dailyLimit: Infinity, perMinuteLimit: 60 });
  registry.register('news_api', { dailyLimit: 100, perMinuteLimit: Infinity });

  return registry;
}
