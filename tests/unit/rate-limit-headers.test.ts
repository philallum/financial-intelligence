/**
 * Unit tests for rate limit headers on authenticated responses.
 *
 * **Validates: Requirements 13.4**
 *
 * Property 15: Rate Limit Headers on Authenticated Responses
 *
 * Verifies:
 * - X-RateLimit-Limit is set to the correct max for the plan
 * - X-RateLimit-Remaining shows requests left (maxRequests - newUsage)
 * - X-RateLimit-Reset is a Unix epoch timestamp (seconds)
 * - Headers are present on ALL authenticated responses (not just 429s)
 * - Headers are omitted for RapidAPI marketplace requests
 * - Headers are omitted for anonymous requests
 *
 * Requirements: 13.4
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Request, Response, NextFunction } from 'express';
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  createRateLimiterMiddleware,
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
    last_reset: new Date().toISOString(),
    ...overrides,
  };
}

// =============================================================================
// Tests
// =============================================================================

describe('Rate Limit Headers (Req 13.4)', () => {
  let next: NextFunction;

  beforeEach(() => {
    vi.resetAllMocks();
    next = vi.fn();
  });

  // ---------------------------------------------------------------------------
  // Headers present on allowed authenticated requests
  // ---------------------------------------------------------------------------
  describe('Headers present on authenticated allowed requests', () => {
    it('sets X-RateLimit-Limit to 100 for FREE plan', async () => {
      const record = createUsageRecord({ daily_usage: 30, subscription_plan: 'FREE' });
      const { supabase } = createMockSupabase({ data: record, error: null });
      const middleware = createRateLimiterMiddleware({ supabase });
      const req = createMockReq({ subscriptionPlan: SubscriptionPlan.FREE } as Partial<Request>);
      const res = createMockRes();

      await middleware(req, res, next);

      expect(next).toHaveBeenCalled();
      expect(res.headersSet['X-RateLimit-Limit']).toBe('100');
    });

    it('sets X-RateLimit-Limit to 5000 for STARTER plan', async () => {
      const record = createUsageRecord({ monthly_usage: 1000, subscription_plan: 'STARTER' });
      const { supabase } = createMockSupabase({ data: record, error: null });
      const middleware = createRateLimiterMiddleware({ supabase });
      const req = createMockReq({ subscriptionPlan: SubscriptionPlan.STARTER } as Partial<Request>);
      const res = createMockRes();

      await middleware(req, res, next);

      expect(next).toHaveBeenCalled();
      expect(res.headersSet['X-RateLimit-Limit']).toBe('5000');
    });

    it('sets X-RateLimit-Limit to 25000 for PROFESSIONAL plan', async () => {
      const record = createUsageRecord({ monthly_usage: 5000, subscription_plan: 'PROFESSIONAL' });
      const { supabase } = createMockSupabase({ data: record, error: null });
      const middleware = createRateLimiterMiddleware({ supabase });
      const req = createMockReq({ subscriptionPlan: SubscriptionPlan.PROFESSIONAL } as Partial<Request>);
      const res = createMockRes();

      await middleware(req, res, next);

      expect(next).toHaveBeenCalled();
      expect(res.headersSet['X-RateLimit-Limit']).toBe('25000');
    });

    it('sets X-RateLimit-Limit to override value for ENTERPRISE plan', async () => {
      const record = createUsageRecord({
        monthly_usage: 10000,
        subscription_plan: 'ENTERPRISE',
        rate_limit_override: 50000,
      });
      const { supabase } = createMockSupabase({ data: record, error: null });
      const middleware = createRateLimiterMiddleware({ supabase });
      const req = createMockReq({ subscriptionPlan: SubscriptionPlan.ENTERPRISE } as Partial<Request>);
      const res = createMockRes();

      await middleware(req, res, next);

      expect(next).toHaveBeenCalled();
      expect(res.headersSet['X-RateLimit-Limit']).toBe('50000');
    });

    it('sets X-RateLimit-Remaining correctly (maxRequests - newUsage)', async () => {
      // FREE plan: 100 max, daily_usage = 30, newUsage = 31, remaining = 100 - 31 = 69
      const record = createUsageRecord({ daily_usage: 30, subscription_plan: 'FREE' });
      const { supabase } = createMockSupabase({ data: record, error: null });
      const middleware = createRateLimiterMiddleware({ supabase });
      const req = createMockReq({ subscriptionPlan: SubscriptionPlan.FREE } as Partial<Request>);
      const res = createMockRes();

      await middleware(req, res, next);

      expect(next).toHaveBeenCalled();
      expect(res.headersSet['X-RateLimit-Remaining']).toBe('69');
    });

    it('sets X-RateLimit-Remaining to 0 when at maxRequests - 1 (last allowed request)', async () => {
      // FREE plan: 100 max, daily_usage = 99, newUsage = 100, remaining = 100 - 100 = 0
      const record = createUsageRecord({ daily_usage: 99, subscription_plan: 'FREE' });
      const { supabase } = createMockSupabase({ data: record, error: null });
      const middleware = createRateLimiterMiddleware({ supabase });
      const req = createMockReq({ subscriptionPlan: SubscriptionPlan.FREE } as Partial<Request>);
      const res = createMockRes();

      await middleware(req, res, next);

      expect(next).toHaveBeenCalled();
      expect(res.headersSet['X-RateLimit-Remaining']).toBe('0');
    });

    it('sets X-RateLimit-Reset to a valid Unix epoch timestamp (seconds)', async () => {
      const record = createUsageRecord({ daily_usage: 10, subscription_plan: 'FREE' });
      const { supabase } = createMockSupabase({ data: record, error: null });
      const middleware = createRateLimiterMiddleware({ supabase });
      const req = createMockReq({ subscriptionPlan: SubscriptionPlan.FREE } as Partial<Request>);
      const res = createMockRes();

      await middleware(req, res, next);

      expect(next).toHaveBeenCalled();
      const resetValue = res.headersSet['X-RateLimit-Reset'];
      expect(resetValue).toMatch(/^\d+$/);
      const epoch = parseInt(resetValue, 10);
      // Must be in the future
      expect(epoch).toBeGreaterThan(Math.floor(Date.now() / 1000));
      // Must be a reasonable timestamp (after 2020)
      expect(epoch).toBeGreaterThan(1577836800);
    });

    it('all three headers are present together on allowed requests', async () => {
      const record = createUsageRecord({ daily_usage: 50, subscription_plan: 'FREE' });
      const { supabase } = createMockSupabase({ data: record, error: null });
      const middleware = createRateLimiterMiddleware({ supabase });
      const req = createMockReq({ subscriptionPlan: SubscriptionPlan.FREE } as Partial<Request>);
      const res = createMockRes();

      await middleware(req, res, next);

      expect(next).toHaveBeenCalled();
      expect(res.headersSet).toHaveProperty('X-RateLimit-Limit');
      expect(res.headersSet).toHaveProperty('X-RateLimit-Remaining');
      expect(res.headersSet).toHaveProperty('X-RateLimit-Reset');
    });
  });

  // ---------------------------------------------------------------------------
  // Headers present on 429 responses
  // ---------------------------------------------------------------------------
  describe('Headers present on 429 responses', () => {
    it('sets all three headers on 429 rate-limited responses', async () => {
      const record = createUsageRecord({ daily_usage: 100, subscription_plan: 'FREE' });
      const { supabase } = createMockSupabase({ data: record, error: null });
      const middleware = createRateLimiterMiddleware({ supabase });
      const req = createMockReq({ subscriptionPlan: SubscriptionPlan.FREE } as Partial<Request>);
      const res = createMockRes();

      await middleware(req, res, next);

      expect(res.statusCode).toBe(429);
      expect(res.headersSet['X-RateLimit-Limit']).toBe('100');
      expect(res.headersSet['X-RateLimit-Remaining']).toBe('0');
      expect(res.headersSet['X-RateLimit-Reset']).toMatch(/^\d+$/);
    });

    it('X-RateLimit-Remaining is always 0 on 429', async () => {
      const record = createUsageRecord({ monthly_usage: 5000, subscription_plan: 'STARTER' });
      const { supabase } = createMockSupabase({ data: record, error: null });
      const middleware = createRateLimiterMiddleware({ supabase });
      const req = createMockReq({ subscriptionPlan: SubscriptionPlan.STARTER } as Partial<Request>);
      const res = createMockRes();

      await middleware(req, res, next);

      expect(res.statusCode).toBe(429);
      expect(res.headersSet['X-RateLimit-Remaining']).toBe('0');
    });

    it('X-RateLimit-Limit reflects the correct plan limit on 429', async () => {
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

      expect(res.statusCode).toBe(429);
      expect(res.headersSet['X-RateLimit-Limit']).toBe('50000');
    });
  });

  // ---------------------------------------------------------------------------
  // Headers omitted for RapidAPI marketplace requests
  // ---------------------------------------------------------------------------
  describe('Headers omitted for RapidAPI marketplace requests', () => {
    it('does not set any rate limit headers for marketplace requests', async () => {
      const { supabase } = createMockSupabase();
      const middleware = createRateLimiterMiddleware({ supabase });
      const req = createMockReq({ isMarketplaceRequest: true } as Partial<Request>);
      const res = createMockRes();

      await middleware(req, res, next);

      expect(next).toHaveBeenCalled();
      expect(res.setHeader).not.toHaveBeenCalled();
      expect(res.headersSet).not.toHaveProperty('X-RateLimit-Limit');
      expect(res.headersSet).not.toHaveProperty('X-RateLimit-Remaining');
      expect(res.headersSet).not.toHaveProperty('X-RateLimit-Reset');
    });

    it('marketplace requests bypass even when usage would exceed limits', async () => {
      const record = createUsageRecord({ daily_usage: 999, subscription_plan: 'FREE' });
      const { supabase } = createMockSupabase({ data: record, error: null });
      const middleware = createRateLimiterMiddleware({ supabase });
      const req = createMockReq({
        isMarketplaceRequest: true,
        subscriptionPlan: SubscriptionPlan.FREE,
      } as Partial<Request>);
      const res = createMockRes();

      await middleware(req, res, next);

      expect(next).toHaveBeenCalled();
      expect(res.setHeader).not.toHaveBeenCalled();
    });
  });

  // ---------------------------------------------------------------------------
  // Headers omitted for anonymous requests
  // ---------------------------------------------------------------------------
  describe('Headers omitted for anonymous requests', () => {
    it('does not set rate limit headers for anonymous requests', async () => {
      const { supabase } = createMockSupabase();
      const middleware = createRateLimiterMiddleware({ supabase });
      const req = createMockReq({ anonymous: true, apiKeyId: undefined } as Partial<Request>);
      const res = createMockRes();

      await middleware(req, res, next);

      expect(next).toHaveBeenCalled();
      expect(res.setHeader).not.toHaveBeenCalled();
      expect(res.headersSet).not.toHaveProperty('X-RateLimit-Limit');
      expect(res.headersSet).not.toHaveProperty('X-RateLimit-Remaining');
      expect(res.headersSet).not.toHaveProperty('X-RateLimit-Reset');
    });

    it('does not set rate limit headers when apiKeyId is missing', async () => {
      const { supabase } = createMockSupabase();
      const middleware = createRateLimiterMiddleware({ supabase });
      const req = createMockReq({ apiKeyId: undefined } as Partial<Request>);
      const res = createMockRes();

      await middleware(req, res, next);

      expect(next).toHaveBeenCalled();
      expect(res.setHeader).not.toHaveBeenCalled();
    });
  });

  // ---------------------------------------------------------------------------
  // X-RateLimit-Reset correctness
  // ---------------------------------------------------------------------------
  describe('X-RateLimit-Reset correctness', () => {
    it('reset epoch matches getResetTimeEpoch for day period (FREE plan)', async () => {
      const record = createUsageRecord({ daily_usage: 20, subscription_plan: 'FREE' });
      const { supabase } = createMockSupabase({ data: record, error: null });
      const middleware = createRateLimiterMiddleware({ supabase });
      const req = createMockReq({ subscriptionPlan: SubscriptionPlan.FREE } as Partial<Request>);
      const res = createMockRes();

      await middleware(req, res, next);

      const resetValue = parseInt(res.headersSet['X-RateLimit-Reset'], 10);
      const expectedEpoch = getResetTimeEpoch('day');
      expect(resetValue).toBe(expectedEpoch);
    });

    it('reset epoch matches getResetTimeEpoch for month period (STARTER plan)', async () => {
      const record = createUsageRecord({ monthly_usage: 2000, subscription_plan: 'STARTER' });
      const { supabase } = createMockSupabase({ data: record, error: null });
      const middleware = createRateLimiterMiddleware({ supabase });
      const req = createMockReq({ subscriptionPlan: SubscriptionPlan.STARTER } as Partial<Request>);
      const res = createMockRes();

      await middleware(req, res, next);

      const resetValue = parseInt(res.headersSet['X-RateLimit-Reset'], 10);
      const expectedEpoch = getResetTimeEpoch('month');
      expect(resetValue).toBe(expectedEpoch);
    });
  });
});
