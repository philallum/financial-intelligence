/**
 * Property-Based Test: Forecast Probability Normalisation (Forecast Engine)
 *
 * Property 7: Forecast Probability Normalisation
 * Generate random valid outcome distributions with direction probabilities summing to 1.0.
 * Assert: output up + down + flat = 1.00 exactly, each in [0.00, 1.00].
 * Assert: each probability is rounded to exactly 2 decimal places.
 * Minimum 100 iterations.
 *
 * **Validates: Requirements 4.3**
 */

import { describe, it, expect } from "vitest";
import * as fc from "fast-check";
import { computeForecastFromDistribution } from "../../src/engines/forecast-engine.js";
import { arbReturnPips, arbFingerprintId } from "../helpers/generators.js";
import type { OutcomeDistribution } from "../../src/types/index.js";

// =============================================================================
// Arbitraries
// =============================================================================

/**
 * Generates 3 random proportions that sum to exactly 1.0 using the
 * "break the stick" method: generate 2 uniform breakpoints in [0,1],
 * sort them, and derive 3 segments.
 */
const arbDirectionProbability: fc.Arbitrary<{ up: number; down: number; flat: number }> = fc
  .tuple(
    fc.double({ min: 0, max: 1, noNaN: true, noDefaultInfinity: true }),
    fc.double({ min: 0, max: 1, noNaN: true, noDefaultInfinity: true }),
  )
  .map(([a, b]) => {
    const sorted = [a, b].sort((x, y) => x - y);
    const up = sorted[0]!;
    const down = sorted[1]! - sorted[0]!;
    const flat = 1.0 - sorted[1]!;
    return { up, down, flat };
  });

/**
 * Generates a valid OutcomeDistribution with random direction_probability summing to 1.0,
 * random sample_size >= 1, random mean_return, and reasonable defaults for other fields.
 */
const arbOutcomeDistribution: fc.Arbitrary<OutcomeDistribution> = fc
  .record({
    fingerprint_id: arbFingerprintId,
    sample_size: fc.integer({ min: 1, max: 1000 }),
    mean_return: arbReturnPips,
    median_return: arbReturnPips,
    direction_probability: arbDirectionProbability,
    std_dev: fc.double({ min: 0.01, max: 50, noNaN: true, noDefaultInfinity: true }),
    max_absolute_return: fc.double({ min: 0, max: 200, noNaN: true, noDefaultInfinity: true }),
    p10: arbReturnPips,
    p50: arbReturnPips,
    p90: arbReturnPips,
    regime_consistency: fc.double({ min: 0, max: 1, noNaN: true, noDefaultInfinity: true }),
    distribution_sharpness: fc.double({ min: 0, max: 1, noNaN: true, noDefaultInfinity: true }),
  })
  .map((r) => ({
    fingerprint_id: r.fingerprint_id,
    sample_size: r.sample_size,
    mean_return: r.mean_return,
    median_return: r.median_return,
    direction_probability: r.direction_probability,
    volatility_profile: {
      std_dev: r.std_dev,
      max_absolute_return: r.max_absolute_return,
    },
    risk_range: {
      p10: r.p10,
      p50: r.p50,
      p90: r.p90,
    },
    confidence_inputs: {
      regime_consistency: r.regime_consistency,
      distribution_sharpness: r.distribution_sharpness,
    },
    batch_id: "batch-pbt-forecast",
    engine_version: "1.0.0",
  }));

// =============================================================================
// Helpers
// =============================================================================

/**
 * Checks if a number is rounded to exactly 2 decimal places.
 * A number has at most 2 decimal places if multiplying by 100 gives an integer.
 */
function hasExactly2DecimalPlaces(value: number): boolean {
  return Math.abs(Math.round(value * 100) - value * 100) < 1e-10;
}

// =============================================================================
// Property Tests
// =============================================================================

describe("Property 7: Forecast Probability Normalisation", () => {
  it("output direction_probabilities.up + down + flat = 1.00 exactly, each in [0.00, 1.00]", () => {
    fc.assert(
      fc.property(arbOutcomeDistribution, (distribution: OutcomeDistribution) => {
        const forecast = computeForecastFromDistribution(distribution);

        const { up, down, flat } = forecast.direction_probabilities;

        // Each probability must be in [0.00, 1.00]
        expect(up).toBeGreaterThanOrEqual(0);
        expect(up).toBeLessThanOrEqual(1);
        expect(down).toBeGreaterThanOrEqual(0);
        expect(down).toBeLessThanOrEqual(1);
        expect(flat).toBeGreaterThanOrEqual(0);
        expect(flat).toBeLessThanOrEqual(1);

        // Sum must be exactly 1.00
        const sum = up + down + flat;
        expect(sum).toBe(1.0);

        // Each probability must be rounded to exactly 2 decimal places
        expect(hasExactly2DecimalPlaces(up)).toBe(true);
        expect(hasExactly2DecimalPlaces(down)).toBe(true);
        expect(hasExactly2DecimalPlaces(flat)).toBe(true);
      }),
      { numRuns: 200 },
    );
  });
});
