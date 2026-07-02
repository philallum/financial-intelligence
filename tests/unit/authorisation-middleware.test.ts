/**
 * Unit tests for the authorisation middleware.
 *
 * Validates:
 * - Tier hierarchy authorisation — all tier × endpoint combinations (Property 3)
 * - 403 response does not leak tier requirements (Property 4)
 * - Deny-by-default for unknown endpoints (Req 3.5)
 * - Anonymous access bypass for allowed endpoints
 * - Missing tier returns 403
 * - Middleware is auth-source agnostic (works for both direct and RapidAPI)
 *
 * Requirements: 3.1, 3.2, 3.3, 3.5
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Request, Response, NextFunction } from 'express';
import { authorisationMiddleware, tierMeetsMinimum, ENDPOINT_METADATA } from '../../src/api/middleware/authorisation.js';
import { CustomerTier } from '../../src/types/enums.js';

// =============================================================================
// Test Helpers
// =============================================================================

function createMockReq(overrides: Partial<Request> = {}): Request {
  return {
    method: 'GET',
    path: '/v1/forecast/GBPUSD',
    headers: {},
    tier: undefined,
    anonymous: false,
    isMarketplaceRequest: false,
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

// =============================================================================
// Tests
// =============================================================================

describe('Authorisation Middleware', () => {
  let next: NextFunction;

  beforeEach(() => {
    vi.resetAllMocks();
    next = vi.fn();
  });

  // ---------------------------------------------------------------------------
  // Property 3: Tier Hierarchy Authorisation (Req 3.1, 3.2)
  // ---------------------------------------------------------------------------
  describe('Property 3 - Tier Hierarchy Authorisation', () => {
    describe('RETAIL tier access', () => {
      it('grants RETAIL access to /v1/forecast (minimum RETAIL)', () => {
        const req = createMockReq({ path: '/v1/forecast/EURUSD', tier: CustomerTier.RETAIL } as Partial<Request>);
        const res = createMockRes();

        authorisationMiddleware(req, res, next);

        expect(next).toHaveBeenCalled();
        expect(res.status).not.toHaveBeenCalled();
      });

      it('denies RETAIL access to /v1/state (minimum DEVELOPER)', () => {
        const req = createMockReq({ path: '/v1/state', tier: CustomerTier.RETAIL } as Partial<Request>);
        const res = createMockRes();

        authorisationMiddleware(req, res, next);

        expect(res.status).toHaveBeenCalledWith(403);
        expect(next).not.toHaveBeenCalled();
      });

      it('denies RETAIL access to /v1/similarity (minimum DEVELOPER)', () => {
        const req = createMockReq({ path: '/v1/similarity', tier: CustomerTier.RETAIL } as Partial<Request>);
        const res = createMockRes();

        authorisationMiddleware(req, res, next);

        expect(res.status).toHaveBeenCalledWith(403);
        expect(next).not.toHaveBeenCalled();
      });

      it('denies RETAIL access to /v1/metrics (minimum INTERNAL)', () => {
        const req = createMockReq({ path: '/v1/metrics', tier: CustomerTier.RETAIL } as Partial<Request>);
        const res = createMockRes();

        authorisationMiddleware(req, res, next);

        expect(res.status).toHaveBeenCalledWith(403);
        expect(next).not.toHaveBeenCalled();
      });
    });

    describe('DEVELOPER tier access', () => {
      it('grants DEVELOPER access to /v1/forecast (minimum RETAIL)', () => {
        const req = createMockReq({ path: '/v1/forecast/GBPUSD', tier: CustomerTier.DEVELOPER } as Partial<Request>);
        const res = createMockRes();

        authorisationMiddleware(req, res, next);

        expect(next).toHaveBeenCalled();
        expect(res.status).not.toHaveBeenCalled();
      });

      it('grants DEVELOPER access to /v1/state (minimum DEVELOPER)', () => {
        const req = createMockReq({ path: '/v1/state', tier: CustomerTier.DEVELOPER } as Partial<Request>);
        const res = createMockRes();

        authorisationMiddleware(req, res, next);

        expect(next).toHaveBeenCalled();
        expect(res.status).not.toHaveBeenCalled();
      });

      it('grants DEVELOPER access to /v1/similarity (minimum DEVELOPER)', () => {
        const req = createMockReq({ path: '/v1/similarity', tier: CustomerTier.DEVELOPER } as Partial<Request>);
        const res = createMockRes();

        authorisationMiddleware(req, res, next);

        expect(next).toHaveBeenCalled();
        expect(res.status).not.toHaveBeenCalled();
      });

      it('denies DEVELOPER access to /v1/metrics (minimum INTERNAL)', () => {
        const req = createMockReq({ path: '/v1/metrics', tier: CustomerTier.DEVELOPER } as Partial<Request>);
        const res = createMockRes();

        authorisationMiddleware(req, res, next);

        expect(res.status).toHaveBeenCalledWith(403);
        expect(next).not.toHaveBeenCalled();
      });
    });

    describe('RESEARCH tier access', () => {
      it('grants RESEARCH access to /v1/forecast (minimum RETAIL)', () => {
        const req = createMockReq({ path: '/v1/forecast/EURUSD', tier: CustomerTier.RESEARCH } as Partial<Request>);
        const res = createMockRes();

        authorisationMiddleware(req, res, next);

        expect(next).toHaveBeenCalled();
        expect(res.status).not.toHaveBeenCalled();
      });

      it('grants RESEARCH access to /v1/state (minimum DEVELOPER)', () => {
        const req = createMockReq({ path: '/v1/state', tier: CustomerTier.RESEARCH } as Partial<Request>);
        const res = createMockRes();

        authorisationMiddleware(req, res, next);

        expect(next).toHaveBeenCalled();
        expect(res.status).not.toHaveBeenCalled();
      });

      it('grants RESEARCH access to /v1/similarity (minimum DEVELOPER)', () => {
        const req = createMockReq({ path: '/v1/similarity', tier: CustomerTier.RESEARCH } as Partial<Request>);
        const res = createMockRes();

        authorisationMiddleware(req, res, next);

        expect(next).toHaveBeenCalled();
        expect(res.status).not.toHaveBeenCalled();
      });

      it('denies RESEARCH access to /v1/metrics (minimum INTERNAL)', () => {
        const req = createMockReq({ path: '/v1/metrics', tier: CustomerTier.RESEARCH } as Partial<Request>);
        const res = createMockRes();

        authorisationMiddleware(req, res, next);

        expect(res.status).toHaveBeenCalledWith(403);
        expect(next).not.toHaveBeenCalled();
      });
    });

    describe('INTERNAL tier access', () => {
      it('grants INTERNAL access to /v1/forecast', () => {
        const req = createMockReq({ path: '/v1/forecast/EURUSD', tier: CustomerTier.INTERNAL } as Partial<Request>);
        const res = createMockRes();

        authorisationMiddleware(req, res, next);

        expect(next).toHaveBeenCalled();
        expect(res.status).not.toHaveBeenCalled();
      });

      it('grants INTERNAL access to /v1/state', () => {
        const req = createMockReq({ path: '/v1/state', tier: CustomerTier.INTERNAL } as Partial<Request>);
        const res = createMockRes();

        authorisationMiddleware(req, res, next);

        expect(next).toHaveBeenCalled();
        expect(res.status).not.toHaveBeenCalled();
      });

      it('grants INTERNAL access to /v1/similarity', () => {
        const req = createMockReq({ path: '/v1/similarity', tier: CustomerTier.INTERNAL } as Partial<Request>);
        const res = createMockRes();

        authorisationMiddleware(req, res, next);

        expect(next).toHaveBeenCalled();
        expect(res.status).not.toHaveBeenCalled();
      });

      it('grants INTERNAL access to /v1/metrics', () => {
        const req = createMockReq({ path: '/v1/metrics', tier: CustomerTier.INTERNAL } as Partial<Request>);
        const res = createMockRes();

        authorisationMiddleware(req, res, next);

        expect(next).toHaveBeenCalled();
        expect(res.status).not.toHaveBeenCalled();
      });
    });
  });

  // ---------------------------------------------------------------------------
  // Property 4: Forbidden Response Does Not Leak Tier Requirements (Req 3.3)
  // ---------------------------------------------------------------------------
  describe('Property 4 - No Tier Leak in 403 responses', () => {
    it('does not reveal DEVELOPER tier requirement when RETAIL requests /v1/state', () => {
      const req = createMockReq({ path: '/v1/state', tier: CustomerTier.RETAIL } as Partial<Request>);
      const res = createMockRes();

      authorisationMiddleware(req, res, next);

      expect(res.status).toHaveBeenCalledWith(403);
      const body = res.jsonBody as { error: string; message: string };
      expect(body.message).not.toContain('DEVELOPER');
      expect(body.message).not.toContain('RESEARCH');
      expect(body.message).not.toContain('INTERNAL');
      expect(body.message).toBe('This endpoint is not available for your account tier.');
    });

    it('does not reveal INTERNAL tier requirement when DEVELOPER requests /v1/metrics', () => {
      const req = createMockReq({ path: '/v1/metrics', tier: CustomerTier.DEVELOPER } as Partial<Request>);
      const res = createMockRes();

      authorisationMiddleware(req, res, next);

      expect(res.status).toHaveBeenCalledWith(403);
      const body = res.jsonBody as { error: string; message: string };
      expect(body.message).not.toContain('INTERNAL');
      expect(body.message).not.toContain('RESEARCH');
      expect(body.message).toBe('This endpoint is not available for your account tier.');
    });

    it('does not reveal INTERNAL tier requirement when RESEARCH requests /v1/metrics', () => {
      const req = createMockReq({ path: '/v1/metrics', tier: CustomerTier.RESEARCH } as Partial<Request>);
      const res = createMockRes();

      authorisationMiddleware(req, res, next);

      expect(res.status).toHaveBeenCalledWith(403);
      const body = res.jsonBody as { error: string; message: string };
      expect(body.message).not.toContain('INTERNAL');
      expect(body.message).toBe('This endpoint is not available for your account tier.');
    });

    it('uses generic error message for all 403 responses', () => {
      // Test deny-by-default also uses the generic message
      const req = createMockReq({ path: '/v1/unknown', tier: CustomerTier.INTERNAL } as Partial<Request>);
      const res = createMockRes();

      authorisationMiddleware(req, res, next);

      expect(res.status).toHaveBeenCalledWith(403);
      const body = res.jsonBody as { error: string; message: string };
      expect(body.error).toBe('forbidden');
      expect(body.message).toBe('This endpoint is not available for your account tier.');
    });
  });

  // ---------------------------------------------------------------------------
  // Deny-by-default for unknown endpoints (Req 3.5)
  // ---------------------------------------------------------------------------
  describe('Deny-by-default for unknown endpoints (Req 3.5)', () => {
    it('returns 403 for /v1/unknown endpoint', () => {
      const req = createMockReq({ path: '/v1/unknown', tier: CustomerTier.INTERNAL } as Partial<Request>);
      const res = createMockRes();

      authorisationMiddleware(req, res, next);

      expect(res.status).toHaveBeenCalledWith(403);
      expect(next).not.toHaveBeenCalled();
    });

    it('returns 403 for /v2/foo endpoint (wrong version)', () => {
      const req = createMockReq({ path: '/v2/foo', tier: CustomerTier.INTERNAL } as Partial<Request>);
      const res = createMockRes();

      authorisationMiddleware(req, res, next);

      expect(res.status).toHaveBeenCalledWith(403);
      expect(next).not.toHaveBeenCalled();
    });

    it('returns 403 for /admin endpoint', () => {
      const req = createMockReq({ path: '/admin', tier: CustomerTier.INTERNAL } as Partial<Request>);
      const res = createMockRes();

      authorisationMiddleware(req, res, next);

      expect(res.status).toHaveBeenCalledWith(403);
      expect(next).not.toHaveBeenCalled();
    });

    it('returns 403 for empty path', () => {
      const req = createMockReq({ path: '/', tier: CustomerTier.INTERNAL } as Partial<Request>);
      const res = createMockRes();

      authorisationMiddleware(req, res, next);

      expect(res.status).toHaveBeenCalledWith(403);
      expect(next).not.toHaveBeenCalled();
    });
  });

  // ---------------------------------------------------------------------------
  // Anonymous access bypass
  // ---------------------------------------------------------------------------
  describe('Anonymous access bypass', () => {
    it('allows anonymous request to /v1/forecast (allowAnonymous=true)', () => {
      const req = createMockReq({ path: '/v1/forecast/EURUSD', anonymous: true } as Partial<Request>);
      const res = createMockRes();

      authorisationMiddleware(req, res, next);

      expect(next).toHaveBeenCalled();
      expect(res.status).not.toHaveBeenCalled();
    });

    it('allows anonymous request to /v1/forecast without subpath (allowAnonymous=true)', () => {
      const req = createMockReq({ path: '/v1/forecast', anonymous: true } as Partial<Request>);
      const res = createMockRes();

      authorisationMiddleware(req, res, next);

      expect(next).toHaveBeenCalled();
      expect(res.status).not.toHaveBeenCalled();
    });

    it('denies anonymous request to /v1/state (no allowAnonymous)', () => {
      const req = createMockReq({ path: '/v1/state', anonymous: true } as Partial<Request>);
      const res = createMockRes();

      authorisationMiddleware(req, res, next);

      expect(res.status).toHaveBeenCalledWith(403);
      expect(next).not.toHaveBeenCalled();
    });

    it('denies anonymous request to /v1/similarity (no allowAnonymous)', () => {
      const req = createMockReq({ path: '/v1/similarity', anonymous: true } as Partial<Request>);
      const res = createMockRes();

      authorisationMiddleware(req, res, next);

      expect(res.status).toHaveBeenCalledWith(403);
      expect(next).not.toHaveBeenCalled();
    });

    it('denies anonymous request to /v1/metrics (no allowAnonymous)', () => {
      const req = createMockReq({ path: '/v1/metrics', anonymous: true } as Partial<Request>);
      const res = createMockRes();

      authorisationMiddleware(req, res, next);

      expect(res.status).toHaveBeenCalledWith(403);
      expect(next).not.toHaveBeenCalled();
    });

    it('denies anonymous request to unknown endpoint', () => {
      const req = createMockReq({ path: '/v1/unknown', anonymous: true } as Partial<Request>);
      const res = createMockRes();

      authorisationMiddleware(req, res, next);

      expect(res.status).toHaveBeenCalledWith(403);
      expect(next).not.toHaveBeenCalled();
    });
  });

  // ---------------------------------------------------------------------------
  // Missing tier → 403
  // ---------------------------------------------------------------------------
  describe('Missing tier returns 403', () => {
    it('returns 403 when req.tier is undefined', () => {
      const req = createMockReq({ path: '/v1/state', tier: undefined } as Partial<Request>);
      const res = createMockRes();

      authorisationMiddleware(req, res, next);

      expect(res.status).toHaveBeenCalledWith(403);
      expect(next).not.toHaveBeenCalled();
    });

    it('returns 403 when req.tier is null', () => {
      const req = createMockReq({ path: '/v1/forecast/EURUSD', tier: null as unknown as undefined } as Partial<Request>);
      const res = createMockRes();

      authorisationMiddleware(req, res, next);

      expect(res.status).toHaveBeenCalledWith(403);
      expect(next).not.toHaveBeenCalled();
    });
  });

  // ---------------------------------------------------------------------------
  // Auth-source agnostic (both direct and RapidAPI)
  // ---------------------------------------------------------------------------
  describe('Auth-source agnostic (direct and RapidAPI)', () => {
    it('grants access based on tier regardless of isMarketplaceRequest=false', () => {
      const req = createMockReq({
        path: '/v1/state',
        tier: CustomerTier.DEVELOPER,
        isMarketplaceRequest: false,
      } as Partial<Request>);
      const res = createMockRes();

      authorisationMiddleware(req, res, next);

      expect(next).toHaveBeenCalled();
      expect(res.status).not.toHaveBeenCalled();
    });

    it('grants access based on tier regardless of isMarketplaceRequest=true', () => {
      const req = createMockReq({
        path: '/v1/state',
        tier: CustomerTier.DEVELOPER,
        isMarketplaceRequest: true,
      } as Partial<Request>);
      const res = createMockRes();

      authorisationMiddleware(req, res, next);

      expect(next).toHaveBeenCalled();
      expect(res.status).not.toHaveBeenCalled();
    });

    it('denies access based on tier regardless of isMarketplaceRequest=true', () => {
      const req = createMockReq({
        path: '/v1/state',
        tier: CustomerTier.RETAIL,
        isMarketplaceRequest: true,
      } as Partial<Request>);
      const res = createMockRes();

      authorisationMiddleware(req, res, next);

      expect(res.status).toHaveBeenCalledWith(403);
      expect(next).not.toHaveBeenCalled();
    });
  });

  // ---------------------------------------------------------------------------
  // tierMeetsMinimum utility function
  // ---------------------------------------------------------------------------
  describe('tierMeetsMinimum utility', () => {
    it('RETAIL meets RETAIL minimum', () => {
      expect(tierMeetsMinimum(CustomerTier.RETAIL, CustomerTier.RETAIL)).toBe(true);
    });

    it('RETAIL does not meet DEVELOPER minimum', () => {
      expect(tierMeetsMinimum(CustomerTier.RETAIL, CustomerTier.DEVELOPER)).toBe(false);
    });

    it('DEVELOPER meets RETAIL minimum', () => {
      expect(tierMeetsMinimum(CustomerTier.DEVELOPER, CustomerTier.RETAIL)).toBe(true);
    });

    it('DEVELOPER meets DEVELOPER minimum', () => {
      expect(tierMeetsMinimum(CustomerTier.DEVELOPER, CustomerTier.DEVELOPER)).toBe(true);
    });

    it('DEVELOPER does not meet RESEARCH minimum', () => {
      expect(tierMeetsMinimum(CustomerTier.DEVELOPER, CustomerTier.RESEARCH)).toBe(false);
    });

    it('RESEARCH meets DEVELOPER minimum', () => {
      expect(tierMeetsMinimum(CustomerTier.RESEARCH, CustomerTier.DEVELOPER)).toBe(true);
    });

    it('RESEARCH does not meet INTERNAL minimum', () => {
      expect(tierMeetsMinimum(CustomerTier.RESEARCH, CustomerTier.INTERNAL)).toBe(false);
    });

    it('INTERNAL meets all minimums', () => {
      expect(tierMeetsMinimum(CustomerTier.INTERNAL, CustomerTier.RETAIL)).toBe(true);
      expect(tierMeetsMinimum(CustomerTier.INTERNAL, CustomerTier.DEVELOPER)).toBe(true);
      expect(tierMeetsMinimum(CustomerTier.INTERNAL, CustomerTier.RESEARCH)).toBe(true);
      expect(tierMeetsMinimum(CustomerTier.INTERNAL, CustomerTier.INTERNAL)).toBe(true);
    });
  });

  // ---------------------------------------------------------------------------
  // Path matching (prefix match)
  // ---------------------------------------------------------------------------
  describe('Path matching', () => {
    it('matches /v1/forecast/EURUSD as prefix of /v1/forecast', () => {
      const req = createMockReq({ path: '/v1/forecast/EURUSD', tier: CustomerTier.RETAIL } as Partial<Request>);
      const res = createMockRes();

      authorisationMiddleware(req, res, next);

      expect(next).toHaveBeenCalled();
    });

    it('matches case-insensitively', () => {
      const req = createMockReq({ path: '/V1/FORECAST/EURUSD', tier: CustomerTier.RETAIL } as Partial<Request>);
      const res = createMockRes();

      authorisationMiddleware(req, res, next);

      expect(next).toHaveBeenCalled();
    });

    it('does not match partial path names (e.g. /v1/forecastextra)', () => {
      const req = createMockReq({ path: '/v1/forecastextra', tier: CustomerTier.INTERNAL } as Partial<Request>);
      const res = createMockRes();

      authorisationMiddleware(req, res, next);

      // Should be denied as it doesn't match /v1/forecast (no / separator)
      expect(res.status).toHaveBeenCalledWith(403);
      expect(next).not.toHaveBeenCalled();
    });
  });
});
