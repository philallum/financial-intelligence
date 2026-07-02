/**
 * Property-Based Test: Confidence Output Bounds
 *
 * Property 4: Confidence Output Bounds
 * - Generate random valid ConfidenceInput (all components in [0, 1], sample_size ≥ 1)
 * - Verify every named component individually bounded to [0.0, 1.0] with ≤ 6 decimal places
 * - Test both v1 and v2 engines
 *
 * **Validates: Requirements 11.5, 11.7, 6.3**
 */

import { describe, it, expect } from "vitest";
import * as fc from "fast-check";
import { computeConfidenceFromInput } from "../../src/engines/confidence-engine.js";
import { computeConfidenceV2FromInput } from "../../src/engines/confidence-engine-v2.js";
import type { CalibrationParameters } from "../../src/engines/confidence-engine-v2.js";
import type { ConfidenceInput } from "../../src/types/index.js";

// =============================================================================
// Arbitraries
// =============================================================================

/**
 * Generates a valid RegimeOverlapContext with regime_match_ratio and
 * regime_diversity in [0, 1], and a dominant_regime string.
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
 * - regime_metadata with fields in [0, 1]
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

/**
 * Generates valid CalibrationParameters with all values in [0, 1].
 * Includes regime_accuracy entries for the regimes we generate,
 * bucket_success_rates for all 10 buckets, and a sample_density_curve.
 */
const arbCalibrationParameters: fc.Arbitrary<CalibrationParameters> = fc.record({
  regime_accuracy: fc.record({
    LOW_BULLISH_LONDON: fc.double({ min: 0, max: 1, noNaN: true, noDefaultInfinity: true }),
    HIGH_BEARISH_NY: fc.double({ min: 0, max: 1, noNaN: true, noDefaultInfinity: true }),
    NORMAL_RANGING_ASIA: fc.double({ min: 0, max: 1, noNaN: true, noDefaultInfinity: true }),
  }),
  bucket_success_rates: fc.record({
    "0.0-0.1": fc.double({ min: 0, max: 1, noNaN: true, noDefaultInfinity: true }),
    "0.1-0.2": fc.double({ min: 0, max: 1, noNaN: true, noDefaultInfinity: true }),
    "0.2-0.3": fc.double({ min: 0, max: 1, noNaN: true, noDefaultInfinity: true }),
    "0.3-0.4": fc.double({ min: 0, max: 1, noNaN: true, noDefaultInfinity: true }),
    "0.4-0.5": fc.double({ min: 0, max: 1, noNaN: true, noDefaultInfinity: true }),
    "0.5-0.6": fc.double({ min: 0, max: 1, noNaN: true, noDefaultInfinity: true }),
    "0.6-0.7": fc.double({ min: 0, max: 1, noNaN: true, noDefaultInfinity: true }),
    "0.7-0.8": fc.double({ min: 0, max: 1, noNaN: true, noDefaultInfinity: true }),
    "0.8-0.9": fc.double({ min: 0, max: 1, noNaN: true, noDefaultInfinity: true }),
    "0.9-1.0": fc.double({ min: 0, max: 1, noNaN: true, noDefaultInfinity: true }),
  }),
  sample_density_curve: fc.array(
    fc.double({ min: 0, max: 1, noNaN: true, noDefaultInfinity: true }),
    { minLength: 201, maxLength: 201 },
  ),
  global_fallback: fc.record({
    base_score: fc.double({ min: 0, max: 1, noNaN: true, noDefaultInfinity: true }),
    regime_modifier: fc.double({ min: 0, max: 1, noNaN: true, noDefaultInfinity: true }),
    sample_modifier: fc.double({ min: 0, max: 1, noNaN: true, noDefaultInfinity: true }),
  }),
});

// =============================================================================
// Property Tests
// =============================================================================

describe("Property 4: Confidence Output Bounds", () => {
  describe("v1 engine (computeConfidenceFromInput)", () => {
    it("confidence_raw is bounded [0.0, 1.0]", () => {
      fc.assert(
        fc.property(arbConfidenceInput, (input: ConfidenceInput) => {
          const output = computeConfidenceFromInput(input);
          expect(output.confidence_raw).toBeGreaterThanOrEqual(0.0);
          expect(output.confidence_raw).toBeLessThanOrEqual(1.0);
        }),
        { numRuns: 500 },
      );
    });

    it("sample_weight is bounded [0.0, 1.0]", () => {
      fc.assert(
        fc.property(arbConfidenceInput, (input: ConfidenceInput) => {
          const output = computeConfidenceFromInput(input);
          expect(output.sample_weight).toBeGreaterThanOrEqual(0.0);
          expect(output.sample_weight).toBeLessThanOrEqual(1.0);
        }),
        { numRuns: 500 },
      );
    });

    it("regime_stability is bounded [0.0, 1.0]", () => {
      fc.assert(
        fc.property(arbConfidenceInput, (input: ConfidenceInput) => {
          const output = computeConfidenceFromInput(input);
          expect(output.regime_stability).toBeGreaterThanOrEqual(0.0);
          expect(output.regime_stability).toBeLessThanOrEqual(1.0);
        }),
        { numRuns: 500 },
      );
    });

    it("confidence_final is bounded [0.0, 1.0]", () => {
      fc.assert(
        fc.property(arbConfidenceInput, (input: ConfidenceInput) => {
          const output = computeConfidenceFromInput(input);
          expect(output.confidence_final).toBeGreaterThanOrEqual(0.0);
          expect(output.confidence_final).toBeLessThanOrEqual(1.0);
        }),
        { numRuns: 500 },
      );
    });
  });

  describe("v2 engine (computeConfidenceV2FromInput)", () => {
    it("calibration_adjusted_base is bounded [0.0, 1.0]", () => {
      fc.assert(
        fc.property(
          arbConfidenceInput,
          arbCalibrationParameters,
          (input: ConfidenceInput, calibration: CalibrationParameters) => {
            const output = computeConfidenceV2FromInput(input, calibration);
            expect(output.calibration_adjusted_base).toBeGreaterThanOrEqual(0.0);
            expect(output.calibration_adjusted_base).toBeLessThanOrEqual(1.0);
          },
        ),
        { numRuns: 500 },
      );
    });

    it("regime_accuracy_modifier is bounded [0.0, 1.0]", () => {
      fc.assert(
        fc.property(
          arbConfidenceInput,
          arbCalibrationParameters,
          (input: ConfidenceInput, calibration: CalibrationParameters) => {
            const output = computeConfidenceV2FromInput(input, calibration);
            expect(output.regime_accuracy_modifier).toBeGreaterThanOrEqual(0.0);
            expect(output.regime_accuracy_modifier).toBeLessThanOrEqual(1.0);
          },
        ),
        { numRuns: 500 },
      );
    });

    it("sample_density_modifier is bounded [0.0, 1.0]", () => {
      fc.assert(
        fc.property(
          arbConfidenceInput,
          arbCalibrationParameters,
          (input: ConfidenceInput, calibration: CalibrationParameters) => {
            const output = computeConfidenceV2FromInput(input, calibration);
            expect(output.sample_density_modifier).toBeGreaterThanOrEqual(0.0);
            expect(output.sample_density_modifier).toBeLessThanOrEqual(1.0);
          },
        ),
        { numRuns: 500 },
      );
    });

    it("confidence_final is bounded [0.0, 1.0] with ≤ 6 decimal places", () => {
      fc.assert(
        fc.property(
          arbConfidenceInput,
          arbCalibrationParameters,
          (input: ConfidenceInput, calibration: CalibrationParameters) => {
            const output = computeConfidenceV2FromInput(input, calibration);

            // Verify bounds
            expect(output.confidence_final).toBeGreaterThanOrEqual(0.0);
            expect(output.confidence_final).toBeLessThanOrEqual(1.0);

            // Verify ≤ 6 decimal places
            const decimalStr = output.confidence_final.toString().split(".")[1] || "";
            expect(decimalStr.length).toBeLessThanOrEqual(6);
          },
        ),
        { numRuns: 500 },
      );
    });
  });
});
