/**
 * Unit tests for the size guard middleware.
 *
 * Validates:
 * - Request bodies > 1MB are rejected with HTTP 413 (Req 15.2)
 * - URLs > 2048 characters are rejected with HTTP 414 (Req 15.5)
 * - Query parameter values > 512 characters are rejected with HTTP 414 (Req 15.5)
 * - Valid requests pass through to next()
 *
 * Requirements: 15.2, 15.5
 */

import { describe, it, expect, vi } from 'vitest';
import type { Request, Response, NextFunction } from 'express';
import {
  sizeGuard,
  MAX_BODY_SIZE_BYTES,
  MAX_URL_LENGTH,
  MAX_QUERY_PARAM_VALUE_LENGTH,
} from '../../src/api/middleware/size-guard.js';

// =============================================================================
// Test Helpers
// =============================================================================

function createMockReq(overrides: Partial<Request> = {}): Request {
  return {
    method: 'GET',
    path: '/v1/forecast/EURUSD',
    originalUrl: '/v1/forecast/EURUSD',
    url: '/v1/forecast/EURUSD',
    headers: {},
    query: {},
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
  return res as unknown as Response & { jsonBody: unknown };
}

// =============================================================================
// Tests
// =============================================================================

describe('sizeGuard middleware', () => {
  describe('body size check (Req 15.2)', () => {
    it('rejects requests with Content-Length > 1MB', () => {
      const req = createMockReq({
        headers: { 'content-length': String(MAX_BODY_SIZE_BYTES + 1) },
      });
      const res = createMockRes();
      const next = vi.fn();

      sizeGuard(req, res, next as NextFunction);

      expect(res.status).toHaveBeenCalledWith(413);
      expect(res.json).toHaveBeenCalledWith({
        error: 'payload_too_large',
        message: `Request body exceeds the maximum allowed size of 1MB (${MAX_BODY_SIZE_BYTES} bytes).`,
      });
      expect(next).not.toHaveBeenCalled();
    });

    it('rejects requests with Content-Length exactly exceeding 1MB', () => {
      const req = createMockReq({
        headers: { 'content-length': String(MAX_BODY_SIZE_BYTES + 100) },
      });
      const res = createMockRes();
      const next = vi.fn();

      sizeGuard(req, res, next as NextFunction);

      expect(res.status).toHaveBeenCalledWith(413);
      expect(next).not.toHaveBeenCalled();
    });

    it('allows requests with Content-Length exactly 1MB', () => {
      const req = createMockReq({
        headers: { 'content-length': String(MAX_BODY_SIZE_BYTES) },
      });
      const res = createMockRes();
      const next = vi.fn();

      sizeGuard(req, res, next as NextFunction);

      expect(next).toHaveBeenCalledTimes(1);
      expect(res.status).not.toHaveBeenCalled();
    });

    it('allows requests with Content-Length below 1MB', () => {
      const req = createMockReq({
        headers: { 'content-length': '1024' },
      });
      const res = createMockRes();
      const next = vi.fn();

      sizeGuard(req, res, next as NextFunction);

      expect(next).toHaveBeenCalledTimes(1);
    });

    it('allows requests without Content-Length header', () => {
      const req = createMockReq({ headers: {} });
      const res = createMockRes();
      const next = vi.fn();

      sizeGuard(req, res, next as NextFunction);

      expect(next).toHaveBeenCalledTimes(1);
    });

    it('ignores non-numeric Content-Length values', () => {
      const req = createMockReq({
        headers: { 'content-length': 'not-a-number' },
      });
      const res = createMockRes();
      const next = vi.fn();

      sizeGuard(req, res, next as NextFunction);

      expect(next).toHaveBeenCalledTimes(1);
    });
  });

  describe('URL length check (Req 15.5)', () => {
    it('rejects URLs longer than 2048 characters', () => {
      const longUrl = '/v1/forecast/' + 'a'.repeat(MAX_URL_LENGTH);
      const req = createMockReq({ originalUrl: longUrl });
      const res = createMockRes();
      const next = vi.fn();

      sizeGuard(req, res, next as NextFunction);

      expect(res.status).toHaveBeenCalledWith(414);
      expect(res.json).toHaveBeenCalledWith({
        error: 'uri_too_long',
        message: `Request URL exceeds the maximum allowed length of ${MAX_URL_LENGTH} characters.`,
      });
      expect(next).not.toHaveBeenCalled();
    });

    it('allows URLs exactly 2048 characters', () => {
      const exactUrl = 'a'.repeat(MAX_URL_LENGTH);
      const req = createMockReq({ originalUrl: exactUrl });
      const res = createMockRes();
      const next = vi.fn();

      sizeGuard(req, res, next as NextFunction);

      expect(next).toHaveBeenCalledTimes(1);
    });

    it('allows URLs shorter than 2048 characters', () => {
      const req = createMockReq({ originalUrl: '/v1/forecast/EURUSD' });
      const res = createMockRes();
      const next = vi.fn();

      sizeGuard(req, res, next as NextFunction);

      expect(next).toHaveBeenCalledTimes(1);
    });

    it('falls back to req.url when originalUrl is undefined', () => {
      const longUrl = '/v1/state/' + 'x'.repeat(MAX_URL_LENGTH);
      const req = createMockReq({ originalUrl: undefined as unknown as string, url: longUrl });
      const res = createMockRes();
      const next = vi.fn();

      sizeGuard(req, res, next as NextFunction);

      expect(res.status).toHaveBeenCalledWith(414);
      expect(next).not.toHaveBeenCalled();
    });
  });

  describe('query parameter value length check (Req 15.5)', () => {
    it('rejects query parameter values longer than 512 characters', () => {
      const longValue = 'x'.repeat(MAX_QUERY_PARAM_VALUE_LENGTH + 1);
      const req = createMockReq({
        query: { filter: longValue } as unknown as Request['query'],
      });
      const res = createMockRes();
      const next = vi.fn();

      sizeGuard(req, res, next as NextFunction);

      expect(res.status).toHaveBeenCalledWith(414);
      expect(res.json).toHaveBeenCalledWith({
        error: 'uri_too_long',
        message: `Query parameter "filter" exceeds the maximum allowed length of ${MAX_QUERY_PARAM_VALUE_LENGTH} characters.`,
      });
      expect(next).not.toHaveBeenCalled();
    });

    it('allows query parameter values exactly 512 characters', () => {
      const exactValue = 'x'.repeat(MAX_QUERY_PARAM_VALUE_LENGTH);
      const req = createMockReq({
        query: { filter: exactValue } as unknown as Request['query'],
      });
      const res = createMockRes();
      const next = vi.fn();

      sizeGuard(req, res, next as NextFunction);

      expect(next).toHaveBeenCalledTimes(1);
    });

    it('allows query parameter values shorter than 512 characters', () => {
      const req = createMockReq({
        query: { asset: 'EURUSD', limit: '20' } as unknown as Request['query'],
      });
      const res = createMockRes();
      const next = vi.fn();

      sizeGuard(req, res, next as NextFunction);

      expect(next).toHaveBeenCalledTimes(1);
    });

    it('rejects when any query parameter in an array exceeds 512 characters', () => {
      const longValue = 'y'.repeat(MAX_QUERY_PARAM_VALUE_LENGTH + 1);
      const req = createMockReq({
        query: { tags: ['short', longValue] } as unknown as Request['query'],
      });
      const res = createMockRes();
      const next = vi.fn();

      sizeGuard(req, res, next as NextFunction);

      expect(res.status).toHaveBeenCalledWith(414);
      expect(next).not.toHaveBeenCalled();
    });

    it('allows requests with no query parameters', () => {
      const req = createMockReq({ query: {} as Request['query'] });
      const res = createMockRes();
      const next = vi.fn();

      sizeGuard(req, res, next as NextFunction);

      expect(next).toHaveBeenCalledTimes(1);
    });

    it('identifies the correct parameter name in the error message', () => {
      const longValue = 'z'.repeat(MAX_QUERY_PARAM_VALUE_LENGTH + 1);
      const req = createMockReq({
        query: { asset: 'EURUSD', search: longValue } as unknown as Request['query'],
      });
      const res = createMockRes();
      const next = vi.fn();

      sizeGuard(req, res, next as NextFunction);

      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          message: expect.stringContaining('"search"'),
        })
      );
    });
  });

  describe('pass-through for valid requests', () => {
    it('calls next() for a normal GET request with no body', () => {
      const req = createMockReq();
      const res = createMockRes();
      const next = vi.fn();

      sizeGuard(req, res, next as NextFunction);

      expect(next).toHaveBeenCalledTimes(1);
      expect(res.status).not.toHaveBeenCalled();
    });

    it('calls next() for a POST request with acceptable body size', () => {
      const req = createMockReq({
        method: 'POST',
        headers: { 'content-length': '512' },
      });
      const res = createMockRes();
      const next = vi.fn();

      sizeGuard(req, res, next as NextFunction);

      expect(next).toHaveBeenCalledTimes(1);
    });
  });
});
