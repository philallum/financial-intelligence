/**
 * Tests for the rate limiter module.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  RateLimiter,
  RateLimitRegistry,
  createDefaultRegistry,
} from '@/services/ingestion/rate-limiter.js';

describe('RateLimiter', () => {
  let limiter: RateLimiter;

  beforeEach(() => {
    limiter = new RateLimiter('test_provider', {
      dailyLimit: 10,
      perMinuteLimit: 3,
    });
  });

  it('allows requests when under limits', () => {
    expect(limiter.canRequest()).toBe(true);
  });

  it('blocks requests when daily limit is reached', () => {
    for (let i = 0; i < 10; i++) {
      limiter.recordRequest();
    }
    expect(limiter.canRequest()).toBe(false);
  });

  it('blocks requests when per-minute limit is reached', () => {
    for (let i = 0; i < 3; i++) {
      limiter.recordRequest();
    }
    expect(limiter.canRequest()).toBe(false);
  });

  it('reports remaining daily requests accurately', () => {
    expect(limiter.getRemainingDaily()).toBe(10);
    limiter.recordRequest();
    expect(limiter.getRemainingDaily()).toBe(9);
  });

  it('reports remaining per-minute requests accurately', () => {
    expect(limiter.getRemainingPerMinute()).toBe(3);
    limiter.recordRequest();
    expect(limiter.getRemainingPerMinute()).toBe(2);
  });

  it('allows requests after minute window expires', () => {
    vi.useFakeTimers();
    const now = Date.now();
    vi.setSystemTime(now);

    for (let i = 0; i < 3; i++) {
      limiter.recordRequest();
    }
    expect(limiter.canRequest()).toBe(false);

    // Advance time past 60 seconds
    vi.setSystemTime(now + 61_000);
    expect(limiter.canRequest()).toBe(true);

    vi.useRealTimers();
  });

  it('resets all counters', () => {
    for (let i = 0; i < 10; i++) {
      limiter.recordRequest();
    }
    expect(limiter.canRequest()).toBe(false);
    limiter.reset();
    expect(limiter.canRequest()).toBe(true);
    expect(limiter.getRemainingDaily()).toBe(10);
  });

  it('returns provider name', () => {
    expect(limiter.getProviderName()).toBe('test_provider');
  });
});

describe('RateLimitRegistry', () => {
  let registry: RateLimitRegistry;

  beforeEach(() => {
    registry = new RateLimitRegistry();
    registry.register('provider_a', { dailyLimit: 5, perMinuteLimit: 2 });
    registry.register('provider_b', { dailyLimit: 100, perMinuteLimit: 10 });
  });

  it('checks request availability per provider', () => {
    expect(registry.canRequest('provider_a')).toBe(true);
    expect(registry.canRequest('provider_b')).toBe(true);
    expect(registry.canRequest('nonexistent')).toBe(false);
  });

  it('tracks requests independently per provider', () => {
    registry.recordRequest('provider_a');
    registry.recordRequest('provider_a');
    // provider_a per-minute limit is 2, should be blocked
    expect(registry.canRequest('provider_a')).toBe(false);
    // provider_b should still be available
    expect(registry.canRequest('provider_b')).toBe(true);
  });

  it('retrieves individual limiter instances', () => {
    const limiter = registry.get('provider_a');
    expect(limiter).toBeDefined();
    expect(limiter?.getProviderName()).toBe('provider_a');
  });

  it('resets all provider limiters', () => {
    registry.recordRequest('provider_a');
    registry.recordRequest('provider_a');
    expect(registry.canRequest('provider_a')).toBe(false);

    registry.resetAll();
    expect(registry.canRequest('provider_a')).toBe(true);
  });
});

describe('createDefaultRegistry', () => {
  it('creates registry with all platform data providers', () => {
    const registry = createDefaultRegistry();

    expect(registry.canRequest('twelve_data')).toBe(true);
    expect(registry.canRequest('alpha_vantage')).toBe(true);
    expect(registry.canRequest('finnhub')).toBe(true);
    expect(registry.canRequest('news_api')).toBe(true);
  });

  it('enforces Twelve Data limits (800/day, 8/min)', () => {
    const registry = createDefaultRegistry();
    const limiter = registry.get('twelve_data')!;

    expect(limiter.getRemainingDaily()).toBe(800);
    expect(limiter.getRemainingPerMinute()).toBe(8);
  });

  it('enforces Alpha Vantage limits (25/day, 5/min)', () => {
    const registry = createDefaultRegistry();
    const limiter = registry.get('alpha_vantage')!;

    expect(limiter.getRemainingDaily()).toBe(25);
    expect(limiter.getRemainingPerMinute()).toBe(5);
  });
});
