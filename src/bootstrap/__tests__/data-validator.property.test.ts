import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';
import {
  checkOHLCInvariant,
  computeExpectedTimestamps,
  validateCandles,
} from '../data-validator.js';
import type { CandleRecord } from '../types.js';

// ─── Shared Generators ──────────────────────────────────────────────────────

/** The 4H forex slot hours within a day */
const FOREX_4H_HOURS = [0, 4, 8, 12, 16, 20];

/**
 * Generate a valid CandleRecord satisfying OHLC invariant:
 * high >= max(open, close) and low <= min(open, close)
 */
function arbValidCandle(timestamp: string): fc.Arbitrary<CandleRecord> {
  return fc
    .record({
      open: fc.double({ min: 0.5, max: 2.0, noNaN: true, noDefaultInfinity: true }),
      close: fc.double({ min: 0.5, max: 2.0, noNaN: true, noDefaultInfinity: true }),
      highExtra: fc.double({ min: 0, max: 0.5, noNaN: true, noDefaultInfinity: true }),
      lowExtra: fc.double({ min: 0, max: 0.5, noNaN: true, noDefaultInfinity: true }),
      volume: fc.double({ min: 0, max: 100000, noNaN: true, noDefaultInfinity: true }),
    })
    .map(({ open, close, highExtra, lowExtra, volume }) => ({
      timestamp_utc: timestamp,
      open,
      high: Math.max(open, close) + highExtra,
      low: Math.min(open, close) - lowExtra,
      close,
      volume,
    }));
}

/**
 * Generate a CandleRecord that violates the OHLC invariant.
 * Either high < max(open, close) OR low > min(open, close).
 */
function arbViolatingCandle(timestamp: string): fc.Arbitrary<CandleRecord> {
  return fc
    .record({
      open: fc.double({ min: 0.5, max: 2.0, noNaN: true, noDefaultInfinity: true }),
      close: fc.double({ min: 0.5, max: 2.0, noNaN: true, noDefaultInfinity: true }),
      deficit: fc.double({ min: 0.0001, max: 0.5, noNaN: true, noDefaultInfinity: true }),
      volume: fc.double({ min: 0, max: 100000, noNaN: true, noDefaultInfinity: true }),
      violationType: fc.constantFrom('high', 'low', 'both'),
    })
    .map(({ open, close, deficit, volume, violationType }) => {
      const maxOC = Math.max(open, close);
      const minOC = Math.min(open, close);

      let high: number;
      let low: number;

      if (violationType === 'high') {
        // high < max(open, close) — violates high constraint
        high = maxOC - deficit;
        low = minOC - deficit; // valid low
      } else if (violationType === 'low') {
        // low > min(open, close) — violates low constraint
        high = maxOC + deficit; // valid high
        low = minOC + deficit;
      } else {
        // both violated
        high = maxOC - deficit;
        low = minOC + deficit;
      }

      return {
        timestamp_utc: timestamp,
        open,
        high,
        low,
        close,
        volume,
      };
    });
}

/**
 * Generate a Monday 00:00 UTC date within a reasonable range.
 */
function arbMondayStart(): fc.Arbitrary<Date> {
  // Generate a year between 2018 and 2024, then pick a week
  return fc
    .record({
      year: fc.integer({ min: 2018, max: 2024 }),
      week: fc.integer({ min: 1, max: 50 }),
    })
    .map(({ year, week }) => {
      // Find the first Monday of the year
      const jan1 = new Date(Date.UTC(year, 0, 1));
      const dayOfWeek = jan1.getUTCDay();
      // Days until next Monday (if Jan 1 is Monday, offset = 0)
      const daysToMonday = dayOfWeek === 0 ? 1 : dayOfWeek === 1 ? 0 : 8 - dayOfWeek;
      const firstMonday = new Date(
        Date.UTC(year, 0, 1 + daysToMonday + (week - 1) * 7)
      );
      firstMonday.setUTCHours(0, 0, 0, 0);
      return firstMonday;
    });
}

/**
 * Generate all 4H forex timestamps for a complete trading week starting from a Monday.
 * Returns timestamps Mon 00:00 through Fri 20:00 (30 total).
 */
function generateWeekTimestamps(monday: Date): string[] {
  const timestamps: string[] = [];
  for (let day = 0; day < 5; day++) {
    for (const hour of FOREX_4H_HOURS) {
      const ts = new Date(monday.getTime());
      ts.setUTCDate(ts.getUTCDate() + day);
      ts.setUTCHours(hour, 0, 0, 0);
      timestamps.push(ts.toISOString());
    }
  }
  return timestamps;
}

// ─── Property 5: OHLC Invariant Validation ──────────────────────────────────

/**
 * Feature: historical-data-bootstrap, Property 5: OHLC Invariant Validation
 *
 * Valid candles pass; violating candles fail with correct constraint identification.
 * - Generate valid candles: pick open/close, then set high >= max(open,close) and
 *   low <= min(open,close) → checkOHLCInvariant returns true
 * - Generate violating candles (high < max(open,close) OR low > min(open,close))
 *   → checkOHLCInvariant returns false
 * - For the full validateCandles function, a set of all-valid candles should
 *   return valid=true; a set with one violation should return valid=false with
 *   the correct constraint identified
 *
 * **Validates: Requirements 2.1, 2.2**
 */
describe('Property 5: OHLC Invariant Validation', () => {
  it('checkOHLCInvariant returns true for any candle satisfying high >= max(open,close) and low <= min(open,close)', () => {
    fc.assert(
      fc.property(
        arbValidCandle('2020-01-06T00:00:00.000Z'),
        (candle: CandleRecord) => {
          expect(checkOHLCInvariant(candle)).toBe(true);
        }
      ),
      { numRuns: 100 }
    );
  });

  it('checkOHLCInvariant returns false for any candle violating the OHLC invariant', () => {
    fc.assert(
      fc.property(
        arbViolatingCandle('2020-01-06T00:00:00.000Z'),
        (candle: CandleRecord) => {
          expect(checkOHLCInvariant(candle)).toBe(false);
        }
      ),
      { numRuns: 100 }
    );
  });

  it('validateCandles returns valid=true for a set of all-valid candles', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 20 }).chain((count) => {
          // Generate `count` valid candles on consecutive 4H forex slots
          const timestamps: string[] = [];
          const baseDate = new Date('2020-01-06T00:00:00.000Z'); // Monday
          for (let i = 0; i < count; i++) {
            const day = Math.floor(i / 6);
            const slot = i % 6;
            const ts = new Date(baseDate.getTime());
            ts.setUTCDate(ts.getUTCDate() + day);
            ts.setUTCHours(FOREX_4H_HOURS[slot], 0, 0, 0);
            // Only include weekdays (Mon-Fri)
            if (ts.getUTCDay() >= 1 && ts.getUTCDay() <= 5) {
              timestamps.push(ts.toISOString());
            }
          }
          // If we have no valid timestamps (unlikely), just use one
          if (timestamps.length === 0) {
            timestamps.push('2020-01-06T00:00:00.000Z');
          }
          return fc.tuple(
            ...timestamps.map((ts) => arbValidCandle(ts))
          );
        }),
        (candles: CandleRecord[]) => {
          const result = validateCandles(candles, 'EURUSD');
          expect(result.valid).toBe(true);
          expect(result.ohlcViolations).toHaveLength(0);
        }
      ),
      { numRuns: 100 }
    );
  });

  it('validateCandles returns valid=false with correct constraint when one candle violates', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 4 }),
        arbViolatingCandle('2020-01-06T04:00:00.000Z'),
        (prefixCount: number, violating: CandleRecord) => {
          // Build a list of valid candles followed by a violating one
          const candles: CandleRecord[] = [];
          const baseDate = new Date('2020-01-06T00:00:00.000Z');
          for (let i = 0; i < prefixCount; i++) {
            const ts = new Date(baseDate.getTime());
            ts.setUTCHours(FOREX_4H_HOURS[i], 0, 0, 0);
            candles.push({
              timestamp_utc: ts.toISOString(),
              open: 1.12,
              high: 1.15,
              low: 1.10,
              close: 1.13,
              volume: 1000,
            });
          }
          // Insert the violating candle
          candles.push(violating);

          const result = validateCandles(candles, 'EURUSD');
          expect(result.valid).toBe(false);
          expect(result.ohlcViolations.length).toBeGreaterThan(0);

          // Verify constraint identification is correct
          for (const violation of result.ohlcViolations) {
            if (violation.constraint === 'high < max(open,close)') {
              const c = candles[violation.rowNumber - 1];
              expect(c.high).toBeLessThan(Math.max(c.open, c.close));
            } else {
              const c = candles[violation.rowNumber - 1];
              expect(c.low).toBeGreaterThan(Math.min(c.open, c.close));
            }
          }
        }
      ),
      { numRuns: 100 }
    );
  });
});

// ─── Property 6: Gap Detection Completeness ─────────────────────────────────

/**
 * Feature: historical-data-bootstrap, Property 6: Gap Detection Completeness
 *
 * Removed timestamps from a sequence are exactly the detected gaps (no false
 * positives/negatives). Generate a complete sequence of forex 4H timestamps for
 * a date range, randomly remove some from the middle, create candle records for
 * the remaining, and run validateCandles. The detected gap timestamps should be
 * exactly the removed ones (limited to first 10).
 *
 * **Validates: Requirements 2.3**
 */
describe('Property 6: Gap Detection Completeness', () => {
  it('detected gaps are exactly the timestamps removed from a complete forex sequence', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 2 }).chain((weeks) => {
          // Use a fixed Monday start for predictability
          const monday = new Date('2020-01-06T00:00:00.000Z');
          const allTimestamps = generateWeekTimestamps(monday);

          // Extend for additional weeks
          const fullTimestamps: string[] = [...allTimestamps];
          for (let w = 1; w < weeks; w++) {
            const nextMonday = new Date(monday.getTime());
            nextMonday.setUTCDate(nextMonday.getUTCDate() + 7 * w);
            fullTimestamps.push(...generateWeekTimestamps(nextMonday));
          }

          // We need at least 3 timestamps to remove from the middle
          if (fullTimestamps.length < 3) {
            return fc.constant({
              remaining: fullTimestamps,
              removed: [] as string[],
            });
          }

          // Generate indices to remove (from the middle only, keep first and last)
          const middleIndices = Array.from(
            { length: fullTimestamps.length - 2 },
            (_, i) => i + 1
          );

          return fc
            .subarray(middleIndices, { minLength: 1, maxLength: Math.min(15, middleIndices.length) })
            .map((indicesToRemove) => {
              const removeSet = new Set(indicesToRemove);
              const remaining = fullTimestamps.filter((_, i) => !removeSet.has(i));
              const removed = fullTimestamps.filter((_, i) => removeSet.has(i));
              return { remaining, removed };
            });
        }),
        ({ remaining, removed }) => {
          if (removed.length === 0) return; // nothing to test

          // Create valid candle records for the remaining timestamps
          const candles: CandleRecord[] = remaining.map((ts) => ({
            timestamp_utc: ts,
            open: 1.12,
            high: 1.15,
            low: 1.10,
            close: 1.13,
            volume: 1000,
          }));

          const result = validateCandles(candles, 'EURUSD');
          expect(result.valid).toBe(true);

          // The detected gaps (expected timestamps) should match removed ones
          const detectedGapTimestamps = result.gaps.map((g) => g.expectedTimestamp);

          // Sort removed chronologically for comparison
          const sortedRemoved = [...removed].sort(
            (a, b) => new Date(a).getTime() - new Date(b).getTime()
          );

          // validateCandles reports at most 10 gaps
          const expectedGaps = sortedRemoved.slice(0, 10);
          const actualGaps = detectedGapTimestamps.slice(0, 10);

          expect(actualGaps).toEqual(expectedGaps);
        }
      ),
      { numRuns: 100 }
    );
  });
});

// ─── Property 7: Expected Candle Count Formula ──────────────────────────────

/**
 * Feature: historical-data-bootstrap, Property 7: Expected Candle Count Formula
 *
 * Complete forex weeks produce weeks × 30 expected candles. Generate a random
 * number of complete weeks (1-10), set start to a Monday 00:00 UTC and end to
 * the corresponding Friday 20:00 UTC, and verify computeExpectedTimestamps
 * produces exactly weeks × 30 timestamps.
 *
 * **Validates: Requirements 2.5**
 */
describe('Property 7: Expected Candle Count Formula', () => {
  it('complete forex weeks produce exactly weeks × 30 expected candles', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 10 }),
        arbMondayStart(),
        (weeks: number, monday: Date) => {
          // Start: Monday 00:00 UTC
          const start = new Date(monday.getTime());
          start.setUTCHours(0, 0, 0, 0);

          // End: Friday 20:00 UTC of the last week
          // Friday = Monday + (weeks - 1) * 7 days + 4 days
          const end = new Date(start.getTime());
          end.setUTCDate(end.getUTCDate() + (weeks - 1) * 7 + 4);
          end.setUTCHours(20, 0, 0, 0);

          const timestamps = computeExpectedTimestamps(start, end);

          expect(timestamps).toHaveLength(weeks * 30);
        }
      ),
      { numRuns: 100 }
    );
  });
});
