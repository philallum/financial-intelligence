import { describe, it, expect, vi } from 'vitest';
import * as fc from 'fast-check';
import {
  sizeGuard,
  MAX_BODY_SIZE_BYTES,
  MAX_URL_LENGTH,
  MAX_QUERY_PARAM_VALUE_LENGTH,
} from '../../src/api/middleware/size-guard.js';
import type { Request, Response, NextFunction } from 'express';

/**
 * Property 14: Request Size Rejection
 * Validates: Requirements 15.2, 15.5
 *
 * For any request with body size, URL length, or query param value length
 * near their respective boundaries, the size guard middleware must correctly
 * accept or reject based on the defined limits.
 */

// --- Helpers ---

function createMockReq(overrides: Partial<Request> = {}): Request {
  return {
    headers: {},
    originalUrl: '/v1/forecast',
    url: '/v1/forecast',
    query: {},
    ...overrides,
  } as unknown as Request;
}

function createMockRes(): Response & { statusCode: number; body: unknown } {
  const res: any = {
    statusCode: 200,
    body: null,
    status(code: number) {
      res.statusCode = code;
      return res;
    },
    json(data: unknown) {
      res.body = data;
      return res;
    },
  };
  return res;
}

// --- Tests ---

describe('Property 14: Request Size Rejection', () => {
  /**
   * Validates: Requirements 15.2
   * Body size property: For ANY Content-Length value > 1,048,576 (1MB),
   * the middleware MUST return 413 with error code "payload_too_large".
   * For ANY Content-Length value <= 1,048,576, the middleware MUST NOT
   * reject on body size.
   */
  it('rejects bodies above MAX_BODY_SIZE_BYTES with 413 and accepts those at or below', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: MAX_BODY_SIZE_BYTES - 100, max: MAX_BODY_SIZE_BYTES + 100 }),
        (contentLength) => {
          const req = createMockReq({
            headers: { 'content-length': String(contentLength) },
          });
          const res = createMockRes();
          const next = vi.fn();

          sizeGuard(req, res, next as NextFunction);

          if (contentLength > MAX_BODY_SIZE_BYTES) {
            // Must reject with 413
            expect(res.statusCode).toBe(413);
            expect(res.body).toEqual(
              expect.objectContaining({ error: 'payload_too_large' }),
            );
            expect(next).not.toHaveBeenCalled();
          } else {
            // Must NOT reject on body size (next called or rejected for other reason)
            expect(res.statusCode).not.toBe(413);
          }
        },
      ),
      { numRuns: 200 },
    );
  });

  /**
   * Validates: Requirements 15.5
   * URL length property: For ANY URL string longer than 2048 characters,
   * the middleware MUST return 414 with error code "uri_too_long".
   * For ANY URL string <= 2048 characters, the middleware MUST NOT reject
   * on URL length.
   */
  it('rejects URLs longer than MAX_URL_LENGTH with 414 and accepts those at or below', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: MAX_URL_LENGTH - 100, max: MAX_URL_LENGTH + 100 }),
        (urlLength) => {
          // Generate a URL of the specified length starting with /
          const url = '/' + 'a'.repeat(Math.max(0, urlLength - 1));
          const req = createMockReq({
            originalUrl: url,
            url: url,
            query: {},
          });
          const res = createMockRes();
          const next = vi.fn();

          sizeGuard(req, res, next as NextFunction);

          if (urlLength > MAX_URL_LENGTH) {
            // Must reject with 414
            expect(res.statusCode).toBe(414);
            expect(res.body).toEqual(
              expect.objectContaining({ error: 'uri_too_long' }),
            );
            expect(next).not.toHaveBeenCalled();
          } else {
            // Must NOT reject on URL length
            expect(res.statusCode).not.toBe(414);
          }
        },
      ),
      { numRuns: 200 },
    );
  });

  /**
   * Validates: Requirements 15.5
   * Query param property: For ANY query parameter value longer than 512
   * characters, the middleware MUST return 414 with error code "uri_too_long".
   * For ANY query param value <= 512 characters, the middleware MUST NOT
   * reject on query param length.
   */
  it('rejects query param values longer than MAX_QUERY_PARAM_VALUE_LENGTH with 414 and accepts those at or below', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: MAX_QUERY_PARAM_VALUE_LENGTH - 100, max: MAX_QUERY_PARAM_VALUE_LENGTH + 100 }),
        fc.string({ minLength: 1, maxLength: 20 }).filter((s) => /^[a-zA-Z_]+$/.test(s)),
        (valueLength, paramName) => {
          const paramValue = 'x'.repeat(valueLength);
          const req = createMockReq({
            originalUrl: `/v1/forecast?${paramName}=${paramValue}`,
            url: `/v1/forecast?${paramName}=${paramValue}`,
            query: { [paramName]: paramValue },
          });

          // Ensure URL itself won't trigger the URL length check
          // by using a short base path (the originalUrl includes the query,
          // but we keep it under 2048 for this test)
          if (req.originalUrl!.length > MAX_URL_LENGTH) {
            // Skip this case — URL length would trigger first
            return;
          }

          const res = createMockRes();
          const next = vi.fn();

          sizeGuard(req, res, next as NextFunction);

          if (valueLength > MAX_QUERY_PARAM_VALUE_LENGTH) {
            // Must reject with 414
            expect(res.statusCode).toBe(414);
            expect(res.body).toEqual(
              expect.objectContaining({ error: 'uri_too_long' }),
            );
            expect(next).not.toHaveBeenCalled();
          } else {
            // Must NOT reject on query param length — next should be called
            expect(next).toHaveBeenCalled();
          }
        },
      ),
      { numRuns: 200 },
    );
  });
});
