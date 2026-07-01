/**
 * Property-Based Test: FLAT Threshold Classification (Outcome Engine)
 *
 * Property 6: FLAT Threshold Classification
 * Generate random continuous return values R (floats around ±2 pip boundary).
 * Assert: UP when R > +2 pips, DOWN when R < -2 pips, FLAT when |R| ≤ 2 pips.
 * Assert: UP_count + DOWN_count + FLAT_count = total sample size.
 * Minimum 100 iterations.
 *
 * **Validates: Requirements 3.3**
 */

import { describe, it, expect } from "vitest";
import * as fc from "fast-check";
import { computeDirectionProbability } from "../../src/engines/outcome-engine.js";
import { FLAT_THRESHOLD } from "../../src/config/constants.js";

// =============================================================================
// Arbitraries
// =============================================================================

/**
 * Generates return values concentrated around the ±2 pip boundary to stress-test
 * the classification logic. Mix of:
 * - Values near the FLAT boundary (±2 pips ± small epsilon)
 * - Values clearly in UP territory (> +2 pips)
 * - Values clearly in DOWN territory (< -2 pips)
 * - Values clearly in FLAT territory (|R| ≤ 2 pips)
 */
const arbReturnNearBoundary: fc.Arbitrary<number> = fc.oneof(
  // Near +2 boundary
  fc.double({ min: FLAT_THRESHOLD - 0.5, max: FLAT_THRESHOLD + 0.5, noNaN: true, noDefaultInfinity: true }),
  // Near -2 boundary
  fc.double({ min: -FLAT_THRESHOLD - 0.5, max: -FLAT_THRESHOLD + 0.5, noNaN: true, noDefaultInfinity: true }),
  // Clearly UP
  fc.double({ min: FLAT_THRESHOLD + 0.01, max: 100, noNaN: true, noDefaultInfinity: true }),
  // Clearly DOWN
  fc.double({ min: -100, max: -FLAT_THRESHOLD - 0.01, noNaN: true, noDefaultInfinity: true }),
  // Clearly FLAT
  fc.double({ min: -FLAT_THRESHOLD, max: FLAT_THRESHOLD, noNaN: true, noDefaultInfinity: true }),
);

/**
 * Generates a non-empty array of return values for batch classification testing.
 */
const arbReturnsArray: fc.Arbitrary<number[]> = fc.array(arbReturnNearBoundary, {
  minLength: 1,
  maxLength: 200,
});

// =============================================================================
// Property Tests
// =============================================================================

describe("Property 6: FLAT Threshold Classification", () => {
  it("individual return classification: UP when R > +2 pips, DOWN when R < -2 pips, FLAT when |R| ≤ 2 pips", () => {
    fc.assert(
      fc.property(arbReturnNearBoundary, (r: number) => {
        const result = computeDirectionProbability([r]);

        if (Math.abs(r) <= FLAT_THRESHOLD) {
          // FLAT: |R| ≤ 2 pips
          expect(result.flat).toBe(1);
          expect(result.up).toBe(0);
          expect(result.down).toBe(0);
        } else if (r > FLAT_THRESHOLD) {
          // UP: R > +2 pips
          expect(result.up).toBe(1);
          expect(result.flat).toBe(0);
          expect(result.down).toBe(0);
        } else {
          // DOWN: R < -2 pips
          expect(result.down).toBe(1);
          expect(result.flat).toBe(0);
          expect(result.up).toBe(0);
        }
      }),
      { numRuns: 200 },
    );
  });

  it("array classification: UP_count + DOWN_count + FLAT_count = total sample size (probabilities sum to 1)", () => {
    fc.assert(
      fc.property(arbReturnsArray, (returns: number[]) => {
        const result = computeDirectionProbability(returns);

        // Probabilities must sum to 1
        const sum = result.up + result.down + result.flat;
        expect(sum).toBeCloseTo(1, 10);

        // Verify individual counts by manually classifying
        let expectedUp = 0;
        let expectedDown = 0;
        let expectedFlat = 0;

        for (const r of returns) {
          if (Math.abs(r) <= FLAT_THRESHOLD) {
            expectedFlat++;
          } else if (r > FLAT_THRESHOLD) {
            expectedUp++;
          } else {
            expectedDown++;
          }
        }

        const n = returns.length;
        expect(result.up).toBeCloseTo(expectedUp / n, 10);
        expect(result.down).toBeCloseTo(expectedDown / n, 10);
        expect(result.flat).toBeCloseTo(expectedFlat / n, 10);

        // Count invariant: UP_count + DOWN_count + FLAT_count = total
        expect(expectedUp + expectedDown + expectedFlat).toBe(n);
      }),
      { numRuns: 100 },
    );
  });

  it("boundary values: exactly ±2 pips classified as FLAT", () => {
    fc.assert(
      fc.property(
        fc.constantFrom(FLAT_THRESHOLD, -FLAT_THRESHOLD, 0),
        (r: number) => {
          const result = computeDirectionProbability([r]);
          expect(result.flat).toBe(1);
          expect(result.up).toBe(0);
          expect(result.down).toBe(0);
        },
      ),
      { numRuns: 100 },
    );
  });

  it("all probabilities are non-negative for any valid return array", () => {
    fc.assert(
      fc.property(arbReturnsArray, (returns: number[]) => {
        const result = computeDirectionProbability(returns);
        expect(result.up).toBeGreaterThanOrEqual(0);
        expect(result.down).toBeGreaterThanOrEqual(0);
        expect(result.flat).toBeGreaterThanOrEqual(0);
      }),
      { numRuns: 100 },
    );
  });
});
