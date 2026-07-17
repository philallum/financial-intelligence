/**
 * Unit tests for the dual-auth middleware.
 *
 * Validates:
 * - Missing key → 401 (Req 1.1)
 * - Invalid key → 401 (Req 1.2)
 * - Revoked/inactive project → 401 (Req 1.4)
 * - X-API-Key priority over Bearer (Req 1.8)
 * - DB unreachable → 503 (Req 1.7)
 * - Valid key resolves correct tier and plan (Req 1.5)
 * - RapidAPI path: valid proxy-secret sets isMarketplaceRequest and resolves tier (Req 5.8)
 * - Invalid/missing proxy-secret falls through to direct path
 * - req.rapidApiUser and req.rapidApiSubscription populated for marketplace requests
 * - Anonymous access for GET /v1/forecast/EURUSD
 *
 * Requirements: 1.1, 1.2, 1.4, 1.5, 1.7, 1.8, 5.8
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Request, Response, NextFunction } from 'express';
import type { SupabaseClient } from '@supabase/supabase-js';
import { createAuthMiddleware } from '../../src/api/middleware/auth.js';
import { CustomerTier, SubscriptionPlan } from '../../src/types/enums.js';

// =============================================================================
// Module Mocks
// =============================================================================

vi.mock('../../src/api/utils/key-hash.js', () => ({
  verifyApiKey: vi.fn(),
}));

vi.mock('../../src/api/utils/rapidapi-tier-map.js', () => ({
  isRapidApiRequest: vi.fn(),
  resolveRapidApiTier: vi.fn(),
}));

import { verifyApiKey } from '../../src/api/utils/key-hash.js';
import { isRapidApiRequest, resolveRapidApiTier } from '../../src/api/utils/rapidapi-tier-map.js';

// =============================================================================
// Test Helpers
// =============================================================================

function createMockReq(overrides: Partial<Request> = {}): Request {
  return {
    method: 'GET',
    path: '/v1/positions',
    headers: {},
    socket: { remoteAddress: '127.0.0.1' },
    ...overrides,
  } as unknown as Request;
}

function createMockRes() {
  const res = {
    statusCode: 200,
    jsonBody: null as unknown,
    status: vi.fn().mockImplementation((code: number) => {
      res.statusCode = code;
      return res;
    }),
    json: vi.fn().mockImplementation((body: unknown) => {
      res.jsonBody = body;
      return res;
    }),
  };
  return res as unknown as Response & { statusCode: number; jsonBody: unknown };
}

function createMockSupabase(queryResult: { data: unknown; error: unknown } = { data: [], error: null }) {
  const mockSingle = vi.fn().mockResolvedValue({ data: null, error: null });
  const mockUpdateEq = vi.fn().mockResolvedValue({ error: null });
  const mockSelectForUsage = vi.fn().mockReturnValue({
    eq: vi.fn().mockReturnValue({
      single: mockSingle,
    }),
  });

  // Track call count to differentiate initial query from usage update
  let fromCallCount = 0;

  const supabase = {
    from: vi.fn().mockImplementation(() => {
      fromCallCount++;
      if (fromCallCount === 1) {
        // First call: the main api_keys query
        return {
          select: vi.fn().mockReturnValue({
            eq: vi.fn().mockResolvedValue(queryResult),
          }),
        };
      }
      // Subsequent calls: usage update (fire-and-forget)
      return {
        select: mockSelectForUsage,
        update: vi.fn().mockReturnValue({
          eq: mockUpdateEq,
        }),
      };
    }),
  } as unknown as SupabaseClient;

  return supabase;
}

const mockApiKeyRecord = {
  id: 'key-uuid',
  key_hash: '$argon2id$v=19$m=19456,t=2,p=1$fakesalt$fakehash',
  name: 'Test Key',
  subscription_plan: 'PROFESSIONAL',
  is_active: true,
  rate_limit_override: null,
  daily_usage: 10,
  monthly_usage: 100,
  last_reset: '2025-01-01T00:00:00Z',
  last_used_at: null,
  project: {
    id: 'project-uuid',
    customer_id: 'customer-uuid',
    is_active: true,
    customer: {
      id: 'customer-uuid',
      tier: 'DEVELOPER',
    },
  },
};

// =============================================================================
// Tests
// =============================================================================

describe('Auth Middleware - Dual Auth', () => {
  let next: NextFunction;

  beforeEach(() => {
    vi.resetAllMocks();
    next = vi.fn();
    // Default: not a RapidAPI request
    vi.mocked(isRapidApiRequest).mockReturnValue(false);
    vi.mocked(resolveRapidApiTier).mockReturnValue(CustomerTier.RETAIL);
    vi.mocked(verifyApiKey).mockResolvedValue(false);
  });

  // ---------------------------------------------------------------------------
  // 1. Missing key → 401 (Req 1.1)
  // ---------------------------------------------------------------------------
  describe('Missing API key', () => {
    it('returns 401 when no X-API-Key or Authorization header is present', async () => {
      const supabase = createMockSupabase();
      const middleware = createAuthMiddleware({ supabase });
      const req = createMockReq({ headers: {} });
      const res = createMockRes();

      await middleware(req, res, next);

      expect(res.status).toHaveBeenCalledWith(401);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          error: 'unauthorized',
          message: expect.stringContaining('Missing API key'),
        })
      );
      expect(next).not.toHaveBeenCalled();
    });
  });

  // ---------------------------------------------------------------------------
  // 2. Invalid key → 401 (Req 1.2)
  // ---------------------------------------------------------------------------
  describe('Invalid API key', () => {
    it('returns 401 when key does not match any stored hash', async () => {
      const supabase = createMockSupabase({ data: [mockApiKeyRecord], error: null });
      const middleware = createAuthMiddleware({ supabase });
      const req = createMockReq({ headers: { 'x-api-key': 'invalid-key-123' } });
      const res = createMockRes();

      // verifyApiKey returns false for all records
      vi.mocked(verifyApiKey).mockResolvedValue(false);

      await middleware(req, res, next);

      expect(res.status).toHaveBeenCalledWith(401);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          error: 'unauthorized',
          message: expect.stringContaining('Invalid API key'),
        })
      );
      expect(next).not.toHaveBeenCalled();
    });
  });

  // ---------------------------------------------------------------------------
  // 3. Revoked key → 401 (Req 1.4)
  // ---------------------------------------------------------------------------
  describe('Revoked/inactive project key', () => {
    it('returns 401 when key matches but project is inactive', async () => {
      const revokedRecord = {
        ...mockApiKeyRecord,
        project: {
          ...mockApiKeyRecord.project,
          is_active: false,
        },
      };
      const supabase = createMockSupabase({ data: [revokedRecord], error: null });
      const middleware = createAuthMiddleware({ supabase });
      const req = createMockReq({ headers: { 'x-api-key': 'valid-key-123' } });
      const res = createMockRes();

      // Key matches
      vi.mocked(verifyApiKey).mockResolvedValue(true);

      await middleware(req, res, next);

      expect(res.status).toHaveBeenCalledWith(401);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          error: 'unauthorized',
          message: expect.stringContaining('deactivated'),
        })
      );
      expect(next).not.toHaveBeenCalled();
    });
  });

  // ---------------------------------------------------------------------------
  // 4. X-API-Key priority over Bearer (Req 1.8)
  // ---------------------------------------------------------------------------
  describe('X-API-Key priority over Bearer', () => {
    it('uses X-API-Key when both X-API-Key and Authorization Bearer are present', async () => {
      const supabase = createMockSupabase({ data: [mockApiKeyRecord], error: null });
      const middleware = createAuthMiddleware({ supabase });
      const req = createMockReq({
        headers: {
          'x-api-key': 'primary-key',
          'authorization': 'Bearer secondary-key',
        },
      });
      const res = createMockRes();

      // Only the X-API-Key value should be verified
      vi.mocked(verifyApiKey).mockImplementation(async (plaintext: string) => {
        return plaintext === 'primary-key';
      });

      await middleware(req, res, next);

      expect(next).toHaveBeenCalled();
      // verifyApiKey should have been called with 'primary-key', not 'secondary-key'
      expect(verifyApiKey).toHaveBeenCalledWith('primary-key', mockApiKeyRecord.key_hash);
    });
  });

  // ---------------------------------------------------------------------------
  // 5. DB unreachable → 503 (Req 1.7)
  // ---------------------------------------------------------------------------
  describe('Database unreachable', () => {
    it('returns 503 when Supabase returns an error', async () => {
      const supabase = createMockSupabase({
        data: null,
        error: { message: 'connection refused', code: 'PGRST000' },
      });
      const middleware = createAuthMiddleware({ supabase });
      const req = createMockReq({ headers: { 'x-api-key': 'some-key' } });
      const res = createMockRes();

      await middleware(req, res, next);

      expect(res.status).toHaveBeenCalledWith(503);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          error: 'service_unavailable',
          retry_after_seconds: expect.any(Number),
        })
      );
      expect(next).not.toHaveBeenCalled();
    });

    it('returns 503 when Supabase throws an exception', async () => {
      // Create a supabase mock that throws
      const supabase = {
        from: vi.fn().mockReturnValue({
          select: vi.fn().mockReturnValue({
            eq: vi.fn().mockRejectedValue(new Error('Network error')),
          }),
        }),
      } as unknown as SupabaseClient;

      const middleware = createAuthMiddleware({ supabase });
      const req = createMockReq({ headers: { 'x-api-key': 'some-key' } });
      const res = createMockRes();

      await middleware(req, res, next);

      expect(res.status).toHaveBeenCalledWith(503);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          error: 'service_unavailable',
          retry_after_seconds: expect.any(Number),
        })
      );
      expect(next).not.toHaveBeenCalled();
    });
  });

  // ---------------------------------------------------------------------------
  // 6. Valid key resolves correct tier and plan (Req 1.5)
  // ---------------------------------------------------------------------------
  describe('Valid key resolves tier and plan', () => {
    it('sets req.tier and req.subscriptionPlan correctly for a valid key', async () => {
      const supabase = createMockSupabase({ data: [mockApiKeyRecord], error: null });
      const middleware = createAuthMiddleware({ supabase });
      const req = createMockReq({ headers: { 'x-api-key': 'valid-key' } });
      const res = createMockRes();

      vi.mocked(verifyApiKey).mockResolvedValue(true);

      await middleware(req, res, next);

      expect(next).toHaveBeenCalled();
      expect(req.tier).toBe(CustomerTier.DEVELOPER);
      expect(req.subscriptionPlan).toBe(SubscriptionPlan.PROFESSIONAL);
      expect(req.apiKeyId).toBe('key-uuid');
      expect(req.projectId).toBe('project-uuid');
      expect(req.customerId).toBe('customer-uuid');
      expect(req.anonymous).toBe(false);
      expect(req.isMarketplaceRequest).toBe(false);
    });
  });

  // ---------------------------------------------------------------------------
  // 7. RapidAPI path: valid proxy-secret sets isMarketplaceRequest and resolves tier
  // ---------------------------------------------------------------------------
  describe('RapidAPI marketplace path', () => {
    it('sets isMarketplaceRequest=true and resolves tier from subscription header', async () => {
      const supabase = createMockSupabase();
      const middleware = createAuthMiddleware({ supabase });
      const req = createMockReq({
        headers: {
          'x-rapidapi-proxy-secret': 'valid-secret',
          'x-rapidapi-subscription': 'PRO',
          'x-rapidapi-user': 'user-123',
        },
      });
      const res = createMockRes();

      vi.mocked(isRapidApiRequest).mockReturnValue(true);
      vi.mocked(resolveRapidApiTier).mockReturnValue(CustomerTier.DEVELOPER);

      await middleware(req, res, next);

      expect(next).toHaveBeenCalled();
      expect(req.isMarketplaceRequest).toBe(true);
      expect(req.tier).toBe(CustomerTier.DEVELOPER);
      expect(req.subscriptionPlan).toBe(SubscriptionPlan.PROFESSIONAL);
      expect(resolveRapidApiTier).toHaveBeenCalledWith('PRO');
    });
  });

  // ---------------------------------------------------------------------------
  // 8. Invalid/missing proxy-secret falls through to direct path
  // ---------------------------------------------------------------------------
  describe('Invalid proxy-secret fallthrough', () => {
    it('falls through to direct API key path when proxy-secret is invalid', async () => {
      const supabase = createMockSupabase({ data: [mockApiKeyRecord], error: null });
      const middleware = createAuthMiddleware({ supabase });
      const req = createMockReq({
        headers: {
          'x-rapidapi-proxy-secret': 'wrong-secret',
          'x-api-key': 'valid-key',
        },
      });
      const res = createMockRes();

      // isRapidApiRequest returns false (secret doesn't match)
      vi.mocked(isRapidApiRequest).mockReturnValue(false);
      vi.mocked(verifyApiKey).mockResolvedValue(true);

      await middleware(req, res, next);

      expect(next).toHaveBeenCalled();
      // Should resolve via direct path, not marketplace
      expect(req.isMarketplaceRequest).toBe(false);
      expect(req.tier).toBe(CustomerTier.DEVELOPER);
    });
  });

  // ---------------------------------------------------------------------------
  // 9. req.rapidApiUser and req.rapidApiSubscription populated for marketplace
  // ---------------------------------------------------------------------------
  describe('RapidAPI request metadata', () => {
    it('populates req.rapidApiUser and req.rapidApiSubscription for marketplace requests', async () => {
      const supabase = createMockSupabase();
      const middleware = createAuthMiddleware({ supabase });
      const req = createMockReq({
        headers: {
          'x-rapidapi-proxy-secret': 'valid-secret',
          'x-rapidapi-subscription': 'ULTRA',
          'x-rapidapi-user': 'marketplace-user-456',
        },
      });
      const res = createMockRes();

      vi.mocked(isRapidApiRequest).mockReturnValue(true);
      vi.mocked(resolveRapidApiTier).mockReturnValue(CustomerTier.RESEARCH);

      await middleware(req, res, next);

      expect(next).toHaveBeenCalled();
      expect(req.rapidApiUser).toBe('marketplace-user-456');
      expect(req.rapidApiSubscription).toBe('ULTRA');
    });
  });

  // ---------------------------------------------------------------------------
  // 10. Anonymous access for GET /v1/forecast/EURUSD
  // ---------------------------------------------------------------------------
  describe('Anonymous access', () => {
    it('allows GET /v1/forecast/EURUSD without authentication', async () => {
      const supabase = createMockSupabase();
      const middleware = createAuthMiddleware({ supabase });
      const req = createMockReq({
        method: 'GET',
        path: '/v1/forecast/EURUSD',
        headers: {},
      });
      const res = createMockRes();

      await middleware(req, res, next);

      expect(next).toHaveBeenCalled();
      expect(req.anonymous).toBe(true);
      expect(res.status).not.toHaveBeenCalled();
    });

    it('handles case-insensitive path matching for EURUSD', async () => {
      const supabase = createMockSupabase();
      const middleware = createAuthMiddleware({ supabase });
      const req = createMockReq({
        method: 'GET',
        path: '/v1/forecast/eurusd',
        headers: {},
      });
      const res = createMockRes();

      await middleware(req, res, next);

      expect(next).toHaveBeenCalled();
      expect(req.anonymous).toBe(true);
    });

    it('does not allow anonymous access for non-GET methods on /v1/forecast/EURUSD', async () => {
      const supabase = createMockSupabase();
      const middleware = createAuthMiddleware({ supabase });
      const req = createMockReq({
        method: 'POST',
        path: '/v1/forecast/EURUSD',
        headers: {},
      });
      const res = createMockRes();

      await middleware(req, res, next);

      // Should return 401 since no key is provided and it's not anonymous-eligible
      expect(res.status).toHaveBeenCalledWith(401);
      expect(next).not.toHaveBeenCalled();
    });
  });
});
