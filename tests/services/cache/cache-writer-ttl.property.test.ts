/**
 * Property-Based Test: Cache TTL Calculation (Cache Writer)
 *
 * Property 10: Cache TTL Calculation
 * For any timestamp within a 4H candle window, the computed TTL SHALL equal
 * the difference between the candle window end time and the current time.
 * For timestamps where remaining time < 60 seconds, TTL SHALL be set to 0.
 *
 * **Validates: Requirements 6.1, 6.2**
 */

import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';
import { computeCacheTTL } from '../../../src/services/cache/cache-writer.js';
import { UTC_GRID_BOUNDARIES, CACHE_MIN_TTL_SECONDS } from '../../../src/config/constants.js';

// =============================================================================
// Arbitraries
// =============================================================================

/** Valid UTC grid boundary hours */
const GRID_HOURS = [0, 4, 8, 12, 16, 20] as const;

/**
 * Generates a random Date within a reasonable range.
 * Uses random year (2020-2030), month, day, hour, minute, second, millisecond.
 */
const arbTimestamp: fc.Arbitrary<Date> = fc
  .record({
    year: fc.integer({ min: 2020, max: 2030 }),
    month: fc.integer({ min: 0, max: 11 }),
    day: fc.integer({ min: 1, max: 28 }), // safe for all months
    hour: fc.integer({ min: 0, max: 23 }),
    minute: fc.integer({ min: 0, max: 59 }),
    second: fc.integer({ min: 0, max: 59 }),
    millisecond: fc.integer({ min: 0, max: 999 }),
  })
  .map(({ year, month, day, hour, minute, second, millisecond }) => {
    const d = new Date(Date.UTC(year, month, day, hour, minute, second, millisecond));
    return d;
  });

/**
 * Generates a timestamp exactly on a UTC 4H grid boundary.
 */
const arbBoundaryTimestamp: fc.Arbitrary<Date> = fc
  .record({
    year: fc.integer({ min: 2020, max: 2030 }),
    month: fc.integer({ min: 0, max: 11 }),
    day: fc.integer({ min: 1, max: 28 }),
    hour: fc.constantFrom(...GRID_HOURS),
  })
  .map(({ year, month, day, hour }) => {
    return new Date(Date.UTC(year, month, day, hour, 0, 0, 0));
  });

// =============================================================================
// Helper: compute expected window end for a given timestamp
// =============================================================================

function expectedWindowEnd(timestamp: Date): Date {
  const hour = timestamp.getUTCHours();
  const minutes = timestamp.getUTCMinutes();
  const seconds = timestamp.getUTCSeconds();
  const ms = timestamp.getUTCMilliseconds();

  // Check if exactly on a boundary
  const isExactBoundary =
    GRID_HOURS.includes(hour as (typeof GRID_HOURS)[number]) &&
    minutes === 0 &&
    seconds === 0 &&
    ms === 0;

  let nextBoundaryHour: number | undefined;
  for (const boundary of GRID_HOURS) {
    if (boundary > hour) {
      nextBoundaryHour = boundary;
      break;
    }
  }

  const windowEnd = new Date(timestamp);
  if (isExactBoundary) {
    // On a boundary: next boundary is the one after current hour
    if (nextBoundaryHour !== undefined) {
      windowEnd.setUTCHours(nextBoundaryHour, 0, 0, 0);
    } else {
      // hour is 20, next is 00:00 next day
      windowEnd.setUTCDate(windowEnd.getUTCDate() + 1);
      windowEnd.setUTCHours(0, 0, 0, 0);
    }
  } else if (nextBoundaryHour !== undefined) {
    windowEnd.setUTCHours(nextBoundaryHour, 0, 0, 0);
  } else {
    // After hour 20, wrap to next day
    windowEnd.setUTCDate(windowEnd.getUTCDate() + 1);
    windowEnd.setUTCHours(0, 0, 0, 0);
  }

  return windowEnd;
}

// =============================================================================
// Property Tests
// =============================================================================

describe('Property 10: Cache TTL Calculation', () => {
  it('TTL = floor((windowEnd - currentTime) / 1000) for any timestamp', () => {
    fc.assert(
      fc.property(arbTimestamp, (timestamp: Date) => {
        const { ttlSeconds, windowEnd } = computeCacheTTL(timestamp);

        // TTL must equal floor of millisecond difference / 1000
        const expectedTTL = Math.floor(
          (windowEnd.getTime() - timestamp.getTime()) / 1000,
        );
        expect(ttlSeconds).toBe(expectedTTL);
      }),
      { numRuns: 150 },
    );
  });

  it('windowEnd is always a valid UTC 4H grid boundary', () => {
    fc.assert(
      fc.property(arbTimestamp, (timestamp: Date) => {
        const { windowEnd } = computeCacheTTL(timestamp);

        // windowEnd hour must be one of 0, 4, 8, 12, 16, 20
        expect(GRID_HOURS).toContain(windowEnd.getUTCHours());
        // minutes, seconds, milliseconds must all be 0
        expect(windowEnd.getUTCMinutes()).toBe(0);
        expect(windowEnd.getUTCSeconds()).toBe(0);
        expect(windowEnd.getUTCMilliseconds()).toBe(0);
      }),
      { numRuns: 150 },
    );
  });

  it('windowEnd is always after the input timestamp (or equal if on boundary)', () => {
    fc.assert(
      fc.property(arbTimestamp, (timestamp: Date) => {
        const { windowEnd } = computeCacheTTL(timestamp);

        // windowEnd must be >= timestamp
        expect(windowEnd.getTime()).toBeGreaterThan(timestamp.getTime());
      }),
      { numRuns: 150 },
    );
  });

  it('ttlSeconds is non-negative and at most 4 hours (14400 seconds)', () => {
    fc.assert(
      fc.property(arbTimestamp, (timestamp: Date) => {
        const { ttlSeconds } = computeCacheTTL(timestamp);

        expect(ttlSeconds).toBeGreaterThanOrEqual(0);
        expect(ttlSeconds).toBeLessThanOrEqual(4 * 60 * 60);
      }),
      { numRuns: 150 },
    );
  });

  it('timestamps exactly on grid boundaries yield ttlSeconds = 4 * 60 * 60 (full window)', () => {
    fc.assert(
      fc.property(arbBoundaryTimestamp, (timestamp: Date) => {
        const { ttlSeconds, windowEnd } = computeCacheTTL(timestamp);

        // Exactly on a boundary means we're at the start of a new window
        expect(ttlSeconds).toBe(4 * 60 * 60);

        // Window end should be exactly 4 hours after
        const expectedEnd = new Date(timestamp.getTime() + 4 * 60 * 60 * 1000);
        expect(windowEnd.getTime()).toBe(expectedEnd.getTime());
      }),
      { numRuns: 100 },
    );
  });

  it('when TTL < 60 seconds, caching should be skipped (TTL below CACHE_MIN_TTL_SECONDS)', () => {
    // Generate timestamps that are within 59 seconds of the next boundary
    const arbNearBoundaryTimestamp: fc.Arbitrary<Date> = fc
      .record({
        year: fc.integer({ min: 2020, max: 2030 }),
        month: fc.integer({ min: 0, max: 11 }),
        day: fc.integer({ min: 1, max: 28 }),
        hour: fc.constantFrom(...GRID_HOURS),
        // 1–59 seconds before the boundary (seconds remaining < 60)
        secondsBefore: fc.integer({ min: 1, max: 59 }),
      })
      .map(({ year, month, day, hour, secondsBefore }) => {
        // Create the boundary time
        const boundary = new Date(Date.UTC(year, month, day, hour, 0, 0, 0));
        // Subtract secondsBefore to get a timestamp just before the boundary
        return new Date(boundary.getTime() - secondsBefore * 1000);
      });

    fc.assert(
      fc.property(arbNearBoundaryTimestamp, (timestamp: Date) => {
        const { ttlSeconds } = computeCacheTTL(timestamp);

        // TTL must be less than CACHE_MIN_TTL_SECONDS (60)
        expect(ttlSeconds).toBeLessThan(CACHE_MIN_TTL_SECONDS);
        expect(ttlSeconds).toBeGreaterThanOrEqual(0);
      }),
      { numRuns: 100 },
    );
  });
});
