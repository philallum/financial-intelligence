/**
 * Unit tests for the method-not-allowed middleware.
 *
 * Validates:
 * - Unsupported HTTP methods receive 405 with error code "method_not_allowed" (Req 14.5)
 * - Allow header lists supported methods
 * - Supported methods (GET, OPTIONS) pass through to next()
 * - request_id is included in response when available
 *
 * Requirements: 14.5
 */

import { describe, it, expect, vi } from 'vitest';
import type { Request, Response, NextFunction } from 'express';
import { methodNotAllowed } from '../../src/api/middleware/method-not-allowed.js';

// =============================================================================
// Test Helpers
// =============================================================================

function createMockReq(method: string, requestId?: string): Request {
  return {
    method,
    path: '/v1/forecast/EURUSD',
    headers: {},
    requestId,
  } as unknown as Request;
}

function createMockRes() {
  const headers = new Map<string, string>();
  const res = {
    statusCode: 200,
    jsonBody: null as unknown,
    setHeader: vi.fn().mockImplementation((key: string, value: string) => {
      headers.set(key, value);
      return res;
    }),
    status: vi.fn().mockImplementation((code: number) => {
      res.statusCode = code;
      return res;
    }),
    json: vi.fn().mockImplementation((body: unknown) => {
      res.jsonBody = body;
      return res;
    }),
    getHeader: (key: string) => headers.get(key),
    _headers: headers,
  };
  return res as unknown as Response & { jsonBody: unknown; _headers: Map<string, string> };
}

// =============================================================================
// Tests
// =============================================================================

describe('methodNotAllowed middleware (Req 14.5)', () => {
  const middleware = methodNotAllowed(['GET']);

  describe('allowed methods pass through', () => {
    it('calls next() for GET requests', () => {
      const req = createMockReq('GET');
      const res = createMockRes();
      const next = vi.fn();

      middleware(req, res, next as NextFunction);

      expect(next).toHaveBeenCalledTimes(1);
      expect(res.status).not.toHaveBeenCalled();
    });

    it('calls next() for OPTIONS requests (implicit allow)', () => {
      const req = createMockReq('OPTIONS');
      const res = createMockRes();
      const next = vi.fn();

      middleware(req, res, next as NextFunction);

      expect(next).toHaveBeenCalledTimes(1);
      expect(res.status).not.toHaveBeenCalled();
    });
  });

  describe('disallowed methods return 405', () => {
    it('returns 405 for POST requests', () => {
      const req = createMockReq('POST');
      const res = createMockRes();
      const next = vi.fn();

      middleware(req, res, next as NextFunction);

      expect(res.status).toHaveBeenCalledWith(405);
      expect(next).not.toHaveBeenCalled();
    });

    it('returns 405 for PUT requests', () => {
      const req = createMockReq('PUT');
      const res = createMockRes();
      const next = vi.fn();

      middleware(req, res, next as NextFunction);

      expect(res.status).toHaveBeenCalledWith(405);
      expect(next).not.toHaveBeenCalled();
    });

    it('returns 405 for DELETE requests', () => {
      const req = createMockReq('DELETE');
      const res = createMockRes();
      const next = vi.fn();

      middleware(req, res, next as NextFunction);

      expect(res.status).toHaveBeenCalledWith(405);
      expect(next).not.toHaveBeenCalled();
    });

    it('returns 405 for PATCH requests', () => {
      const req = createMockReq('PATCH');
      const res = createMockRes();
      const next = vi.fn();

      middleware(req, res, next as NextFunction);

      expect(res.status).toHaveBeenCalledWith(405);
      expect(next).not.toHaveBeenCalled();
    });
  });

  describe('response format', () => {
    it('includes error code "method_not_allowed"', () => {
      const req = createMockReq('POST');
      const res = createMockRes();
      const next = vi.fn();

      middleware(req, res, next as NextFunction);

      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({ error: 'method_not_allowed' })
      );
    });

    it('sets Allow header with supported methods', () => {
      const req = createMockReq('POST');
      const res = createMockRes();
      const next = vi.fn();

      middleware(req, res, next as NextFunction);

      expect(res.setHeader).toHaveBeenCalledWith('Allow', 'GET, OPTIONS');
    });

    it('includes allowed_methods array in the response body', () => {
      const req = createMockReq('DELETE');
      const res = createMockRes();
      const next = vi.fn();

      middleware(req, res, next as NextFunction);

      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({ allowed_methods: ['GET', 'OPTIONS'] })
      );
    });

    it('includes request_id when available on the request', () => {
      const req = createMockReq('POST', 'abc-123-def');
      const res = createMockRes();
      const next = vi.fn();

      middleware(req, res, next as NextFunction);

      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({ request_id: 'abc-123-def' })
      );
    });

    it('omits request_id when not set on the request', () => {
      const req = createMockReq('POST');
      const res = createMockRes();
      const next = vi.fn();

      middleware(req, res, next as NextFunction);

      const body = (res.json as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(body).not.toHaveProperty('request_id');
    });

    it('includes a descriptive message with the HTTP method', () => {
      const req = createMockReq('PUT');
      const res = createMockRes();
      const next = vi.fn();

      middleware(req, res, next as NextFunction);

      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          message: 'HTTP method PUT is not supported for this endpoint.',
        })
      );
    });
  });

  describe('case insensitivity', () => {
    it('handles lowercase method names', () => {
      const req = createMockReq('get');
      const res = createMockRes();
      const next = vi.fn();

      middleware(req, res, next as NextFunction);

      expect(next).toHaveBeenCalledTimes(1);
    });
  });

  describe('multiple allowed methods', () => {
    const multiMethodMiddleware = methodNotAllowed(['GET', 'POST']);

    it('allows both GET and POST', () => {
      const reqGet = createMockReq('GET');
      const reqPost = createMockReq('POST');
      const res1 = createMockRes();
      const res2 = createMockRes();
      const next = vi.fn();

      multiMethodMiddleware(reqGet, res1, next as NextFunction);
      multiMethodMiddleware(reqPost, res2, next as NextFunction);

      expect(next).toHaveBeenCalledTimes(2);
    });

    it('rejects DELETE and includes GET, POST, OPTIONS in Allow header', () => {
      const req = createMockReq('DELETE');
      const res = createMockRes();
      const next = vi.fn();

      multiMethodMiddleware(req, res, next as NextFunction);

      expect(res.status).toHaveBeenCalledWith(405);
      expect(res.setHeader).toHaveBeenCalledWith('Allow', 'GET, POST, OPTIONS');
    });
  });
});
