/**
 * Property-Based Test: Sample Size Dampener Cap (Confidence Engine)
 *
 * Property 9: Sample Size Dampener Cap
 * Generate random N in [1, 29].
 * Assert: S(N) ≤ 0.5, resulting in C_final ≤ 0.5 × C_raw × R.
 * Minimum 100 iterations.
 *
 * **Validates: Requirements 5.3**
 */

import { describe, it, expect } from "vitest";
import * as fc from "fast-check";
import {
  computeConfidenceFromInput,
  computeSampleSizeDampener,
} from "../../src/engines/confidence-engine.js";
import type { ConfidenceInput } from "../../src/types/index.js";

// =============================================================================
// Arbitraries
// =============================================================================

/**
 * Generates a valid ConfidenceInput with sample_size constrained to [1, 29]
 * (below threshold) and all other fields within their valid [0, 1] ranges.
 */
const arbConfidenceInputBelowThreshold: fc.Arbitrary<ConfidenceInput> = fc.record({
  up_probability: fc.double({ min: 0, max: 1, noNaN: true, noDefaultInfinity: true }),
  down_probability: fc.double({ min: 0, max: 1, noNaN: true, noDefaultInfinity: true }),
  flat_probability: fc.double({ min: 0, max: 1, noNaN: true, noDefaultInfinity: true }),
  sample_size: fc.integer({ min: 1, max: 29 }),
  variance: fc.double({ min: 0, max: 1, noNaN: true, noDefaultInfinity: true }),
  skew: fc.double({ min: 0, max: 1, noNaN: true, noDefaultInfinity: true }),
  kurtosis: fc.double({ min: 0, max: 1, noNaN: true, noDefaultInfinity: true }),
  mean_similarity: fc.double({ min: 0, max: 1, noNaN: true, noDefaultInfinity: true }),
  similarity_spread: fc.double({ min: 0, max: 1, noNaN: true, noDefaultInfinity: true }),
  top_match_density: fc.double({ min: 0, max: 1, noNaN: true, noDefaultInfinity: true }),
  regime_metadata: fc.record({
    regime_match_ratio: fc.double({ min: 0, max: 1, noNaN: true, noDefaultInfinity: true }),
    dominant_regime: fc.constantFrom("LOW_BULLISH_ASIA", "NORMAL_BEARISH_LONDON", "HIGH_RANGING_NY"),
    regime_diversity: fc.double({ min: 0, max: 1, noNaN: true, noDefaultInfinity: true }),
  }),
});

// =============================================================================
// Property Tests
// =============================================================================

describe("Property 9: Sample Size Dampener Cap", () => {
  it("computeSampleSizeDampener(N) ≤ 0.5 for N ∈ [1, 29]", () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 29 }), (n: number) => {
        const dampener = computeSampleSizeDampener(n);
        expect(dampener).toBeLessThanOrEqual(0.5);
        expect(dampener).toBeGreaterThan(0);
      }),
      { numRuns: 200 },
    );
  });

  it("sample_weight ≤ 0.5 and confidence_final ≤ 0.5 × confidence_raw × regime_stability for N ∈ [1, 29]", () => {
    fc.assert(
      fc.property(arbConfidenceInputBelowThreshold, (input: ConfidenceInput) => {
        const output = computeConfidenceFromInput(input);

        // S(N) must be capped at 0.5
        expect(output.sample_weight).toBeLessThanOrEqual(0.5);

        // C_final = C_raw × S(N) × R ≤ C_raw × 0.5 × R = 0.5 × C_raw × R
        // Allow small floating point tolerance (1e-10)
        const upperBound = 0.5 * output.confidence_raw * output.regime_stability;
        expect(output.confidence_final).toBeLessThanOrEqual(upperBound + 1e-10);

        // C_final must always be in [0.0, 1.0]
        expect(output.confidence_final).toBeGreaterThanOrEqual(0.0);
        expect(output.confidence_final).toBeLessThanOrEqual(1.0);
      }),
      { numRuns: 200 },
    );
  });
});
