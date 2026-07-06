/**
 * Unit tests for the security headers middleware.
 *
 * Validates:
 * - All security headers are set on every response (Req 15.1)
 * - HTTPS enforcement in production (Req 15.3)
 * - Non-production environments allow HTTP traffic
 *
 * Requirements: 15.1, 15.3
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Request, Response, NextFunction } from 'express';
import { securityHeaders } from '../../src/api/middleware/security.js';

// =============================================================================
// Test Helpers
// =============================================================================

function createMockReq(overrides: Partial<Request> = {}): Request {
  return {
    method: 'GET',
    path: '/v1/forecast/EURUSD',
    headers: {},
    ...overrides,
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

describe('securityHeaders middleware', () => {
  const originalEnv = process.env.NODE_ENV;

  afterEach(() => {
    process.env.NODE_ENV = originalEnv;
  });

  describe('security headers (Req 15.1)', () => {
    it('sets X-Content-Type-Options to nosniff', () => {
      const req = createMockReq();
      const res = createMockRes();
      const next = vi.fn();

      securityHeaders(req, res, next as NextFunction);

      expect(res.setHeader).toHaveBeenCalledWith('X-Content-Type-Options', 'nosniff');
    });

    it('sets X-Frame-Options to DENY', () => {
      const req = createMockReq();
      const res = createMockRes();
      const next = vi.fn();

      securityHeaders(req, res, next as NextFunction);

      expect(res.setHeader).toHaveBeenCalledWith('X-Frame-Options', 'DENY');
    });

    it('sets Strict-Transport-Security with includeSubDomains', () => {
      const req = createMockReq();
      const res = createMockRes();
      const next = vi.fn();

      securityHeaders(req, res, next as NextFunction);

      expect(res.setHeader).toHaveBeenCalledWith(
        'Strict-Transport-Security',
        'max-age=31536000; includeSubDomains'
      );
    });

    it('sets X-XSS-Protection to 0', () => {
      const req = createMockReq();
      const res = createMockRes();
      const next = vi.fn();

      securityHeaders(req, res, next as NextFunction);

      expect(res.setHeader).toHaveBeenCalledWith('X-XSS-Protection', '0');
    });

    it('calls next() in non-production environment', () => {
      process.env.NODE_ENV = 'test';
      const req = createMockReq();
      const res = createMockRes();
      const next = vi.fn();

      securityHeaders(req, res, next as NextFunction);

      expect(next).toHaveBeenCalledTimes(1);
    });
  });

  describe('HTTPS enforcement in production (Req 15.3)', () => {
    beforeEach(() => {
      process.env.NODE_ENV = 'production';
    });

    it('returns 403 when X-Forwarded-Proto is not https', () => {
      const req = createMockReq({ headers: { 'x-forwarded-proto': 'http' } });
      const res = createMockRes();
      const next = vi.fn();

      securityHeaders(req, res, next as NextFunction);

      expect(res.status).toHaveBeenCalledWith(403);
      expect(res.json).toHaveBeenCalledWith({
        error: 'https_required',
        message: 'HTTPS is mandatory.',
      });
      expect(next).not.toHaveBeenCalled();
    });

    it('returns 403 when X-Forwarded-Proto header is missing', () => {
      const req = createMockReq({ headers: {} });
      const res = createMockRes();
      const next = vi.fn();

      securityHeaders(req, res, next as NextFunction);

      expect(res.status).toHaveBeenCalledWith(403);
      expect(res.json).toHaveBeenCalledWith({
        error: 'https_required',
        message: 'HTTPS is mandatory.',
      });
      expect(next).not.toHaveBeenCalled();
    });

    it('allows request when X-Forwarded-Proto is https', () => {
      const req = createMockReq({ headers: { 'x-forwarded-proto': 'https' } });
      const res = createMockRes();
      const next = vi.fn();

      securityHeaders(req, res, next as NextFunction);

      expect(next).toHaveBeenCalledTimes(1);
      expect(res.status).not.toHaveBeenCalled();
    });

    it('still sets security headers before rejecting non-HTTPS requests', () => {
      const req = createMockReq({ headers: { 'x-forwarded-proto': 'http' } });
      const res = createMockRes();
      const next = vi.fn();

      securityHeaders(req, res, next as NextFunction);

      expect(res.setHeader).toHaveBeenCalledWith('X-Content-Type-Options', 'nosniff');
      expect(res.setHeader).toHaveBeenCalledWith('X-Frame-Options', 'DENY');
      expect(res.setHeader).toHaveBeenCalledWith(
        'Strict-Transport-Security',
        'max-age=31536000; includeSubDomains'
      );
      expect(res.setHeader).toHaveBeenCalledWith('X-XSS-Protection', '0');
    });
  });

  describe('non-production environments', () => {
    it('allows HTTP in development', () => {
      process.env.NODE_ENV = 'development';
      const req = createMockReq({ headers: { 'x-forwarded-proto': 'http' } });
      const res = createMockRes();
      const next = vi.fn();

      securityHeaders(req, res, next as NextFunction);

      expect(next).toHaveBeenCalledTimes(1);
      expect(res.status).not.toHaveBeenCalled();
    });

    it('allows HTTP in test', () => {
      process.env.NODE_ENV = 'test';
      const req = createMockReq({ headers: { 'x-forwarded-proto': 'http' } });
      const res = createMockRes();
      const next = vi.fn();

      securityHeaders(req, res, next as NextFunction);

      expect(next).toHaveBeenCalledTimes(1);
      expect(res.status).not.toHaveBeenCalled();
    });
  });
});
