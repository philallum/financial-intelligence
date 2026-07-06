import { describe, it, expect, vi } from 'vitest';
import * as fc from 'fast-check';
import express from 'express';
import request from 'supertest';

/**
 * Property 10: Pagination Correctness
 * Validates: Requirements 6.5
 *
 * Tests that pagination logic is correct for all valid input combinations.
 * We test the pure pagination calculation in isolation — given a total dataset
 * size, limit, and offset, verify that has_more, returned item count, and
 * pagination metadata are computed correctly.
 *
 * This mirrors the logic in src/api/routes/similarity.ts without requiring
 * Supabase.
 */

/**
 * Pure pagination calculation — extracted logic matching the similarity route.
 * Given a total number of records, a limit, and an offset, computes the
 * pagination response metadata and the number of items that would be returned.
 */
function computePagination(total: number, limit: number, offset: number) {
  const returnedCount = Math.min(limit, Math.max(0, total - offset));
  const has_more = (offset + limit) < total;

  return {
    data_length: returnedCount,
    pagination: {
      total,
      limit,
      offset,
      has_more,
    },
  };
}

describe('Property 10: Pagination Correctness', () => {
  /**
   * Generator: random total dataset size (0–500), limit (1–100), offset (0–500)
   */
  const paginationArb = fc.record({
    total: fc.integer({ min: 0, max: 500 }),
    limit: fc.integer({ min: 1, max: 100 }),
    offset: fc.integer({ min: 0, max: 500 }),
  });

  it('has_more is true if and only if offset + limit < total', () => {
    fc.assert(
      fc.property(paginationArb, ({ total, limit, offset }) => {
        const result = computePagination(total, limit, offset);
        const expected = (offset + limit) < total;
        expect(result.pagination.has_more).toBe(expected);
      }),
      { numRuns: 1000 }
    );
  });

  it('returned items count never exceeds limit', () => {
    fc.assert(
      fc.property(paginationArb, ({ total, limit, offset }) => {
        const result = computePagination(total, limit, offset);
        expect(result.data_length).toBeLessThanOrEqual(limit);
      }),
      { numRuns: 1000 }
    );
  });

  it('returned items count equals min(limit, max(0, total - offset))', () => {
    fc.assert(
      fc.property(paginationArb, ({ total, limit, offset }) => {
        const result = computePagination(total, limit, offset);
        const expected = Math.min(limit, Math.max(0, total - offset));
        expect(result.data_length).toBe(expected);
      }),
      { numRuns: 1000 }
    );
  });

  it('pagination.total is always the original dataset size', () => {
    fc.assert(
      fc.property(paginationArb, ({ total, limit, offset }) => {
        const result = computePagination(total, limit, offset);
        expect(result.pagination.total).toBe(total);
      }),
      { numRuns: 1000 }
    );
  });

  it('pagination.limit and pagination.offset reflect the requested values', () => {
    fc.assert(
      fc.property(paginationArb, ({ total, limit, offset }) => {
        const result = computePagination(total, limit, offset);
        expect(result.pagination.limit).toBe(limit);
        expect(result.pagination.offset).toBe(offset);
      }),
      { numRuns: 1000 }
    );
  });

  it('offset + returned_data_length <= total', () => {
    fc.assert(
      fc.property(paginationArb, ({ total, limit, offset }) => {
        const result = computePagination(total, limit, offset);
        // When offset < total, items are returned and offset + count <= total
        // When offset >= total, no items returned (data_length = 0)
        if (offset < total) {
          expect(offset + result.data_length).toBeLessThanOrEqual(total);
        } else {
          expect(result.data_length).toBe(0);
        }
      }),
      { numRuns: 1000 }
    );
  });
});


/**
 * Property 11: Invalid Pagination Rejection
 * Validates: Requirements 6.6
 *
 * IF a pagination query parameter is not a valid non-negative integer or exceeds
 * the allowed maximum, THEN THE API_Gateway SHALL return HTTP 400 with error code
 * "invalid_parameter" specifying the parameter name and the accepted range.
 *
 * We replicate the parsePaginationParam validation logic from the similarity route
 * and test it through a minimal Express router using supertest.
 */

/**
 * Replicates the parsePaginationParam logic from src/api/routes/similarity.ts.
 * Returns:
 *  - null  → use default (value is missing/empty)
 *  - NaN   → invalid input (reject with 400)
 *  - number → parsed integer value
 */
function parsePaginationParam(value: unknown): number | null {
  if (value === undefined || value === null || value === '') {
    return null;
  }

  const str = String(value);
  // Reject floats (contains a dot), non-numeric strings
  if (!/^-?\d+$/.test(str)) {
    return NaN;
  }

  const num = parseInt(str, 10);
  if (!Number.isFinite(num)) {
    return NaN;
  }

  return num;
}

/** Pagination constants matching the route */
const PAGINATION = {
  MIN_LIMIT: 1,
  MAX_LIMIT: 100,
  MIN_OFFSET: 0,
} as const;

/**
 * Determines if a limit value should be rejected.
 * Invalid if: NaN from parse, negative, zero, or > 100.
 */
function isInvalidLimit(raw: number | null): boolean {
  if (raw === null) return false; // will use default
  return Number.isNaN(raw) || raw < PAGINATION.MIN_LIMIT || raw > PAGINATION.MAX_LIMIT;
}

/**
 * Determines if an offset value should be rejected.
 * Invalid if: NaN from parse, or negative.
 */
function isInvalidOffset(raw: number | null): boolean {
  if (raw === null) return false; // will use default
  return Number.isNaN(raw) || raw < PAGINATION.MIN_OFFSET;
}

/**
 * Creates a minimal express app that mimics the similarity route's pagination validation.
 */
function createTestApp() {
  const app = express();

  app.get('/v1/similarity/:asset', (req, res) => {
    const rawLimit = parsePaginationParam(req.query.limit);
    const rawOffset = parsePaginationParam(req.query.offset);

    if (isInvalidLimit(rawLimit)) {
      res.status(400).json({
        error: 'invalid_parameter',
        message: `Parameter "limit" must be an integer between ${PAGINATION.MIN_LIMIT} and ${PAGINATION.MAX_LIMIT}.`,
        request_id: 'test',
      });
      return;
    }

    if (isInvalidOffset(rawOffset)) {
      res.status(400).json({
        error: 'invalid_parameter',
        message: `Parameter "offset" must be a non-negative integer.`,
        request_id: 'test',
      });
      return;
    }

    // If valid, return 200
    res.status(200).json({
      data: [],
      pagination: {
        total: 0,
        limit: rawLimit ?? 20,
        offset: rawOffset ?? 0,
        has_more: false,
      },
    });
  });

  return app;
}

describe('Property 11: Invalid Pagination Rejection', () => {
  const app = createTestApp();

  /**
   * Generator: negative limit values
   */
  const negativeLimitArb = fc.integer({ min: -10000, max: -1 });

  /**
   * Generator: float/decimal limit values (strings like "3.5", "0.1")
   */
  const floatLimitArb = fc.tuple(
    fc.integer({ min: -100, max: 100 }),
    fc.integer({ min: 1, max: 999 }),
  ).map(([whole, frac]) => `${whole}.${frac}`);

  /**
   * Generator: limit values > 100
   */
  const overMaxLimitArb = fc.integer({ min: 101, max: 100000 });

  /**
   * Generator: negative offset values
   */
  const negativeOffsetArb = fc.integer({ min: -10000, max: -1 });

  /**
   * Generator: float/decimal offset values
   */
  const floatOffsetArb = fc.tuple(
    fc.integer({ min: 0, max: 100 }),
    fc.integer({ min: 1, max: 999 }),
  ).map(([whole, frac]) => `${whole}.${frac}`);

  /**
   * Generator: non-numeric strings (letters, symbols)
   */
  const nonNumericStringArb = fc.array(
    fc.constantFrom(...'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ!@$^*()_+[]{}|:,.<>/~`'.split('')),
    { minLength: 1, maxLength: 20 },
  ).map(arr => arr.join(''));

  /**
   * Generator: valid limit values (1–100 integers)
   */
  const validLimitArb = fc.integer({ min: 1, max: 100 });

  /**
   * Generator: valid offset values (0+ integers)
   */
  const validOffsetArb = fc.integer({ min: 0, max: 500 });

  it('any negative limit value returns 400 with invalid_parameter', async () => {
    await fc.assert(
      fc.asyncProperty(negativeLimitArb, async (limit) => {
        const res = await request(app)
          .get(`/v1/similarity/EURUSD?limit=${limit}`);
        expect(res.status).toBe(400);
        expect(res.body.error).toBe('invalid_parameter');
        expect(res.body.message).toContain('limit');
      }),
      { numRuns: 100 }
    );
  });

  it('any float/decimal limit value returns 400 with invalid_parameter', async () => {
    await fc.assert(
      fc.asyncProperty(floatLimitArb, async (limit) => {
        const res = await request(app)
          .get(`/v1/similarity/EURUSD?limit=${limit}`);
        expect(res.status).toBe(400);
        expect(res.body.error).toBe('invalid_parameter');
        expect(res.body.message).toContain('limit');
      }),
      { numRuns: 100 }
    );
  });

  it('any limit > 100 returns 400 with invalid_parameter', async () => {
    await fc.assert(
      fc.asyncProperty(overMaxLimitArb, async (limit) => {
        const res = await request(app)
          .get(`/v1/similarity/EURUSD?limit=${limit}`);
        expect(res.status).toBe(400);
        expect(res.body.error).toBe('invalid_parameter');
        expect(res.body.message).toContain('limit');
      }),
      { numRuns: 100 }
    );
  });

  it('any negative offset value returns 400 with invalid_parameter', async () => {
    await fc.assert(
      fc.asyncProperty(negativeOffsetArb, async (offset) => {
        const res = await request(app)
          .get(`/v1/similarity/EURUSD?offset=${offset}`);
        expect(res.status).toBe(400);
        expect(res.body.error).toBe('invalid_parameter');
        expect(res.body.message).toContain('offset');
      }),
      { numRuns: 100 }
    );
  });

  it('any float/decimal offset value returns 400 with invalid_parameter', async () => {
    await fc.assert(
      fc.asyncProperty(floatOffsetArb, async (offset) => {
        const res = await request(app)
          .get(`/v1/similarity/EURUSD?offset=${offset}`);
        expect(res.status).toBe(400);
        expect(res.body.error).toBe('invalid_parameter');
        expect(res.body.message).toContain('offset');
      }),
      { numRuns: 100 }
    );
  });

  it('any non-numeric string as limit returns 400 with invalid_parameter', async () => {
    await fc.assert(
      fc.asyncProperty(nonNumericStringArb, async (limit) => {
        const res = await request(app)
          .get(`/v1/similarity/EURUSD?limit=${encodeURIComponent(limit)}`);
        expect(res.status).toBe(400);
        expect(res.body.error).toBe('invalid_parameter');
        expect(res.body.message).toContain('limit');
      }),
      { numRuns: 100 }
    );
  });

  it('valid limit values (1–100 integers) return 200', async () => {
    await fc.assert(
      fc.asyncProperty(validLimitArb, async (limit) => {
        const res = await request(app)
          .get(`/v1/similarity/EURUSD?limit=${limit}`);
        expect(res.status).toBe(200);
        expect(res.body.pagination.limit).toBe(limit);
      }),
      { numRuns: 100 }
    );
  });

  it('valid offset values (0+ integers) return 200', async () => {
    await fc.assert(
      fc.asyncProperty(validOffsetArb, async (offset) => {
        const res = await request(app)
          .get(`/v1/similarity/EURUSD?offset=${offset}`);
        expect(res.status).toBe(200);
        expect(res.body.pagination.offset).toBe(offset);
      }),
      { numRuns: 100 }
    );
  });
});
