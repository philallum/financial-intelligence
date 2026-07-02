/**
 * Property-Based Test: Empirical Distribution Purity
 *
 * Property 2: Empirical Distribution Purity
 * - Generate random float arrays (forward returns)
 * - Verify formula: up = count(r > 2)/N, down = count(r < -2)/N, flat = count(|r| ≤ 2)/N, sum = 1.0
 *
 * **Validates: Requirements 1.1, 1.2, 1.5**
 */

import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';
import { FLAT_THRESHOLD } from '../../src/config/constants.js';
import { computeDirectionProbability } from '../../src/engines/outcome-engine.js';

// =============================================================================
// Reference Implementation (independent of platform code)
// =============================================================================

/**
 * Pure reference implementation of empirical distribution computation.
 * Uses simple counting with no weighting, smoothing, or interpolation.
 */
function referenceEmpiricalDistribution(returns: number[]): {
  up: number;
  down: number;
  flat: number;
} {
  const n = returns.length;
  let upCount = 0;
  let downCount = 0;
  let flatCount = 0;

  for (const r of returns) {
    if (r > FLAT_THRESHOLD) {
      upCount++;
    } else if (r < -FLAT_THRESHOLD) {
      downCount++;
    } else {
      flatCount++;
    }
  }

  return {
    up: upCount / n,
    down: downCount / n,
    flat: flatCount / n,
  };
}

// =============================================================================
// Arbitraries
// =============================================================================

/** Generate random forward returns in [-200, 200] (pip range). */
const arbReturn: fc.Arbitrary<number> = fc.double({
  min: -200,
  max: 200,
  noNaN: true,
  noDefaultInfinity: true,
});

/** Generate non-empty arrays of returns with length 1 to 500. */
const arbReturnsArray: fc.Arbitrary<number[]> = fc.array(arbReturn, {
  minLength: 1,
  maxLength: 500,
});

// =============================================================================
// Property Tests
// =============================================================================

describe('Property 2: Empirical Distribution Purity', () => {
  it('up + down + flat === 1.0 for any non-empty returns array (no probability leaks)', () => {
    fc.assert(
      fc.property(arbReturnsArray, (returns) => {
        const result = computeDirectionProbability(returns);
        const sum = result.up + result.down + result.flat;
        // Use exact equality since count/N arithmetic should be precise for reasonable N
        expect(sum).toBeCloseTo(1.0, 10);
      }),
      { numRuns: 500 },
    );
  });

  it('each observation contributes exactly 1/N (equal weighting)', () => {
    fc.assert(
      fc.property(arbReturnsArray, (returns) => {
        const n = returns.length;
        const result = computeDirectionProbability(returns);

        // Each probability must be a multiple of 1/N
        const upCount = Math.round(result.up * n);
        const downCount = Math.round(result.down * n);
        const flatCount = Math.round(result.flat * n);

        // Verify counts are whole numbers and reconstruct to exact probabilities
        expect(upCount + downCount + flatCount).toBe(n);
        expect(result.up).toBeCloseTo(upCount / n, 10);
        expect(result.down).toBeCloseTo(downCount / n, 10);
        expect(result.flat).toBeCloseTo(flatCount / n, 10);
      }),
      { numRuns: 500 },
    );
  });

  it('categories are exhaustive and mutually exclusive (every return falls into exactly one)', () => {
    fc.assert(
      fc.property(arbReturnsArray, (returns) => {
        const n = returns.length;
        const result = computeDirectionProbability(returns);

        // Derive counts
        const upCount = Math.round(result.up * n);
        const downCount = Math.round(result.down * n);
        const flatCount = Math.round(result.flat * n);

        // Manually count each category
        let expectedUp = 0;
        let expectedDown = 0;
        let expectedFlat = 0;

        for (const r of returns) {
          if (r > FLAT_THRESHOLD) expectedUp++;
          else if (r < -FLAT_THRESHOLD) expectedDown++;
          else expectedFlat++;
        }

        expect(upCount).toBe(expectedUp);
        expect(downCount).toBe(expectedDown);
        expect(flatCount).toBe(expectedFlat);
        expect(expectedUp + expectedDown + expectedFlat).toBe(n);
      }),
      { numRuns: 500 },
    );
  });

  it('platform implementation matches reference formula (no weighting, smoothing, or interpolation)', () => {
    fc.assert(
      fc.property(arbReturnsArray, (returns) => {
        const platform = computeDirectionProbability(returns);
        const reference = referenceEmpiricalDistribution(returns);

        expect(platform.up).toBeCloseTo(reference.up, 10);
        expect(platform.down).toBeCloseTo(reference.down, 10);
        expect(platform.flat).toBeCloseTo(reference.flat, 10);
      }),
      { numRuns: 500 },
    );
  });

  it('deterministic: same inputs always produce same output', () => {
    fc.assert(
      fc.property(arbReturnsArray, (returns) => {
        const result1 = computeDirectionProbability(returns);
        const result2 = computeDirectionProbability(returns);

        expect(result1.up).toBe(result2.up);
        expect(result1.down).toBe(result2.down);
        expect(result1.flat).toBe(result2.flat);
      }),
      { numRuns: 500 },
    );
  });

  it('single element arrays classify correctly', () => {
    fc.assert(
      fc.property(arbReturn, (r) => {
        const result = computeDirectionProbability([r]);

        if (r > FLAT_THRESHOLD) {
          expect(result.up).toBe(1.0);
          expect(result.down).toBe(0.0);
          expect(result.flat).toBe(0.0);
        } else if (r < -FLAT_THRESHOLD) {
          expect(result.up).toBe(0.0);
          expect(result.down).toBe(1.0);
          expect(result.flat).toBe(0.0);
        } else {
          expect(result.up).toBe(0.0);
          expect(result.down).toBe(0.0);
          expect(result.flat).toBe(1.0);
        }
      }),
      { numRuns: 200 },
    );
  });

  it('all values in same category produce probability 1.0 for that category', () => {
    // All up
    fc.assert(
      fc.property(
        fc.array(
          fc.double({ min: FLAT_THRESHOLD + 0.001, max: 200, noNaN: true, noDefaultInfinity: true }),
          { minLength: 1, maxLength: 100 },
        ),
        (returns) => {
          const result = computeDirectionProbability(returns);
          expect(result.up).toBe(1.0);
          expect(result.down).toBe(0.0);
          expect(result.flat).toBe(0.0);
        },
      ),
      { numRuns: 100 },
    );

    // All down
    fc.assert(
      fc.property(
        fc.array(
          fc.double({ min: -200, max: -FLAT_THRESHOLD - 0.001, noNaN: true, noDefaultInfinity: true }),
          { minLength: 1, maxLength: 100 },
        ),
        (returns) => {
          const result = computeDirectionProbability(returns);
          expect(result.up).toBe(0.0);
          expect(result.down).toBe(1.0);
          expect(result.flat).toBe(0.0);
        },
      ),
      { numRuns: 100 },
    );

    // All flat
    fc.assert(
      fc.property(
        fc.array(
          fc.double({ min: -FLAT_THRESHOLD, max: FLAT_THRESHOLD, noNaN: true, noDefaultInfinity: true }),
          { minLength: 1, maxLength: 100 },
        ),
        (returns) => {
          const result = computeDirectionProbability(returns);
          expect(result.up).toBe(0.0);
          expect(result.down).toBe(0.0);
          expect(result.flat).toBe(1.0);
        },
      ),
      { numRuns: 100 },
    );
  });
});
