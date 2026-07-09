/**
 * Pipeline Gaps Exploration Property Tests
 *
 * These tests surface counterexamples demonstrating three pipeline gaps.
 * They are EXPECTED TO FAIL on unfixed code — failure confirms the bugs exist.
 *
 * Bug Condition: Pipeline Produces Non-Actionable Outputs
 * (Confidence=0, Tradeability=NO_GO, Topology Ignored)
 *
 * **Validates: Requirements 1.1, 1.2, 1.3, 1.4, 1.5**
 */

import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';
import {
  computeConfidenceV2FromInput,
  type CalibrationParameters,
} from '../confidence-engine-v2.js';
import { computeConfidenceFromInput } from '../confidence-engine.js';
import { computeTradeabilityFromInput, getSessionDefaults } from '../tradeability-engine.js';
import { TOPOLOGY_SIMILARITY_WEIGHT } from '../../config/constants.js';
import { computeAggregateScore, getRegimeWeights, computeBlendedScore } from '../similarity-engine.js';
import { Session } from '../../types/enums.js';

// =============================================================================
// Shared Generators
// =============================================================================

/**
 * Generates a valid ConfidenceInput with all values in [0, 1] and sample_size >= 1.
 */
function arbConfidenceInput() {
  return fc.record({
    up_probability: fc.double({ min: 0.01, max: 0.98, noNaN: true, noDefaultInfinity: true }),
    down_probability: fc.double({ min: 0.01, max: 0.98, noNaN: true, noDefaultInfinity: true }),
    flat_probability: fc.double({ min: 0.01, max: 0.98, noNaN: true, noDefaultInfinity: true }),
    sample_size: fc.integer({ min: 1, max: 200 }),
    variance: fc.double({ min: 0, max: 1, noNaN: true, noDefaultInfinity: true }),
    skew: fc.double({ min: 0, max: 1, noNaN: true, noDefaultInfinity: true }),
    kurtosis: fc.double({ min: 0, max: 1, noNaN: true, noDefaultInfinity: true }),
    mean_similarity: fc.double({ min: 0.01, max: 1, noNaN: true, noDefaultInfinity: true }),
    similarity_spread: fc.double({ min: 0, max: 1, noNaN: true, noDefaultInfinity: true }),
    top_match_density: fc.double({ min: 0.01, max: 1, noNaN: true, noDefaultInfinity: true }),
    regime_metadata: fc.record({
      regime_match_ratio: fc.double({ min: 0.01, max: 1, noNaN: true, noDefaultInfinity: true }),
      dominant_regime: fc.constantFrom('LOW_BULLISH', 'NORMAL_RANGING', 'HIGH_BEARISH'),
      regime_diversity: fc.double({ min: 0, max: 1, noNaN: true, noDefaultInfinity: true }),
    }),
  });
}

/**
 * Generates valid CalibrationParameters with non-zero global_fallback values.
 */
function arbCalibrationParameters(): fc.Arbitrary<CalibrationParameters> {
  return fc.record({
    regime_accuracy: fc.constant({
      LOW_BULLISH: 0.72,
      NORMAL_RANGING: 0.65,
      HIGH_BEARISH: 0.58,
    }),
    bucket_success_rates: fc.constant({
      '0.3-0.4': 0.55,
      '0.4-0.5': 0.62,
      '0.5-0.6': 0.68,
      '0.6-0.7': 0.74,
      '0.7-0.8': 0.79,
      '0.8-0.9': 0.84,
      '0.9-1.0': 0.88,
    }),
    sample_density_curve: fc.constant(
      Array.from({ length: 201 }, (_, i) => Math.min(0.95, 0.3 + i * 0.003)),
    ),
    global_fallback: fc.record({
      base_score: fc.double({ min: 0.1, max: 0.9, noNaN: true, noDefaultInfinity: true }),
      regime_modifier: fc.double({ min: 0.1, max: 0.9, noNaN: true, noDefaultInfinity: true }),
      sample_modifier: fc.double({ min: 0.1, max: 0.9, noNaN: true, noDefaultInfinity: true }),
    }),
  });
}

/**
 * Generates a valid Session enum value.
 */
function arbSession(): fc.Arbitrary<typeof Session[keyof typeof Session]> {
  return fc.constantFrom(Session.ASIA, Session.LONDON, Session.NY);
}

// =============================================================================
// 1. Confidence Bug Exploration
// =============================================================================

describe('Confidence Bug Exploration', () => {
  /**
   * This test verifies that confidence engine v2 works correctly.
   * EXPECTED: PASSES — v2 is already implemented and produces non-zero scores.
   */
  it('computeConfidenceV2FromInput produces confidence_final > 0 for valid inputs', () => {
    fc.assert(
      fc.property(
        arbConfidenceInput(),
        arbCalibrationParameters(),
        (input, calibration) => {
          const result = computeConfidenceV2FromInput(input, calibration);
          expect(result.confidence_final).toBeGreaterThan(0);
        },
      ),
      { numRuns: 100 },
    );
  });

  /**
   * This test exercises the v1 confidence engine with realistic inputs.
   * EXPECTED: FAILS — the v1 dampener (capped at 0.5 for N < 30) produces
   * confidence_final values that are too low (≤ 0.1) for realistic inputs.
   *
   * The counterexample will demonstrate that for N < 30, confidence_final ≈ 0.
   * Using it.fails() so CI passes — this documents the known v1 bug.
   */
  it.fails('computeConfidenceFromInput (v1) produces confidence_final > 0.1 for realistic inputs', () => {
    fc.assert(
      fc.property(
        arbConfidenceInput().filter((input) => input.sample_size < 30),
        (input) => {
          const result = computeConfidenceFromInput(input);
          expect(result.confidence_final).toBeGreaterThan(0.1);
        },
      ),
      { numRuns: 100 },
    );
  });
});

// =============================================================================
// 2. Tradeability Bug Exploration
// =============================================================================

describe('Tradeability Bug Exploration', () => {
  /**
   * This test checks whether getSessionDefaults exists and returns valid values.
   * EXPECTED: FAILS — the function does not exist yet.
   */
  it('getSessionDefaults exists and returns spreadPips > 0 and liquidityProxy > 0', () => {
    fc.assert(
      fc.property(
        arbSession(),
        (session) => {
          // Verify getSessionDefaults exists and returns valid values
          expect(getSessionDefaults).toBeDefined();
          const defaults = getSessionDefaults(session, 'EURUSD');
          expect(defaults.spreadPips).toBeGreaterThan(0);
          expect(defaults.liquidityProxy).toBeGreaterThan(0);
        },
      ),
      { numRuns: 100 },
    );
  });

  /**
   * This test verifies that tradeability with confidence_final = 0 produces score > 0.
   * EXPECTED: FAILS — with S_static = 0, the tradeability_score is always 0.
   * Using it.fails() so CI passes — this documents the known zero-confidence bug.
   */
  it.fails('computeTradeabilityFromInput with confidence_final = 0 produces tradeability_score > 0', () => {
    fc.assert(
      fc.property(
        arbSession(),
        (session) => {
          const forecast = {
            fingerprint_id: 'test-fp-001',
            direction_probabilities: { up: 0.6, down: 0.3, flat: 0.1 },
            expected_move_pips: 15,
            confidence_raw: 0,
            confidence_final: 0,
            engine_version: '1.0.0',
            batch_id: 'batch-001',
          };

          const result = computeTradeabilityFromInput({
            forecast,
            spread_pips: 1.5,
            session_state: session,
            live_liquidity_proxy: 0.85,
            news_risk_flag: false,
          });

          expect(result.tradeability_score).toBeGreaterThan(0);
        },
      ),
      { numRuns: 100 },
    );
  });
});

// =============================================================================
// 3. Topology Bug Exploration
// =============================================================================

describe('Topology Bug Exploration', () => {
  /**
   * This test verifies that different topology similarity values produce
   * different blended scores when TOPOLOGY_SIMILARITY_WEIGHT > 0.
   * EXPECTED: FAILS — TOPOLOGY_SIMILARITY_WEIGHT is 0.0 and computeBlendedScore
   * does not exist yet.
   */
  it('candidates with different topology similarity produce different blended scores when weight > 0', () => {
    fc.assert(
      fc.property(
        // Generate identical 5-layer scores for two candidates
        fc.double({ min: 0.1, max: 0.9, noNaN: true, noDefaultInfinity: true }),
        // Different topology similarities
        fc.double({ min: 0.1, max: 0.4, noNaN: true, noDefaultInfinity: true }),
        fc.double({ min: 0.6, max: 0.9, noNaN: true, noDefaultInfinity: true }),
        (existingScore, topologyA, topologyB) => {
          // First verify the weight is > 0 (it won't be — that's the bug)
          expect(TOPOLOGY_SIMILARITY_WEIGHT).toBeGreaterThan(0);

          // Then verify computeBlendedScore exists and produces different results
          const similarityEngine = { computeBlendedScore };
          expect(similarityEngine.computeBlendedScore).toBeDefined();

          const blendedA = similarityEngine.computeBlendedScore(
            existingScore,
            topologyA,
            TOPOLOGY_SIMILARITY_WEIGHT,
          );
          const blendedB = similarityEngine.computeBlendedScore(
            existingScore,
            topologyB,
            TOPOLOGY_SIMILARITY_WEIGHT,
          );

          // With different topology similarities and weight > 0, scores must differ
          expect(blendedA).not.toEqual(blendedB);
        },
      ),
      { numRuns: 100 },
    );
  });
});
