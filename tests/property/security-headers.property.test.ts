import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fc from 'fast-check';
import { securityHeaders } from '../../src/api/middleware/security.js';
import type { Request, Response, NextFunction } from 'express';

/**
 * Property 13: Security Headers Present on All Responses
 * Validates: Requirements 15.1
 *
 * For ANY random request method and ANY random URL path, the securityHeaders
 * middleware should ALWAYS set all 4 security headers on the response,
 * regardless of method, path, or whether the request is rejected for non-HTTPS.
 */

// --- Generators ---

/** Generator for random HTTP methods */
const httpMethodArb = fc.constantFrom(
  'GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS', 'HEAD',
);

/** Generator for random URL paths */
const urlPathArb = fc.array(
  fc.string({ minLength: 1, maxLength: 20, unit: fc.constantFrom(
    ...'abcdefghijklmnopqrstuvwxyz0123456789-_'.split(''),
  ) }),
  { minLength: 1, maxLength: 5 },
).map(segments => '/' + segments.join('/'));

// --- Mock factories ---

function createMockReq(method: string, path: string): Partial<Request> {
  return {
    method,
    path,
    url: path,
    headers: {},
  };
}

function createMockRes(): Partial<Response> & { _headers: Record<string, string> } {
  const headers: Record<string, string> = {};
  const res: Partial<Response> & { _headers: Record<string, string> } = {
    _headers: headers,
    setHeader(name: string, value: string | number | readonly string[]) {
      headers[name.toLowerCase()] = String(value);
      return res as Response;
    },
    status(code: number) {
      return res as Response;
    },
    json(body: unknown) {
      return res as Response;
    },
  };
  return res;
}

// --- Tests ---

describe('Property 13: Security Headers Present on All Responses', () => {
  const originalNodeEnv = process.env.NODE_ENV;

  beforeEach(() => {
    process.env.NODE_ENV = 'test';
  });

  afterEach(() => {
    process.env.NODE_ENV = originalNodeEnv;
  });

  /**
   * Validates: Requirements 15.1
   * For any HTTP method and any URL path, all 4 security headers are always set.
   */
  it('sets all 4 security headers for any method and path', () => {
    fc.assert(
      fc.property(httpMethodArb, urlPathArb, (method, path) => {
        const req = createMockReq(method, path) as Request;
        const res = createMockRes();
        const next: NextFunction = () => {};

        securityHeaders(req, res as unknown as Response, next);

        expect(res._headers['x-content-type-options']).toBe('nosniff');
        expect(res._headers['x-frame-options']).toBe('DENY');
        expect(res._headers['strict-transport-security']).toBe(
          'max-age=31536000; includeSubDomains',
        );
        expect(res._headers['x-xss-protection']).toBe('0');
      }),
      { numRuns: 200 },
    );
  });

  /**
   * Validates: Requirements 15.1
   * Even when HTTPS enforcement rejects the request (production + non-HTTPS),
   * the security headers are still present on the error response.
   */
  it('sets all 4 security headers even when HTTPS enforcement rejects the request', () => {
    const savedEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';

    try {
      fc.assert(
        fc.property(httpMethodArb, urlPathArb, (method, path) => {
          const req = createMockReq(method, path) as Request;
          // Non-HTTPS request in production triggers rejection
          req.headers = { 'x-forwarded-proto': 'http' };

          const res = createMockRes();
          const next: NextFunction = () => {};

          securityHeaders(req, res as unknown as Response, next);

          // Headers must still be present on the 403 rejection response
          expect(res._headers['x-content-type-options']).toBe('nosniff');
          expect(res._headers['x-frame-options']).toBe('DENY');
          expect(res._headers['strict-transport-security']).toBe(
            'max-age=31536000; includeSubDomains',
          );
          expect(res._headers['x-xss-protection']).toBe('0');
        }),
        { numRuns: 200 },
      );
    } finally {
      process.env.NODE_ENV = savedEnv;
    }
  });
});
