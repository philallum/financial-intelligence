/**
 * Unit tests for the request-logger middleware.
 *
 * Validates:
 * - Structured JSON is emitted to stdout for every request
 * - All required fields are present in the log entry
 * - Severity is INFO for normal responses
 * - Severity is WARNING when response_time_ms > 1000ms (Req 10.5)
 * - Severity is ERROR for status_code >= 500
 * - customer_tier and subscription_plan are null for anonymous requests
 * - is_marketplace_request defaults to false when not set
 * - Logging occurs after response is sent (on 'finish' event)
 *
 * Requirements: 10.2, 10.5
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Request, Response, NextFunction } from 'express';
import { requestLogger, type StructuredLogEntry } from '../../src/api/middleware/request-logger.js';
import { EventEmitter } from 'events';

// =============================================================================
// Test Helpers
// =============================================================================

function createMockReq(overrides: Partial<Request> = {}): Request {
  return {
    method: 'GET',
    path: '/v1/forecast/EURUSD',
    requestId: 'test-request-id-abc',
    tier: undefined,
    subscriptionPlan: undefined,
    isMarketplaceRequest: undefined,
    ...overrides,
  } as unknown as Request;
}

function createMockRes(statusCode = 200): Response & EventEmitter {
  const emitter = new EventEmitter();
  const res = Object.assign(emitter, {
    statusCode,
    getHeader: vi.fn(),
    setHeader: vi.fn(),
  });
  return res as unknown as Response & EventEmitter;
}

function parseLogOutput(consoleSpy: ReturnType<typeof vi.spyOn>): StructuredLogEntry {
  const call = consoleSpy.mock.calls[0];
  return JSON.parse(call[0] as string) as StructuredLogEntry;
}

// =============================================================================
// Tests
// =============================================================================

describe('Request Logger Middleware', () => {
  let next: NextFunction;
  let consoleSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.resetAllMocks();
    next = vi.fn();
    consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    consoleSpy.mockRestore();
  });

  it('calls next() immediately without blocking', () => {
    const req = createMockReq();
    const res = createMockRes();

    requestLogger(req, res as unknown as Response, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(consoleSpy).not.toHaveBeenCalled(); // Not logged yet
  });

  it('emits structured JSON to stdout on response finish', () => {
    const req = createMockReq();
    const res = createMockRes(200);

    requestLogger(req, res as unknown as Response, next);
    res.emit('finish');

    expect(consoleSpy).toHaveBeenCalledTimes(1);
    const entry = parseLogOutput(consoleSpy);
    expect(entry).toHaveProperty('severity');
    expect(entry).toHaveProperty('request_id');
    expect(entry).toHaveProperty('method');
    expect(entry).toHaveProperty('path');
    expect(entry).toHaveProperty('status_code');
    expect(entry).toHaveProperty('response_time_ms');
    expect(entry).toHaveProperty('customer_tier');
    expect(entry).toHaveProperty('subscription_plan');
    expect(entry).toHaveProperty('is_marketplace_request');
    expect(entry).toHaveProperty('timestamp');
  });

  it('includes correct request fields in the log entry', () => {
    const req = createMockReq({
      method: 'GET',
      path: '/v1/similarity/EURUSD',
      requestId: 'uuid-123-456',
    } as Partial<Request>);
    const res = createMockRes(200);

    requestLogger(req, res as unknown as Response, next);
    res.emit('finish');

    const entry = parseLogOutput(consoleSpy);
    expect(entry.request_id).toBe('uuid-123-456');
    expect(entry.method).toBe('GET');
    expect(entry.path).toBe('/v1/similarity/EURUSD');
    expect(entry.status_code).toBe(200);
  });

  it('sets severity to INFO for normal responses (status < 500, time <= 1000ms)', () => {
    const req = createMockReq();
    const res = createMockRes(200);

    requestLogger(req, res as unknown as Response, next);
    res.emit('finish');

    const entry = parseLogOutput(consoleSpy);
    expect(entry.severity).toBe('INFO');
  });

  it('sets severity to ERROR for status_code >= 500', () => {
    const req = createMockReq();
    const res = createMockRes(500);

    requestLogger(req, res as unknown as Response, next);
    res.emit('finish');

    const entry = parseLogOutput(consoleSpy);
    expect(entry.severity).toBe('ERROR');
  });

  it('sets severity to ERROR for 503 status', () => {
    const req = createMockReq();
    const res = createMockRes(503);

    requestLogger(req, res as unknown as Response, next);
    res.emit('finish');

    const entry = parseLogOutput(consoleSpy);
    expect(entry.severity).toBe('ERROR');
  });

  it('sets severity to WARNING when response_time_ms > 1000ms (Req 10.5)', () => {
    const req = createMockReq();
    const res = createMockRes(200);

    // Mock Date.now to simulate slow response
    const now = Date.now();
    vi.spyOn(Date, 'now')
      .mockReturnValueOnce(now) // start time
      .mockReturnValueOnce(now + 1500); // finish time (1500ms later)

    requestLogger(req, res as unknown as Response, next);
    res.emit('finish');

    const entry = parseLogOutput(consoleSpy);
    expect(entry.severity).toBe('WARNING');
    expect(entry.response_time_ms).toBe(1500);
  });

  it('prefers ERROR over WARNING when both conditions are met (slow + 500)', () => {
    const req = createMockReq();
    const res = createMockRes(500);

    const now = Date.now();
    vi.spyOn(Date, 'now')
      .mockReturnValueOnce(now)
      .mockReturnValueOnce(now + 2000);

    requestLogger(req, res as unknown as Response, next);
    res.emit('finish');

    const entry = parseLogOutput(consoleSpy);
    expect(entry.severity).toBe('ERROR');
  });

  it('sets customer_tier and subscription_plan to null for anonymous requests', () => {
    const req = createMockReq({
      tier: undefined,
      subscriptionPlan: undefined,
      anonymous: true,
    } as Partial<Request>);
    const res = createMockRes(200);

    requestLogger(req, res as unknown as Response, next);
    res.emit('finish');

    const entry = parseLogOutput(consoleSpy);
    expect(entry.customer_tier).toBeNull();
    expect(entry.subscription_plan).toBeNull();
  });

  it('includes customer_tier and subscription_plan for authenticated requests', () => {
    const req = createMockReq({
      tier: 'DEVELOPER' as any,
      subscriptionPlan: 'PROFESSIONAL' as any,
    } as Partial<Request>);
    const res = createMockRes(200);

    requestLogger(req, res as unknown as Response, next);
    res.emit('finish');

    const entry = parseLogOutput(consoleSpy);
    expect(entry.customer_tier).toBe('DEVELOPER');
    expect(entry.subscription_plan).toBe('PROFESSIONAL');
  });

  it('defaults is_marketplace_request to false when not set', () => {
    const req = createMockReq({ isMarketplaceRequest: undefined } as Partial<Request>);
    const res = createMockRes(200);

    requestLogger(req, res as unknown as Response, next);
    res.emit('finish');

    const entry = parseLogOutput(consoleSpy);
    expect(entry.is_marketplace_request).toBe(false);
  });

  it('sets is_marketplace_request to true for RapidAPI requests', () => {
    const req = createMockReq({ isMarketplaceRequest: true } as Partial<Request>);
    const res = createMockRes(200);

    requestLogger(req, res as unknown as Response, next);
    res.emit('finish');

    const entry = parseLogOutput(consoleSpy);
    expect(entry.is_marketplace_request).toBe(true);
  });

  it('emits timestamp in ISO 8601 format', () => {
    const req = createMockReq();
    const res = createMockRes(200);

    requestLogger(req, res as unknown as Response, next);
    res.emit('finish');

    const entry = parseLogOutput(consoleSpy);
    // ISO 8601 format check
    expect(new Date(entry.timestamp).toISOString()).toBe(entry.timestamp);
  });

  it('uses "unknown" for request_id when not set', () => {
    const req = createMockReq({ requestId: undefined } as Partial<Request>);
    const res = createMockRes(200);

    requestLogger(req, res as unknown as Response, next);
    res.emit('finish');

    const entry = parseLogOutput(consoleSpy);
    expect(entry.request_id).toBe('unknown');
  });

  it('records response_time_ms as a non-negative number', () => {
    const req = createMockReq();
    const res = createMockRes(200);

    requestLogger(req, res as unknown as Response, next);
    res.emit('finish');

    const entry = parseLogOutput(consoleSpy);
    expect(entry.response_time_ms).toBeGreaterThanOrEqual(0);
    expect(typeof entry.response_time_ms).toBe('number');
  });
});
