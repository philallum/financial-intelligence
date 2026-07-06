/**
 * Unit tests for the request-id middleware.
 *
 * Validates:
 * - UUID v4 is assigned to req.requestId on every request
 * - X-Request-ID response header is set with the same UUID
 * - next() is called to continue the middleware chain
 * - Each request gets a unique ID
 *
 * Requirements: 10.1
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Request, Response, NextFunction } from 'express';
import { requestId } from '../../src/api/middleware/request-id.js';

// =============================================================================
// Test Helpers
// =============================================================================

const UUID_V4_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function createMockReq(): Request {
  return {
    method: 'GET',
    path: '/v1/forecast/EURUSD',
    headers: {},
    requestId: undefined,
  } as unknown as Request;
}

function createMockRes() {
  const headers: Record<string, string> = {};
  const res = {
    setHeader: vi.fn().mockImplementation((name: string, value: string) => {
      headers[name] = value;
      return res;
    }),
    getHeader: (name: string) => headers[name],
    _headers: headers,
  };
  return res as unknown as Response & { _headers: Record<string, string> };
}

// =============================================================================
// Tests
// =============================================================================

describe('Request ID Middleware', () => {
  let next: NextFunction;

  beforeEach(() => {
    vi.resetAllMocks();
    next = vi.fn();
  });

  it('assigns a UUID v4 to req.requestId', () => {
    const req = createMockReq();
    const res = createMockRes();

    requestId(req, res, next);

    expect(req.requestId).toBeDefined();
    expect(req.requestId).toMatch(UUID_V4_REGEX);
  });

  it('sets X-Request-ID response header with the same UUID', () => {
    const req = createMockReq();
    const res = createMockRes();

    requestId(req, res, next);

    expect(res.setHeader).toHaveBeenCalledWith('X-Request-ID', req.requestId);
    expect(res._headers['X-Request-ID']).toBe(req.requestId);
  });

  it('calls next() to continue the middleware chain', () => {
    const req = createMockReq();
    const res = createMockRes();

    requestId(req, res, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(next).toHaveBeenCalledWith();
  });

  it('generates unique IDs for consecutive requests', () => {
    const req1 = createMockReq();
    const res1 = createMockRes();
    const req2 = createMockReq();
    const res2 = createMockRes();

    requestId(req1, res1, next);
    requestId(req2, res2, next);

    expect(req1.requestId).not.toBe(req2.requestId);
    expect(req1.requestId).toMatch(UUID_V4_REGEX);
    expect(req2.requestId).toMatch(UUID_V4_REGEX);
  });

  it('does not modify other request properties', () => {
    const req = createMockReq();
    const res = createMockRes();

    requestId(req, res, next);

    expect(req.method).toBe('GET');
    expect(req.path).toBe('/v1/forecast/EURUSD');
  });
});
