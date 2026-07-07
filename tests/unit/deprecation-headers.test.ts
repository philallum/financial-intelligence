/**
 * Unit tests for the deprecation header middleware.
 *
 * **Validates: Requirements 12.2**
 *
 * Property 19: Deprecated Endpoint Headers
 *
 * Verifies that deprecated/sunset endpoints include correct Sunset and Deprecation
 * headers in RFC 9110 IMF-fixdate format, plus a Link header for migration guidance.
 *
 * Requirements: 12.2
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Request, Response, NextFunction } from 'express';

// =============================================================================
// Module Mocks
// =============================================================================

vi.mock('../../src/api/middleware/authorisation.js', () => ({
  ENDPOINT_METADATA: [
    {
      path: '/v1/legacy',
      minimumTier: 'RETAIL',
      version: '1.0.0',
      status: 'deprecated',
      deprecationDate: '2025-01-15',
      sunsetDate: '2026-01-15',
    },
    {
      path: '/v1/sunset-endpoint',
      minimumTier: 'DEVELOPER',
      version: '1.0.0',
      status: 'sunset',
      deprecationDate: '2024-06-01',
      sunsetDate: '2025-06-01',
    },
    {
      path: '/v1/forecast',
      minimumTier: 'RETAIL',
      version: '1.0.0',
      status: 'active',
    },
  ],
}));

import { deprecationMiddleware } from '../../src/api/middleware/deprecation.js';

// =============================================================================
// Test Helpers
// =============================================================================

function createMockReq(path: string): Request {
  return {
    path,
    method: 'GET',
    headers: {},
  } as unknown as Request;
}

function createMockRes() {
  const headers: Record<string, string> = {};
  const res = {
    setHeader: vi.fn((name: string, value: string) => {
      headers[name] = value;
    }),
    getHeader: vi.fn((name: string) => headers[name]),
    _headers: headers,
  };
  return res as unknown as Response & { _headers: Record<string, string> };
}

// =============================================================================
// Tests
// =============================================================================

describe('Deprecation Header Middleware', () => {
  let next: NextFunction;

  beforeEach(() => {
    vi.clearAllMocks();
    next = vi.fn();
  });

  // ---------------------------------------------------------------------------
  // 1. Deprecated endpoint adds correct headers
  // ---------------------------------------------------------------------------
  describe('Deprecated endpoint headers', () => {
    it('adds Deprecation, Sunset, and Link headers for a deprecated endpoint', () => {
      const req = createMockReq('/v1/legacy');
      const res = createMockRes();

      deprecationMiddleware(req, res, next);

      expect(res.setHeader).toHaveBeenCalledWith(
        'Deprecation',
        expect.stringMatching(/\w{3}, \d{2} \w{3} \d{4} \d{2}:\d{2}:\d{2} GMT/),
      );
      expect(res.setHeader).toHaveBeenCalledWith(
        'Sunset',
        expect.stringMatching(/\w{3}, \d{2} \w{3} \d{4} \d{2}:\d{2}:\d{2} GMT/),
      );
      expect(res.setHeader).toHaveBeenCalledWith(
        'Link',
        '<https://docs.fxintelligence.io/migration/v1/legacy>; rel="successor-version"',
      );
    });

    it('formats Deprecation header as RFC 9110 IMF-fixdate', () => {
      const req = createMockReq('/v1/legacy');
      const res = createMockRes();

      deprecationMiddleware(req, res, next);

      // deprecationDate: '2025-01-15' → "Wed, 15 Jan 2025 00:00:00 GMT"
      expect(res.setHeader).toHaveBeenCalledWith(
        'Deprecation',
        'Wed, 15 Jan 2025 00:00:00 GMT',
      );
    });

    it('formats Sunset header as RFC 9110 IMF-fixdate', () => {
      const req = createMockReq('/v1/legacy');
      const res = createMockRes();

      deprecationMiddleware(req, res, next);

      // sunsetDate: '2026-01-15' → "Thu, 15 Jan 2026 00:00:00 GMT"
      expect(res.setHeader).toHaveBeenCalledWith(
        'Sunset',
        'Thu, 15 Jan 2026 00:00:00 GMT',
      );
    });
  });

  // ---------------------------------------------------------------------------
  // 2. Sunset endpoint adds same headers
  // ---------------------------------------------------------------------------
  describe('Sunset endpoint headers', () => {
    it('adds Deprecation, Sunset, and Link headers for a sunset endpoint', () => {
      const req = createMockReq('/v1/sunset-endpoint');
      const res = createMockRes();

      deprecationMiddleware(req, res, next);

      // deprecationDate: '2024-06-01' → "Sat, 01 Jun 2024 00:00:00 GMT"
      expect(res.setHeader).toHaveBeenCalledWith(
        'Deprecation',
        'Sat, 01 Jun 2024 00:00:00 GMT',
      );
      // sunsetDate: '2025-06-01' → "Sun, 01 Jun 2025 00:00:00 GMT"
      expect(res.setHeader).toHaveBeenCalledWith(
        'Sunset',
        'Sun, 01 Jun 2025 00:00:00 GMT',
      );
      expect(res.setHeader).toHaveBeenCalledWith(
        'Link',
        '<https://docs.fxintelligence.io/migration/v1/sunset-endpoint>; rel="successor-version"',
      );
    });
  });

  // ---------------------------------------------------------------------------
  // 3. Active endpoint does NOT get deprecation headers
  // ---------------------------------------------------------------------------
  describe('Active endpoint — no deprecation headers', () => {
    it('does not add Deprecation, Sunset, or Link headers for an active endpoint', () => {
      const req = createMockReq('/v1/forecast');
      const res = createMockRes();

      deprecationMiddleware(req, res, next);

      expect(res.setHeader).not.toHaveBeenCalled();
    });
  });

  // ---------------------------------------------------------------------------
  // 4. Unknown endpoint — no deprecation headers
  // ---------------------------------------------------------------------------
  describe('Unknown endpoint — no deprecation headers', () => {
    it('does not add headers for an endpoint not in ENDPOINT_METADATA', () => {
      const req = createMockReq('/v1/unknown-endpoint');
      const res = createMockRes();

      deprecationMiddleware(req, res, next);

      expect(res.setHeader).not.toHaveBeenCalled();
    });
  });

  // ---------------------------------------------------------------------------
  // 5. next() is always called
  // ---------------------------------------------------------------------------
  describe('next() always called', () => {
    it('calls next() for a deprecated endpoint', () => {
      const req = createMockReq('/v1/legacy');
      const res = createMockRes();

      deprecationMiddleware(req, res, next);

      expect(next).toHaveBeenCalledOnce();
    });

    it('calls next() for a sunset endpoint', () => {
      const req = createMockReq('/v1/sunset-endpoint');
      const res = createMockRes();

      deprecationMiddleware(req, res, next);

      expect(next).toHaveBeenCalledOnce();
    });

    it('calls next() for an active endpoint', () => {
      const req = createMockReq('/v1/forecast');
      const res = createMockRes();

      deprecationMiddleware(req, res, next);

      expect(next).toHaveBeenCalledOnce();
    });

    it('calls next() for an unknown endpoint', () => {
      const req = createMockReq('/v1/not-registered');
      const res = createMockRes();

      deprecationMiddleware(req, res, next);

      expect(next).toHaveBeenCalledOnce();
    });
  });

  // ---------------------------------------------------------------------------
  // 6. Date format correctness
  // ---------------------------------------------------------------------------
  describe('RFC 9110 IMF-fixdate format', () => {
    it('produces a date matching the "Day, DD Mon YYYY HH:MM:SS GMT" pattern', () => {
      const req = createMockReq('/v1/sunset-endpoint');
      const res = createMockRes();

      deprecationMiddleware(req, res, next);

      // sunsetDate: '2025-06-01' → "Sun, 01 Jun 2025 00:00:00 GMT"
      const expectedSunsetDate = 'Sun, 01 Jun 2025 00:00:00 GMT';
      expect(res.setHeader).toHaveBeenCalledWith('Sunset', expectedSunsetDate);

      // Verify the pattern explicitly
      const imfFixdatePattern = /^[A-Z][a-z]{2}, \d{2} [A-Z][a-z]{2} \d{4} \d{2}:\d{2}:\d{2} GMT$/;
      expect(expectedSunsetDate).toMatch(imfFixdatePattern);
    });
  });
});
