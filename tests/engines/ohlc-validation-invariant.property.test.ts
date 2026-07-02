/**
 * Property-Based Test: OHLC Validation Invariant
 *
 * Property 8: OHLC Validation Invariant
 * For any OHLC candle data, the Platform SHALL accept the candle if and only if:
 * - high >= max(open, close)
 * - low <= min(open, close)
 * - high >= low
 * - all prices are positive (> 0)
 *
 * Any candle violating these constraints SHALL be rejected before database persistence.
 *
 * **Validates: Requirements 17.1, 17.6**
 */

import { describe, it, expect } from "vitest";
import * as fc from "fast-check";
import type { OHLC } from "../../src/types/index.js";

// =============================================================================
// Validation Function Under Test
// =============================================================================

/**
 * Pure OHLC validation function implementing the geometric candle invariant.
 *
 * A valid OHLC candle must satisfy ALL of:
 * 1. high >= max(open, close) — high is the highest price in the period
 * 2. low <= min(open, close) — low is the lowest price in the period
 * 3. high >= low — high is always >= low
 * 4. All values are positive (> 0) — prices cannot be zero or negative
 */
export function isValidOHLC(ohlc: OHLC): boolean {
  const { open, high, low, close } = ohlc;

  // Condition 4: All values positive
  if (open <= 0 || high <= 0 || low <= 0 || close <= 0) {
    return false;
  }

  // Condition 1: high >= max(open, close)
  if (high < Math.max(open, close)) {
    return false;
  }

  // Condition 2: low <= min(open, close)
  if (low > Math.min(open, close)) {
    return false;
  }

  // Condition 3: high >= low
  if (high < low) {
    return false;
  }

  return true;
}

// =============================================================================
// Arbitraries
// =============================================================================

/** Positive price value suitable for OHLC data. */
const arbPositivePrice = fc.double({
  min: 0.0001,
  max: 10000,
  noNaN: true,
  noDefaultInfinity: true,
});

/**
 * Generate a deliberately valid OHLC candle by construction:
 * - Pick open and close
 * - Set high = max(open, close) + positive delta
 * - Set low = min(open, close) - positive delta (clamped to stay positive)
 */
const arbValidOHLC: fc.Arbitrary<OHLC> = fc
  .record({
    open: arbPositivePrice,
    close: arbPositivePrice,
    highDelta: fc.double({ min: 0, max: 100, noNaN: true, noDefaultInfinity: true }),
    lowDelta: fc.double({ min: 0, max: 0.99, noNaN: true, noDefaultInfinity: true }),
  })
  .map(({ open, close, highDelta, lowDelta }) => {
    const high = Math.max(open, close) + highDelta;
    // Ensure low stays positive: low = min(open, close) * (1 - lowDelta fraction)
    const minOC = Math.min(open, close);
    const low = minOC * (1 - lowDelta * 0.5); // At most 50% reduction, always positive since minOC > 0
    return { open, high, low, close };
  });

/**
 * Generate a completely random OHLC (may or may not be valid).
 * Uses arbitrary positive doubles for all 4 fields.
 */
const arbRandomOHLC: fc.Arbitrary<OHLC> = fc.record({
  open: arbPositivePrice,
  high: arbPositivePrice,
  low: arbPositivePrice,
  close: arbPositivePrice,
});

/**
 * Generate an OHLC candle with at least one negative or zero value.
 */
const arbNonPositiveOHLC: fc.Arbitrary<OHLC> = fc
  .record({
    open: fc.double({ min: -100, max: 0, noNaN: true, noDefaultInfinity: true }),
    high: arbPositivePrice,
    low: arbPositivePrice,
    close: arbPositivePrice,
    whichField: fc.integer({ min: 0, max: 3 }),
  })
  .map(({ open, high, low, close, whichField }) => {
    // Place the non-positive value in a specific field
    const negativeVal = open; // This is <= 0
    switch (whichField) {
      case 0:
        return { open: negativeVal, high, low, close };
      case 1:
        return { open: high, high: negativeVal, low, close };
      case 2:
        return { open: high, high, low: negativeVal, close };
      case 3:
        return { open: high, high, low, close: negativeVal };
      default:
        return { open: negativeVal, high, low, close };
    }
  });

/**
 * Generate an OHLC where high < low (violates condition 3).
 */
const arbHighLessThanLow: fc.Arbitrary<OHLC> = fc
  .record({
    base: fc.double({ min: 1, max: 100, noNaN: true, noDefaultInfinity: true }),
    gap: fc.double({ min: 0.01, max: 50, noNaN: true, noDefaultInfinity: true }),
  })
  .map(({ base, gap }) => ({
    open: base,
    high: base, // high = base
    low: base + gap, // low > high → invalid
    close: base,
  }));

// =============================================================================
// Property Tests
// =============================================================================

describe("Property 8: OHLC Validation Invariant", () => {
  it("deliberately valid OHLC candles are always accepted", () => {
    fc.assert(
      fc.property(arbValidOHLC, (ohlc) => {
        expect(isValidOHLC(ohlc)).toBe(true);
      }),
      { numRuns: 500 },
    );
  });

  it("random OHLC: isValidOHLC returns true IFF all 4 conditions hold", () => {
    fc.assert(
      fc.property(arbRandomOHLC, (ohlc) => {
        const { open, high, low, close } = ohlc;

        // Manually check all 4 conditions
        const allPositive = open > 0 && high > 0 && low > 0 && close > 0;
        const highGteMaxOC = high >= Math.max(open, close);
        const lowLteMinOC = low <= Math.min(open, close);
        const highGteLow = high >= low;

        const shouldBeValid = allPositive && highGteMaxOC && lowLteMinOC && highGteLow;
        expect(isValidOHLC(ohlc)).toBe(shouldBeValid);
      }),
      { numRuns: 1000 },
    );
  });

  it("OHLC with non-positive values is always rejected", () => {
    fc.assert(
      fc.property(arbNonPositiveOHLC, (ohlc) => {
        expect(isValidOHLC(ohlc)).toBe(false);
      }),
      { numRuns: 200 },
    );
  });

  it("OHLC with high < low is always rejected", () => {
    fc.assert(
      fc.property(arbHighLessThanLow, (ohlc) => {
        expect(isValidOHLC(ohlc)).toBe(false);
      }),
      { numRuns: 200 },
    );
  });

  it("validation is deterministic: same OHLC always gets the same result", () => {
    fc.assert(
      fc.property(arbRandomOHLC, (ohlc) => {
        const result1 = isValidOHLC(ohlc);
        const result2 = isValidOHLC(ohlc);
        expect(result1).toBe(result2);
      }),
      { numRuns: 500 },
    );
  });

  it("conditions are exhaustive: no valid candle fails, no invalid candle passes", () => {
    fc.assert(
      fc.property(
        fc.double({ min: -50, max: 500, noNaN: true, noDefaultInfinity: true }),
        fc.double({ min: -50, max: 500, noNaN: true, noDefaultInfinity: true }),
        fc.double({ min: -50, max: 500, noNaN: true, noDefaultInfinity: true }),
        fc.double({ min: -50, max: 500, noNaN: true, noDefaultInfinity: true }),
        (open, high, low, close) => {
          const ohlc: OHLC = { open, high, low, close };

          const allPositive = open > 0 && high > 0 && low > 0 && close > 0;
          const highGteMaxOC = high >= Math.max(open, close);
          const lowLteMinOC = low <= Math.min(open, close);
          const highGteLow = high >= low;

          const allConditionsMet = allPositive && highGteMaxOC && lowLteMinOC && highGteLow;

          // Exhaustive: the function agrees with the conditions exactly
          expect(isValidOHLC(ohlc)).toBe(allConditionsMet);
        },
      ),
      { numRuns: 1000 },
    );
  });
});
