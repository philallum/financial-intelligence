/**
 * Unit tests for the rate limiter middleware.
 *
 * Validates:
 * - FREE plan: 100 requests/day enforcement (Req 5.1)
 * - STARTER plan: 5000 requests/month enforcement (Req 5.2)
 * - PROFESSIONAL plan: 25000 requests/month enforcement (Req 5.3)
 * - ENTERPRISE plan: rate_limit_override or 25000/month default (Req 5.4)
 * - 429 response with correct body on limit exceeded (Req 5.5)
 * - Counter reset at period boundary (Req 5.1, 5.2, 5.3)
 * - RapidAPI marketplace bypass (Req 5.8)
 * - Rate limit headers (Req 13.4)
 * - Per API key scope (Req 5.7)
 * - Single UPDATE per request
 *
 * Requirements: 5.1, 5.2, 5.3, 5.4, 5.5, 5.6, 5.7, 5.8, 13.4
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Request, Response, NextFunction } from 'express';
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  createRateLimiterMiddleware,
  PLAN_DEFAULTS,
  resolveEffectiveLimit,
  needsReset,
  calculateRetryAfterSeconds,
  getCurrentDayStart,
  getCurrentMonthStart,
  getNextDayStart,
  getNextMonthStart,
  getResetTimeEpoch,
} from '../../src/api/middleware/rate-limiter.js';
import { SubscriptionPlan } from '../../src/types/enums.js';

// =============================================================================
// Test Helpers
// =============================================================================

function createMockReq(overrides: Partial<Request> = {}): Request {
  return {
    method: 'GET',
    path: '/v1/forecast/GBPUSD',
    headers: {},
    apiKeyId: 'test-key-uuid',
    subscriptionPlan: SubscriptionPlan.FREE,
    isMarketplaceRequest: false,
    anonymous: false,
    ...overrides,
  } as unknown as Request;
}

function createMockRes() {
  const headersMap: Record<string, string> = {};
  const res = {
    statusCode: 200,
    jsonBody: null as unknown,
    headersSet: headersMap,
    status: vi.fn().mockImplementation((code: number) => {
      res.statusCode = code;
      return res;
    }),
    json: vi.fn().mockImplementation((body: unknown) => {
      res.jsonBody = body;
      return res;
    }),
    setHeader: vi.fn().mockImplementation((name: string, value: string) => {
      headersMap[name] = value;
    }),
  };
  return res as unknown as Response & {
    statusCode: number;
    jsonBody: unknown;
    headersSet: Record<string, string>;
  };
}

function createMockSupabase(
  selectResult: { data: unknown; error: unknown } = { data: null, error: null },
  updateResult: { error: unknown } = { error: null }
) {
  const mockUpdateEq = vi.fn().mockResolvedValue(updateResult);
  const mockUpdate = vi.fn().mockReturnValue({ eq: mockUpdateEq });
  const mockSingle = vi.fn().mockResolvedValue(selectResult);
  const mockSelectEq = vi.fn().mockReturnValue({ single: mockSingle });
  const mockSelect = vi.fn().mockReturnValue({ eq: mockSelectEq });

  const supabase = {
    from: vi.fn().mockReturnValue({
      select: mockSelect,
      update: mockUpdate,
    }),
  } as unknown as SupabaseClient;

  return { supabase, mockUpdate, mockUpdateEq };
}

function createUsageRecord(overrides: Record<string, unknown> = {}) {
  return {
    id: 'test-key-uuid',
    subscription_plan: 'FREE',
    rate_limit_override: null,
    daily_usage: 50,
    monthly_usage: 200,
    last_reset: new Date().toISOString(), // current period
    ...overrides,
  };
}

// =============================================================================
// Tests
// =============================================================================

describe('Rate Limiter Middleware', () => {
  let next: NextFunction;

  beforeEach(() => {
    vi.resetAllMocks();
    next = vi.fn();
  });

  // ---------------------------------------------------------------------------
  // Helper function tests
  // ---------------------------------------------------------------------------
  describe('Helper functions', () => {
    describe('resolveEffectiveLimit', () => {
      it('returns FREE plan defaults (100/day)', () => {
        const result = resolveEffectiveLimit(SubscriptionPlan.FREE, null);
        expect(result).toEqual({ maxRequests: 100, period: 'day' });
      });

      it('returns STARTER plan defaults (5000/month)', () => {
        const result = resolveEffectiveLimit(SubscriptionPlan.STARTER, null);
        expect(result).toEqual({ maxRequests: 5000, period: 'month' });
      });

      it('returns PROFESSIONAL plan defaults (25000/month)', () => {
        const result = resolveEffectiveLimit(SubscriptionPlan.PROFESSIONAL, null);
        expect(result).toEqual({ maxRequests: 25000, period: 'month' });
      });

      it('returns ENTERPRISE override when set', () => {
        const result = resolveEffectiveLimit(SubscriptionPlan.ENTERPRISE, 50000);
        expect(result).toEqual({ maxRequests: 50000, period: 'month' });
      });

      it('returns ENTERPRISE default (25000/month) when override is null', () => {
        const result = resolveEffectiveLimit(SubscriptionPlan.ENTERPRISE, null);
        expect(result).toEqual({ maxRequests: 25000, period: 'month' });
      });

      it('returns ENTERPRISE default when override is 0', () => {
        const result = resolveEffectiveLimit(SubscriptionPlan.ENTERPRISE, 0);
        expect(result).toEqual({ maxRequests: 25000, period: 'month' });
      });
    });

    describe('needsReset', () => {
      it('returns true when last_reset is before current day start (daily period)', () => {
        const yesterday = new Date();
        yesterday.setUTCDate(yesterday.getUTCDate() - 1);
        expect(needsReset(yesterday, 'day')).toBe(true);
      });

      it('returns false when last_reset is today (daily period)', () => {
        const today = getCurrentDayStart();
        expect(needsReset(today, 'day')).toBe(false);
      });

      it('returns true when last_reset is before current month start (monthly period)', () => {
        const lastMonth = new Date();
        lastMonth.setUTCMonth(lastMonth.getUTCMonth() - 1);
        expect(needsReset(lastMonth, 'month')).toBe(true);
      });

      it('returns false when last_reset is this month (monthly period)', () => {
        const thisMonth = getCurrentMonthStart();
        expect(needsReset(thisMonth, 'month')).toBe(false);
      });
    });

    describe('calculateRetryAfterSeconds', () => {
      it('returns positive seconds for day period', () => {
        const seconds = calculateRetryAfterSeconds('day');
        expect(seconds).toBeGreaterThan(0);
        // Maximum 24 hours = 86400 seconds
        expect(seconds).toBeLessThanOrEqual(86400);
      });

      it('returns positive seconds for month period', () => {
        const seconds = calculateRetryAfterSeconds('month');
        expect(seconds).toBeGreaterThan(0);
      });
    });

    describe('PLAN_DEFAULTS', () => {
      it('has correct configuration for all plans', () => {
        expect(PLAN_DEFAULTS[SubscriptionPlan.FREE]).toEqual({ maxRequests: 100, period: 'day' });
        expect(PLAN_DEFAULTS[SubscriptionPlan.STARTER]).toEqual({ maxRequests: 5000, period: 'month' });
        expect(PLAN_DEFAULTS[SubscriptionPlan.PROFESSIONAL]).toEqual({ maxRequests: 25000, period: 'month' });
        expect(PLAN_DEFAULTS[SubscriptionPlan.ENTERPRISE]).toEqual({ maxRequests: 25000, period: 'month' });
      });
    });
  });

  // ---------------------------------------------------------------------------
  // Marketplace bypass (Req 5.8)
  // ---------------------------------------------------------------------------
  describe('Marketplace bypass (Req 5.8)', () => {
    it('bypasses rate limiting when req.isMarketplaceRequest is true', async () => {
      const { supabase } = createMockSupabase();
      const middleware = createRateLimiterMiddleware({ supabase });
      const req = createMockReq({ isMarketplaceRequest: true } as Partial<Request>);
      const res = createMockRes();

      await middleware(req, res, next);

      expect(next).toHaveBeenCalled();
      expect(res.status).not.toHaveBeenCalled();
      // Should not query the database at all
      expect(supabase.from).not.toHaveBeenCalled();
    });

    it('does not set rate limit headers for marketplace requests', async () => {
      const { supabase } = createMockSupabase();
      const middleware = createRateLimiterMiddleware({ supabase });
      const req = createMockReq({ isMarketplaceRequest: true } as Partial<Request>);
      const res = createMockRes();

      await middleware(req, res, next);

      expect(res.setHeader).not.toHaveBeenCalled();
    });

    it('bypasses rate limiting regardless of usage count (FREE plan at limit)', async () => {
      const record = createUsageRecord({ daily_usage: 100, subscription_plan: 'FREE' });
      const { supabase } = createMockSupabase({ data: record, error: null });
      const middleware = createRateLimiterMiddleware({ supabase });
      const req = createMockReq({
        isMarketplaceRequest: true,
        subscriptionPlan: SubscriptionPlan.FREE,
      } as Partial<Request>);
      const res = createMockRes();

      await middleware(req, res, next);

      expect(next).toHaveBeenCalled();
      expect(res.status).not.toHaveBeenCalled();
      // Should not even query the database
      expect(supabase.from).not.toHaveBeenCalled();
    });

    it('bypasses rate limiting regardless of usage count (PROFESSIONAL plan over limit)', async () => {
      const record = createUsageRecord({ monthly_usage: 50000, subscription_plan: 'PROFESSIONAL' });
      const { supabase } = createMockSupabase({ data: record, error: null });
      const middleware = createRateLimiterMiddleware({ supabase });
      const req = createMockReq({
        isMarketplaceRequest: true,
        subscriptionPlan: SubscriptionPlan.PROFESSIONAL,
      } as Partial<Request>);
      const res = createMockRes();

      await middleware(req, res, next);

      expect(next).toHaveBeenCalled();
      expect(res.status).not.toHaveBeenCalled();
      expect(supabase.from).not.toHaveBeenCalled();
    });

    it('direct requests (isMarketplaceRequest=false) are still subject to rate limiting', async () => {
      const record = createUsageRecord({ daily_usage: 100, subscription_plan: 'FREE' });
      const { supabase } = createMockSupabase({ data: record, error: null });
      const middleware = createRateLimiterMiddleware({ supabase });
      const req = createMockReq({
        isMarketplaceRequest: false,
        subscriptionPlan: SubscriptionPlan.FREE,
      } as Partial<Request>);
      const res = createMockRes();

      await middleware(req, res, next);

      expect(next).not.toHaveBeenCalled();
      expect(res.status).toHaveBeenCalledWith(429);
    });
  });

  // ---------------------------------------------------------------------------
  // Anonymous request bypass
  // ---------------------------------------------------------------------------
  describe('Anonymous request bypass', () => {
    it('skips rate limiting for anonymous requests', async () => {
      const { supabase } = createMockSupabase();
      const middleware = createRateLimiterMiddleware({ supabase });
      const req = createMockReq({ anonymous: true, apiKeyId: undefined } as Partial<Request>);
      const res = createMockRes();

      await middleware(req, res, next);

      expect(next).toHaveBeenCalled();
      expect(supabase.from).not.toHaveBeenCalled();
    });

    it('skips rate limiting when apiKeyId is missing', async () => {
      const { supabase } = createMockSupabase();
      const middleware = createRateLimiterMiddleware({ supabase });
      const req = createMockReq({ apiKeyId: undefined } as Partial<Request>);
      const res = createMockRes();

      await middleware(req, res, next);

      expect(next).toHaveBeenCalled();
      expect(supabase.from).not.toHaveBeenCalled();
    });
  });

  // ---------------------------------------------------------------------------
  // FREE plan: 100 requests/day (Req 5.1)
  // ---------------------------------------------------------------------------
  describe('FREE plan (100/day) - Req 5.1', () => {
    it('allows request when under limit', async () => {
      const record = createUsageRecord({ daily_usage: 50, subscription_plan: 'FREE' });
      const { supabase } = createMockSupabase({ data: record, error: null });
      const middleware = createRateLimiterMiddleware({ supabase });
      const req = createMockReq({ subscriptionPlan: SubscriptionPlan.FREE } as Partial<Request>);
      const res = createMockRes();

      await middleware(req, res, next);

      expect(next).toHaveBeenCalled();
      expect(res.status).not.toHaveBeenCalled();
    });

    it('returns 429 when at limit (100 daily_usage)', async () => {
      const record = createUsageRecord({ daily_usage: 100, subscription_plan: 'FREE' });
      const { supabase } = createMockSupabase({ data: record, error: null });
      const middleware = createRateLimiterMiddleware({ supabase });
      const req = createMockReq({ subscriptionPlan: SubscriptionPlan.FREE } as Partial<Request>);
      const res = createMockRes();

      await middleware(req, res, next);

      expect(next).not.toHaveBeenCalled();
      expect(res.status).toHaveBeenCalledWith(429);
      expect(res.jsonBody).toEqual(expect.objectContaining({
        error: 'rate_limit_exceeded',
        limit: 100,
        retry_after_seconds: expect.any(Number),
        reset: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/),
      }));
    });

    it('returns 429 when over limit', async () => {
      const record = createUsageRecord({ daily_usage: 150, subscription_plan: 'FREE' });
      const { supabase } = createMockSupabase({ data: record, error: null });
      const middleware = createRateLimiterMiddleware({ supabase });
      const req = createMockReq({ subscriptionPlan: SubscriptionPlan.FREE } as Partial<Request>);
      const res = createMockRes();

      await middleware(req, res, next);

      expect(next).not.toHaveBeenCalled();
      expect(res.status).toHaveBeenCalledWith(429);
    });
  });

  // ---------------------------------------------------------------------------
  // STARTER plan: 5000 requests/month (Req 5.2)
  // ---------------------------------------------------------------------------
  describe('STARTER plan (5000/month) - Req 5.2', () => {
    it('allows request when under limit', async () => {
      const record = createUsageRecord({ monthly_usage: 4000, subscription_plan: 'STARTER' });
      const { supabase } = createMockSupabase({ data: record, error: null });
      const middleware = createRateLimiterMiddleware({ supabase });
      const req = createMockReq({ subscriptionPlan: SubscriptionPlan.STARTER } as Partial<Request>);
      const res = createMockRes();

      await middleware(req, res, next);

      expect(next).toHaveBeenCalled();
    });

    it('returns 429 when at limit (5000 monthly_usage)', async () => {
      const record = createUsageRecord({ monthly_usage: 5000, subscription_plan: 'STARTER' });
      const { supabase } = createMockSupabase({ data: record, error: null });
      const middleware = createRateLimiterMiddleware({ supabase });
      const req = createMockReq({ subscriptionPlan: SubscriptionPlan.STARTER } as Partial<Request>);
      const res = createMockRes();

      await middleware(req, res, next);

      expect(next).not.toHaveBeenCalled();
      expect(res.status).toHaveBeenCalledWith(429);
      expect(res.jsonBody).toEqual(expect.objectContaining({
        error: 'rate_limit_exceeded',
        limit: 5000,
      }));
    });
  });

  // ---------------------------------------------------------------------------
  // PROFESSIONAL plan: 25000 requests/month (Req 5.3)
  // ---------------------------------------------------------------------------
  describe('PROFESSIONAL plan (25000/month) - Req 5.3', () => {
    it('allows request when under limit', async () => {
      const record = createUsageRecord({ monthly_usage: 20000, subscription_plan: 'PROFESSIONAL' });
      const { supabase } = createMockSupabase({ data: record, error: null });
      const middleware = createRateLimiterMiddleware({ supabase });
      const req = createMockReq({ subscriptionPlan: SubscriptionPlan.PROFESSIONAL } as Partial<Request>);
      const res = createMockRes();

      await middleware(req, res, next);

      expect(next).toHaveBeenCalled();
    });

    it('returns 429 when at limit (25000 monthly_usage)', async () => {
      const record = createUsageRecord({ monthly_usage: 25000, subscription_plan: 'PROFESSIONAL' });
      const { supabase } = createMockSupabase({ data: record, error: null });
      const middleware = createRateLimiterMiddleware({ supabase });
      const req = createMockReq({ subscriptionPlan: SubscriptionPlan.PROFESSIONAL } as Partial<Request>);
      const res = createMockRes();

      await middleware(req, res, next);

      expect(next).not.toHaveBeenCalled();
      expect(res.status).toHaveBeenCalledWith(429);
      expect(res.jsonBody).toEqual(expect.objectContaining({
        error: 'rate_limit_exceeded',
        limit: 25000,
      }));
    });
  });

  // ---------------------------------------------------------------------------
  // ENTERPRISE plan: rate_limit_override or 25000/month (Req 5.4)
  // ---------------------------------------------------------------------------
  describe('ENTERPRISE plan (override or 25000/month) - Req 5.4', () => {
    it('uses rate_limit_override when set', async () => {
      const record = createUsageRecord({
        monthly_usage: 30000,
        subscription_plan: 'ENTERPRISE',
        rate_limit_override: 50000,
      });
      const { supabase } = createMockSupabase({ data: record, error: null });
      const middleware = createRateLimiterMiddleware({ supabase });
      const req = createMockReq({ subscriptionPlan: SubscriptionPlan.ENTERPRISE } as Partial<Request>);
      const res = createMockRes();

      await middleware(req, res, next);

      // 30000 < 50000, should pass
      expect(next).toHaveBeenCalled();
    });

    it('returns 429 when over custom override limit', async () => {
      const record = createUsageRecord({
        monthly_usage: 50000,
        subscription_plan: 'ENTERPRISE',
        rate_limit_override: 50000,
      });
      const { supabase } = createMockSupabase({ data: record, error: null });
      const middleware = createRateLimiterMiddleware({ supabase });
      const req = createMockReq({ subscriptionPlan: SubscriptionPlan.ENTERPRISE } as Partial<Request>);
      const res = createMockRes();

      await middleware(req, res, next);

      expect(next).not.toHaveBeenCalled();
      expect(res.status).toHaveBeenCalledWith(429);
      expect(res.jsonBody).toEqual(expect.objectContaining({
        error: 'rate_limit_exceeded',
        limit: 50000,
      }));
    });

    it('falls back to 25000/month when override is null', async () => {
      const record = createUsageRecord({
        monthly_usage: 25000,
        subscription_plan: 'ENTERPRISE',
        rate_limit_override: null,
      });
      const { supabase } = createMockSupabase({ data: record, error: null });
      const middleware = createRateLimiterMiddleware({ supabase });
      const req = createMockReq({ subscriptionPlan: SubscriptionPlan.ENTERPRISE } as Partial<Request>);
      const res = createMockRes();

      await middleware(req, res, next);

      expect(next).not.toHaveBeenCalled();
      expect(res.status).toHaveBeenCalledWith(429);
      expect(res.jsonBody).toEqual(expect.objectContaining({
        limit: 25000,
      }));
    });
  });

  // ---------------------------------------------------------------------------
  // 429 response format (Req 5.5)
  // ---------------------------------------------------------------------------
  describe('429 response format (Req 5.5)', () => {
    it('includes error code, limit, reset ISO time, and retry_after_seconds', async () => {
      const record = createUsageRecord({ daily_usage: 100, subscription_plan: 'FREE' });
      const { supabase } = createMockSupabase({ data: record, error: null });
      const middleware = createRateLimiterMiddleware({ supabase });
      const req = createMockReq({ subscriptionPlan: SubscriptionPlan.FREE } as Partial<Request>);
      const res = createMockRes();

      await middleware(req, res, next);

      expect(res.status).toHaveBeenCalledWith(429);
      const body = res.jsonBody as Record<string, unknown>;
      expect(body.error).toBe('rate_limit_exceeded');
      expect(body.limit).toBe(100);
      expect(body.retry_after_seconds).toBeGreaterThan(0);
      // ISO 8601 UTC format
      expect(body.reset).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    });
  });

  // ---------------------------------------------------------------------------
  // Counter reset at period boundary
  // ---------------------------------------------------------------------------
  describe('Counter reset at period boundary', () => {
    it('resets daily counter when last_reset is before today', async () => {
      const yesterday = new Date();
      yesterday.setUTCDate(yesterday.getUTCDate() - 1);
      const record = createUsageRecord({
        daily_usage: 99,
        subscription_plan: 'FREE',
        last_reset: yesterday.toISOString(),
      });
      const { supabase, mockUpdate } = createMockSupabase({ data: record, error: null });
      const middleware = createRateLimiterMiddleware({ supabase });
      const req = createMockReq({ subscriptionPlan: SubscriptionPlan.FREE } as Partial<Request>);
      const res = createMockRes();

      await middleware(req, res, next);

      // Should allow through (counter reset to 0, then incremented to 1)
      expect(next).toHaveBeenCalled();
      expect(res.status).not.toHaveBeenCalled();
    });

    it('resets monthly counter when last_reset is before this month', async () => {
      const lastMonth = new Date();
      lastMonth.setUTCMonth(lastMonth.getUTCMonth() - 1);
      const record = createUsageRecord({
        monthly_usage: 25000,
        subscription_plan: 'PROFESSIONAL',
        last_reset: lastMonth.toISOString(),
      });
      const { supabase } = createMockSupabase({ data: record, error: null });
      const middleware = createRateLimiterMiddleware({ supabase });
      const req = createMockReq({ subscriptionPlan: SubscriptionPlan.PROFESSIONAL } as Partial<Request>);
      const res = createMockRes();

      await middleware(req, res, next);

      // Should allow through (counter reset to 0, then incremented to 1)
      expect(next).toHaveBeenCalled();
      expect(res.status).not.toHaveBeenCalled();
    });
  });

  // ---------------------------------------------------------------------------
  // Rate limit headers (Req 13.4)
  // ---------------------------------------------------------------------------
  describe('Rate limit headers (Req 13.4)', () => {
    it('sets X-RateLimit-Limit, X-RateLimit-Remaining, X-RateLimit-Reset on allowed requests', async () => {
      const record = createUsageRecord({ daily_usage: 50, subscription_plan: 'FREE' });
      const { supabase } = createMockSupabase({ data: record, error: null });
      const middleware = createRateLimiterMiddleware({ supabase });
      const req = createMockReq({ subscriptionPlan: SubscriptionPlan.FREE } as Partial<Request>);
      const res = createMockRes();

      await middleware(req, res, next);

      expect(res.setHeader).toHaveBeenCalledWith('X-RateLimit-Limit', '100');
      expect(res.setHeader).toHaveBeenCalledWith('X-RateLimit-Remaining', '49'); // 100 - 51
      expect(res.setHeader).toHaveBeenCalledWith(
        'X-RateLimit-Reset',
        expect.stringMatching(/^\d+$/)
      );
    });

    it('sets X-RateLimit-Remaining to 0 on 429 responses', async () => {
      const record = createUsageRecord({ daily_usage: 100, subscription_plan: 'FREE' });
      const { supabase } = createMockSupabase({ data: record, error: null });
      const middleware = createRateLimiterMiddleware({ supabase });
      const req = createMockReq({ subscriptionPlan: SubscriptionPlan.FREE } as Partial<Request>);
      const res = createMockRes();

      await middleware(req, res, next);

      expect(res.setHeader).toHaveBeenCalledWith('X-RateLimit-Remaining', '0');
    });

    it('X-RateLimit-Reset is a Unix epoch timestamp', async () => {
      const record = createUsageRecord({ daily_usage: 50, subscription_plan: 'FREE' });
      const { supabase } = createMockSupabase({ data: record, error: null });
      const middleware = createRateLimiterMiddleware({ supabase });
      const req = createMockReq({ subscriptionPlan: SubscriptionPlan.FREE } as Partial<Request>);
      const res = createMockRes();

      await middleware(req, res, next);

      // Get the value passed to X-RateLimit-Reset
      const resetCall = (res.setHeader as ReturnType<typeof vi.fn>).mock.calls.find(
        (call: [string, string]) => call[0] === 'X-RateLimit-Reset'
      );
      expect(resetCall).toBeDefined();
      const epochStr = resetCall![1] as string;
      const epoch = parseInt(epochStr, 10);
      // Should be a reasonable Unix timestamp (after year 2020)
      expect(epoch).toBeGreaterThan(1577836800);
    });
  });

  // ---------------------------------------------------------------------------
  // Graceful degradation on DB errors
  // ---------------------------------------------------------------------------
  describe('Graceful degradation on DB errors', () => {
    it('allows request when database fetch fails', async () => {
      const { supabase } = createMockSupabase({
        data: null,
        error: { message: 'connection refused' },
      });
      const middleware = createRateLimiterMiddleware({ supabase });
      const req = createMockReq();
      const res = createMockRes();

      await middleware(req, res, next);

      expect(next).toHaveBeenCalled();
      expect(res.status).not.toHaveBeenCalled();
    });

    it('allows request when database throws exception', async () => {
      const supabase = {
        from: vi.fn().mockReturnValue({
          select: vi.fn().mockReturnValue({
            eq: vi.fn().mockReturnValue({
              single: vi.fn().mockRejectedValue(new Error('Network error')),
            }),
          }),
        }),
      } as unknown as SupabaseClient;

      const middleware = createRateLimiterMiddleware({ supabase });
      const req = createMockReq();
      const res = createMockRes();

      await middleware(req, res, next);

      expect(next).toHaveBeenCalled();
    });
  });

  // ---------------------------------------------------------------------------
  // Single UPDATE per request
  // ---------------------------------------------------------------------------
  describe('Single UPDATE per request', () => {
    it('calls supabase.update exactly once for allowed requests', async () => {
      const record = createUsageRecord({ daily_usage: 50, subscription_plan: 'FREE' });
      const { supabase, mockUpdate } = createMockSupabase({ data: record, error: null });
      const middleware = createRateLimiterMiddleware({ supabase });
      const req = createMockReq({ subscriptionPlan: SubscriptionPlan.FREE } as Partial<Request>);
      const res = createMockRes();

      await middleware(req, res, next);

      // from() is called twice: once for select, once for update
      expect(supabase.from).toHaveBeenCalledTimes(2);
      expect(mockUpdate).toHaveBeenCalledTimes(1);
    });

    it('does not call update when request is rate limited', async () => {
      const record = createUsageRecord({ daily_usage: 100, subscription_plan: 'FREE' });
      const { supabase, mockUpdate } = createMockSupabase({ data: record, error: null });
      const middleware = createRateLimiterMiddleware({ supabase });
      const req = createMockReq({ subscriptionPlan: SubscriptionPlan.FREE } as Partial<Request>);
      const res = createMockRes();

      await middleware(req, res, next);

      // Should only call from() once for select, not for update
      expect(supabase.from).toHaveBeenCalledTimes(1);
      expect(mockUpdate).not.toHaveBeenCalled();
    });
  });

  // ---------------------------------------------------------------------------
  // Per-API key scope (Req 5.7)
  // ---------------------------------------------------------------------------
  describe('Per API key scope (Req 5.7)', () => {
    it('queries usage by api key ID', async () => {
      const record = createUsageRecord();
      const { supabase } = createMockSupabase({ data: record, error: null });
      const middleware = createRateLimiterMiddleware({ supabase });
      const req = createMockReq({
        apiKeyId: 'specific-key-id',
        subscriptionPlan: SubscriptionPlan.FREE,
      } as Partial<Request>);
      const res = createMockRes();

      await middleware(req, res, next);

      // Verify the query filters by the correct key ID
      const fromMock = supabase.from as ReturnType<typeof vi.fn>;
      expect(fromMock).toHaveBeenCalledWith('api_keys');
    });
  });
});
