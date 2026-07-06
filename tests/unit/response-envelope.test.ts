/**
 * Unit tests for response envelope helpers.
 *
 * Validates:
 * - successResponse wraps data with meta containing request_id and ISO timestamp
 * - errorResponse returns error code, message, and request_id
 *
 * Requirements: 6.2, 6.3, 6.4
 */

import { describe, it, expect } from 'vitest';
import { successResponse, errorResponse } from '../../src/api/utils/response-envelope.js';

const ISO_8601_REGEX = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}.\d{3}Z$/;
const UUID_V4 = 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d';

describe('successResponse', () => {
  it('wraps data in standard envelope with meta', () => {
    const data = { forecast: 'bullish', confidence: 0.82 };
    const result = successResponse(data, UUID_V4);

    expect(result.data).toEqual(data);
    expect(result.meta.request_id).toBe(UUID_V4);
    expect(result.meta.timestamp).toMatch(ISO_8601_REGEX);
  });

  it('preserves null data', () => {
    const result = successResponse(null, UUID_V4);

    expect(result.data).toBeNull();
    expect(result.meta.request_id).toBe(UUID_V4);
  });

  it('preserves array data', () => {
    const data = [{ asset: 'EURUSD' }, { asset: 'GBPUSD' }];
    const result = successResponse(data, UUID_V4);

    expect(result.data).toEqual(data);
    expect(result.data).toHaveLength(2);
  });

  it('includes ISO 8601 UTC timestamp', () => {
    const before = new Date().toISOString();
    const result = successResponse({}, UUID_V4);
    const after = new Date().toISOString();

    expect(result.meta.timestamp >= before).toBe(true);
    expect(result.meta.timestamp <= after).toBe(true);
  });
});

describe('errorResponse', () => {
  it('returns structured error with machine-readable code', () => {
    const result = errorResponse('unauthorized', 'Invalid API key.', UUID_V4);

    expect(result.error).toBe('unauthorized');
    expect(result.message).toBe('Invalid API key.');
    expect(result.request_id).toBe(UUID_V4);
  });

  it('handles not_found error', () => {
    const result = errorResponse('not_found', 'Resource not found.', UUID_V4);

    expect(result.error).toBe('not_found');
    expect(result.message).toBe('Resource not found.');
    expect(result.request_id).toBe(UUID_V4);
  });

  it('handles rate_limit_exceeded error', () => {
    const result = errorResponse('rate_limit_exceeded', 'Too many requests.', UUID_V4);

    expect(result.error).toBe('rate_limit_exceeded');
    expect(result.message).toBe('Too many requests.');
    expect(result.request_id).toBe(UUID_V4);
  });
});
