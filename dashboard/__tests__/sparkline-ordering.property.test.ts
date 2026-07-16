/**
 * Property-Based Tests for Sparkline Chronological Ordering
 *
 * Feature: dashboard-multi-asset
 * Property 7: Sparkline renders candles in chronological order
 *
 * Validates: Requirements 3.2
 *
 * For any array of candle objects with timestamps (in any input order), the
 * sparkline SHALL render close prices sorted by timestamp ascending
 * (chronological order).
 */

import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';
import { getChronologicalCloses, Candle } from '../sparkline-ordering.js';

// =============================================================================
// Generators
// =============================================================================

/** Generator for a valid ISO 8601 timestamp string within a reasonable range. */
const timestampArb = fc
  .integer({
    min: new Date('2020-01-01T00:00:00Z').getTime(),
    max: new Date('2030-12-31T23:59:59Z').getTime(),
  })
  .map(ms => new Date(ms).toISOString());

/** Generator for a close price (positive finite number). */
const closePriceArb = fc.double({ min: 0.0001, max: 100000, noNaN: true });

/** Generator for a single Candle object. */
const candleArb: fc.Arbitrary<Candle> = fc
  .tuple(timestampArb, closePriceArb)
  .map(([timestamp_utc, close]) => ({ timestamp_utc, close }));

/** Generator for an array of candles with at least 2 elements. */
const candlesArb = fc.array(candleArb, { minLength: 2, maxLength: 50 });

/**
 * Generator for an array of candles with unique timestamps (at least 2).
 * Used for properties that require deterministic ordering.
 */
const uniqueTimestampCandlesArb = fc
  .uniqueArray(
    fc.tuple(
      fc.integer({
        min: new Date('2020-01-01T00:00:00Z').getTime(),
        max: new Date('2030-12-31T23:59:59Z').getTime(),
      }),
      closePriceArb,
    ),
    { minLength: 2, maxLength: 50, selector: ([ms]) => ms },
  )
  .map(pairs =>
    pairs.map(([ms, close]) => ({ timestamp_utc: new Date(ms).toISOString(), close })),
  );

// =============================================================================
// Property 7: Sparkline renders candles in chronological order
// =============================================================================

describe('Property 7: Sparkline renders candles in chronological order', () => {
  /**
   * Validates: Requirements 3.2
   *
   * The output close prices correspond to timestamps sorted in ascending order.
   */
  it('output is sorted by timestamp ascending', () => {
    fc.assert(
      fc.property(candlesArb, (candles) => {
        const closes = getChronologicalCloses(candles);
        // Sort candles by timestamp manually and compare
        const sorted = [...candles].sort(
          (a, b) => new Date(a.timestamp_utc).getTime() - new Date(b.timestamp_utc).getTime(),
        );
        const expectedCloses = sorted.map(c => c.close);
        expect(closes).toEqual(expectedCloses);
      }),
      { numRuns: 100 },
    );
  });

  /**
   * Validates: Requirements 3.2
   *
   * Shuffling the input order does not change the output — the result is
   * always the same chronological ordering regardless of input order.
   */
  it('shuffling input order does not change output', () => {
    fc.assert(
      fc.property(uniqueTimestampCandlesArb, (candles) => {
        const result1 = getChronologicalCloses(candles);
        // Create a reversed copy (deterministic reordering)
        const reversed = [...candles].reverse();
        const result2 = getChronologicalCloses(reversed);
        expect(result1).toEqual(result2);
      }),
      { numRuns: 100 },
    );
  });

  /**
   * Validates: Requirements 3.2
   *
   * The output length matches the input length when >= 2 candles are provided.
   */
  it('output length matches input length when >= 2 candles', () => {
    fc.assert(
      fc.property(candlesArb, (candles) => {
        const closes = getChronologicalCloses(candles);
        expect(closes.length).toBe(candles.length);
      }),
      { numRuns: 100 },
    );
  });

  /**
   * Validates: Requirements 3.2
   *
   * Fewer than 2 candles returns an empty array.
   */
  it('fewer than 2 candles returns empty array', () => {
    fc.assert(
      fc.property(
        fc.array(candleArb, { minLength: 0, maxLength: 1 }),
        (candles) => {
          const closes = getChronologicalCloses(candles);
          expect(closes).toEqual([]);
        },
      ),
      { numRuns: 100 },
    );
  });
});
