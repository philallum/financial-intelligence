/**
 * Property-Based Test: Confidence Formula Correctness (Confidence Engine)
 *
 * Property 8: Confidence Formula Correctness
 * For any valid inputs where C_raw ∈ [0, 1], S(N) ∈ [0, 1], and R ∈ [0, 1],
 * the confidence engine SHALL compute C_final = C_raw × S(N) × R,
 * and C_final SHALL be bounded within [0.0, 1.0].
 *
 * **Validates: Requirements 5.1**
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
 * Generates a valid RegimeOverlapContext with regime_match_ratio and
 * regime_diversity in [0, 1].
 */
const arbRegimeMetadata = fc.record({
  regime_match_ratio: fc.double({ min: 0, max: 1, noNaN: true, noDefaultInfinity: true }),
  dominant_regime: fc.constantFrom("LOW_BULLISH_LONDON", "HIGH_BEARISH_NY", "NORMAL_RANGING_ASIA"),
  regime_diversity: fc.double({ min: 0, max: 1, noNaN: true, noDefaultInfinity: true }),
});

/**
 * Generates a valid ConfidenceInput with:
 * - All probability fields in [0, 1]
 * - sample_size from 1 to 200
 * - All similarity/shape metrics in [0, 1]
 * - regime_metadata with regime_match_ratio and regime_diversity in [0, 1]
 */
const arbConfidenceInput: fc.Arbitrary<ConfidenceInput> = fc.record({
  up_probability: fc.double({ min: 0, max: 1, noNaN: true, noDefaultInfinity: true }),
  down_probability: fc.double({ min: 0, max: 1, noNaN: true, noDefaultInfinity: true }),
  flat_probability: fc.double({ min: 0, max: 1, noNaN: true, noDefaultInfinity: true }),
  sample_size: fc.integer({ min: 1, max: 200 }),
  variance: fc.double({ min: 0, max: 1, noNaN: true, noDefaultInfinity: true }),
  skew: fc.double({ min: 0, max: 1, noNaN: true, noDefaultInfinity: true }),
  kurtosis: fc.double({ min: 0, max: 1, noNaN: true, noDefaultInfinity: true }),
  mean_similarity: fc.double({ min: 0, max: 1, noNaN: true, noDefaultInfinity: true }),
  similarity_spread: fc.double({ min: 0, max: 1, noNaN: true, noDefaultInfinity: true }),
  top_match_density: fc.double({ min: 0, max: 1, noNaN: true, noDefaultInfinity: true }),
  regime_metadata: arbRegimeMetadata,
});

// =============================================================================
// Property Tests
// =============================================================================

describe("Property 8: Confidence Formula Correctness", () => {
  it("C_final = C_raw × S(N) × R and C_final ∈ [0.0, 1.0]", () => {
    fc.assert(
      fc.property(arbConfidenceInput, (input: ConfidenceInput) => {
        const output = computeConfidenceFromInput(input);

        // Verify sample_weight matches computeSampleSizeDampener(input.sample_size)
        const expectedSampleWeight = computeSampleSizeDampener(input.sample_size);
        expect(output.sample_weight).toBe(expectedSampleWeight);

        // Verify confidence_final = confidence_raw × sample_weight × regime_stability
        // (within floating point tolerance, since the formula clamps the result)
        const expectedFinal = output.confidence_raw * output.sample_weight * output.regime_stability;
        const clampedExpected = Math.max(0.0, Math.min(1.0, expectedFinal));

        expect(output.confidence_final).toBeCloseTo(clampedExpected, 10);

        // Verify confidence_final is bounded [0.0, 1.0]
        expect(output.confidence_final).toBeGreaterThanOrEqual(0.0);
        expect(output.confidence_final).toBeLessThanOrEqual(1.0);

        // Verify confidence_raw is also in [0, 1]
        expect(output.confidence_raw).toBeGreaterThanOrEqual(0.0);
        expect(output.confidence_raw).toBeLessThanOrEqual(1.0);

        // Verify regime_stability is in [0, 1]
        expect(output.regime_stability).toBeGreaterThanOrEqual(0.0);
        expect(output.regime_stability).toBeLessThanOrEqual(1.0);
      }),
      { numRuns: 200 },
    );
  });
});
