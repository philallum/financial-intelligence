/**
 * Property-Based Test: Universal Engine Determinism
 *
 * Property 1: Universal Engine Determinism
 * - Generate random valid inputs for each engine (Evaluation, Confidence v2,
 *   Topology, Regime v2, extended Fingerprint)
 * - Run twice, verify bit-identical outputs
 *
 * **Validates: Requirements 2.1, 2.3, 2.5, 7.8, 11.2, 13.5, 14.6, 15.2, 15.5**
 */

import { describe, it, expect } from "vitest";
import * as fc from "fast-check";
import { computeTopology } from "../../src/engines/topology-engine.js";
import type { TopologyInput } from "../../src/engines/topology-engine.js";
import { classifyRegimeV2 } from "../../src/engines/regime-engine-v2.js";
import type { RegimeV2Input } from "../../src/engines/regime-engine-v2.js";
import { computeConfidenceV2FromInput } from "../../src/engines/confidence-engine-v2.js";
import type { CalibrationParameters } from "../../src/engines/confidence-engine-v2.js";
import { computeExtendedFeatures } from "../../src/engines/fingerprint-engine.js";
import type { ExtendedFeaturesInput, ExtendedFeaturesConfig, OHLC, ConfidenceInput } from "../../src/types/index.js";
import {
  deriveRealisedDirection,
  derivePredictedDirection,
  computeBrierScore,
  computeCalibrationBucket,
} from "../../src/research/evaluation/evaluation-engine.js";

// =============================================================================
// Shared Arbitraries
// =============================================================================

/** Generate a normalised value in [0, 1]. */
const arbNorm = fc.double({ min: 0, max: 1, noNaN: true, noDefaultInfinity: true });

/**
 * Generate a valid OHLC candle satisfying invariants:
 * - high >= max(open, close)
 * - low <= min(open, close)
 * - high >= low
 * - all positive
 */
const arbOHLC: fc.Arbitrary<OHLC> = fc
  .record({
    open: fc.double({ min: 0.5, max: 2.0, noNaN: true, noDefaultInfinity: true }),
    close: fc.double({ min: 0.5, max: 2.0, noNaN: true, noDefaultInfinity: true }),
    upperWick: fc.double({ min: 0, max: 0.05, noNaN: true, noDefaultInfinity: true }),
    lowerWick: fc.double({ min: 0, max: 0.05, noNaN: true, noDefaultInfinity: true }),
  })
  .map(({ open, close, upperWick, lowerWick }) => {
    const high = Math.max(open, close) + upperWick;
    const low = Math.min(open, close) - lowerWick;
    return { open, high, low, close };
  });

// =============================================================================
// Topology Engine Arbitraries
// =============================================================================

/** Generate an array of valid OHLC candles (30–120 for non-empty topology). */
const arbCandleArray = (minLen: number, maxLen: number): fc.Arbitrary<OHLC[]> =>
  fc.array(arbOHLC, { minLength: minLen, maxLength: maxLen });

/** Generate a 64-character hex string (SHA-256 style). */
const arbHexString64 = fc
  .array(fc.integer({ min: 0, max: 15 }), { minLength: 64, maxLength: 64 })
  .map((arr) => arr.map((n) => n.toString(16)).join(""));

const arbTopologyInput: fc.Arbitrary<TopologyInput> = fc
  .record({
    fingerprint_id: arbHexString64,
    asset: fc.constantFrom("EURUSD", "GBPUSD", "USDJPY"),
    candles: arbCandleArray(30, 120),
  });

// =============================================================================
// Regime Engine v2 Arbitraries
// =============================================================================

const arbStateLayers = fc.record({
  market_structure: fc.array(arbNorm, { minLength: 16, maxLength: 16 }),
  volatility_profile: fc.array(arbNorm, { minLength: 12, maxLength: 12 }),
  liquidity_field: fc.array(arbNorm, { minLength: 20, maxLength: 20 }),
  macro_context: fc.array(arbNorm, { minLength: 8, maxLength: 8 }),
  sentiment_pressure: fc.array(arbNorm, { minLength: 6, maxLength: 6 }),
});

const arbExtendedMarketFeatures = fc.record({
  rolling_trend: fc.option(arbNorm, { nil: undefined }),
  atr_percentile: fc.option(arbNorm, { nil: undefined }),
  volatility_regime_score: fc.option(arbNorm, { nil: undefined }),
  macro_state: fc.option(arbNorm, { nil: undefined }),
  sentiment_summary: fc.option(arbNorm, { nil: undefined }),
});

const arbExtendedState = fc.option(
  fc.record({
    extended_market_features: fc.option(arbExtendedMarketFeatures, { nil: undefined }),
  }),
  { nil: undefined },
);

const arbRegimeV2Input: fc.Arbitrary<RegimeV2Input> = fc.record({
  state_layers: arbStateLayers,
  extended_state: arbExtendedState,
});

// =============================================================================
// Confidence Engine v2 Arbitraries
// =============================================================================

const arbRegimeType = fc.constantFrom(
  "trend", "ranging", "expansion", "contraction", "macro_driven",
  "breakout", "reversal", "accumulation", "distribution",
);

const arbConfidenceInput: fc.Arbitrary<ConfidenceInput> = fc.record({
  up_probability: arbNorm,
  down_probability: arbNorm,
  flat_probability: arbNorm,
  sample_size: fc.integer({ min: 1, max: 500 }),
  variance: arbNorm,
  skew: arbNorm,
  kurtosis: arbNorm,
  mean_similarity: arbNorm,
  similarity_spread: arbNorm,
  top_match_density: arbNorm,
  regime_metadata: fc.record({
    regime_match_ratio: arbNorm,
    dominant_regime: arbRegimeType,
    regime_diversity: arbNorm,
  }),
});

const arbCalibrationParameters: fc.Arbitrary<CalibrationParameters> = fc.record({
  regime_accuracy: fc.dictionary(
    arbRegimeType,
    fc.double({ min: 0, max: 1, noNaN: true, noDefaultInfinity: true }),
    { minKeys: 1, maxKeys: 9 },
  ),
  bucket_success_rates: fc.dictionary(
    fc.constantFrom(
      "0.0-0.1", "0.1-0.2", "0.2-0.3", "0.3-0.4", "0.4-0.5",
      "0.5-0.6", "0.6-0.7", "0.7-0.8", "0.8-0.9", "0.9-1.0",
    ),
    fc.double({ min: 0, max: 1, noNaN: true, noDefaultInfinity: true }),
    { minKeys: 1, maxKeys: 10 },
  ),
  sample_density_curve: fc.array(
    fc.double({ min: 0, max: 1, noNaN: true, noDefaultInfinity: true }),
    { minLength: 50, maxLength: 100 },
  ),
  global_fallback: fc.record({
    base_score: fc.double({ min: 0, max: 1, noNaN: true, noDefaultInfinity: true }),
    regime_modifier: fc.double({ min: 0, max: 1, noNaN: true, noDefaultInfinity: true }),
    sample_modifier: fc.double({ min: 0, max: 1, noNaN: true, noDefaultInfinity: true }),
  }),
});

// =============================================================================
// Extended Fingerprint Features Arbitraries
// =============================================================================

const arbExtendedFeaturesInput: fc.Arbitrary<ExtendedFeaturesInput> = fc.record({
  historical_candles: fc.option(arbCandleArray(1, 50), { nil: undefined }),
  correlated_markets_data: fc.option(
    fc.dictionary(
      fc.constantFrom("GBPUSD", "USDJPY", "AUDUSD", "USDCAD", "EURJPY"),
      fc.double({ min: 0, max: 1, noNaN: true, noDefaultInfinity: true }),
      { minKeys: 0, maxKeys: 5 },
    ),
    { nil: undefined },
  ),
  economic_calendar_data: fc.option(
    fc.record({
      high_impact_event: fc.boolean(),
      hours_to_next_event: fc.double({ min: 0, max: 168, noNaN: true, noDefaultInfinity: true }),
    }),
    { nil: undefined },
  ),
  macro_context: fc.option(
    fc.record({
      dxy: fc.option(fc.double({ min: 90, max: 110, noNaN: true, noDefaultInfinity: true }), { nil: null }),
      vix: fc.option(fc.double({ min: 10, max: 40, noNaN: true, noDefaultInfinity: true }), { nil: null }),
      spx: fc.option(fc.double({ min: 3000, max: 5500, noNaN: true, noDefaultInfinity: true }), { nil: null }),
      us10y: fc.option(fc.double({ min: 1, max: 5, noNaN: true, noDefaultInfinity: true }), { nil: null }),
      gold: fc.option(fc.double({ min: 1500, max: 2500, noNaN: true, noDefaultInfinity: true }), { nil: null }),
    }),
    { nil: undefined },
  ),
  timestamp_utc: fc.date({ min: new Date("2023-01-01"), max: new Date("2025-01-01") })
    .filter((d) => !isNaN(d.getTime()))
    .map((d) => d.toISOString()),
});

const arbExtendedFeaturesConfig: fc.Arbitrary<ExtendedFeaturesConfig> = fc.record({
  rolling_trend: fc.option(fc.boolean(), { nil: undefined }),
  atr_percentile: fc.option(fc.boolean(), { nil: undefined }),
  volatility_regime_score: fc.option(fc.boolean(), { nil: undefined }),
  session_statistics: fc.option(fc.boolean(), { nil: undefined }),
  correlated_markets: fc.option(fc.boolean(), { nil: undefined }),
  economic_calendar_summary: fc.option(fc.boolean(), { nil: undefined }),
  macro_state: fc.option(fc.boolean(), { nil: undefined }),
  sentiment_summary: fc.option(fc.boolean(), { nil: undefined }),
});

// =============================================================================
// Evaluation Engine Arbitraries
// =============================================================================

/** Generate random net_return_pips values spanning up/down/flat outcomes. */
const arbNetReturnPips = fc.double({ min: -100, max: 100, noNaN: true, noDefaultInfinity: true });

/** Generate direction probabilities (not required to sum to 1 for determinism test). */
const arbDirectionProbs = fc.record({
  up: arbNorm,
  down: arbNorm,
  flat: arbNorm,
});

/** Generate confidence_final values in [0, 1]. */
const arbConfidenceFinal = fc.double({ min: 0, max: 1, noNaN: true, noDefaultInfinity: true });

// =============================================================================
// Property Tests
// =============================================================================

describe("Property 1: Universal Engine Determinism", () => {
  describe("Topology Engine — computeTopology", () => {
    it("same input produces bit-identical output on two invocations", () => {
      fc.assert(
        fc.property(arbTopologyInput, (input) => {
          const output1 = computeTopology(input);
          const output2 = computeTopology(input);
          expect(output1).toStrictEqual(output2);
        }),
        { numRuns: 200 },
      );
    });
  });

  describe("Regime Engine v2 — classifyRegimeV2", () => {
    it("same input produces bit-identical output on two invocations", () => {
      fc.assert(
        fc.property(arbRegimeV2Input, (input) => {
          const output1 = classifyRegimeV2(input);
          const output2 = classifyRegimeV2(input);
          expect(output1).toStrictEqual(output2);
        }),
        { numRuns: 200 },
      );
    });
  });

  describe("Confidence Engine v2 — computeConfidenceV2FromInput", () => {
    it("same input + same calibration produces bit-identical output on two invocations", () => {
      fc.assert(
        fc.property(arbConfidenceInput, arbCalibrationParameters, (input, calibration) => {
          const output1 = computeConfidenceV2FromInput(input, calibration);
          const output2 = computeConfidenceV2FromInput(input, calibration);
          expect(output1).toStrictEqual(output2);
        }),
        { numRuns: 200 },
      );
    });
  });

  describe("Extended Fingerprint — computeExtendedFeatures", () => {
    it("same input + config produces bit-identical output on two invocations", () => {
      fc.assert(
        fc.property(arbExtendedFeaturesInput, arbExtendedFeaturesConfig, (input, config) => {
          const output1 = computeExtendedFeatures(input, config);
          const output2 = computeExtendedFeatures(input, config);
          expect(output1).toStrictEqual(output2);
        }),
        { numRuns: 200 },
      );
    });
  });

  describe("Evaluation Engine — pure metric functions", () => {
    it("deriveRealisedDirection: same input produces identical output", () => {
      fc.assert(
        fc.property(arbNetReturnPips, (netReturnPips) => {
          const result1 = deriveRealisedDirection(netReturnPips);
          const result2 = deriveRealisedDirection(netReturnPips);
          expect(result1).toBe(result2);
        }),
        { numRuns: 200 },
      );
    });

    it("derivePredictedDirection: same input produces identical output", () => {
      fc.assert(
        fc.property(arbDirectionProbs, (probs) => {
          const result1 = derivePredictedDirection(probs);
          const result2 = derivePredictedDirection(probs);
          expect(result1).toBe(result2);
        }),
        { numRuns: 200 },
      );
    });

    it("computeBrierScore: same input produces identical output", () => {
      fc.assert(
        fc.property(
          arbDirectionProbs,
          fc.constantFrom("up" as const, "down" as const, "flat" as const),
          (probs, direction) => {
            const result1 = computeBrierScore(probs, direction);
            const result2 = computeBrierScore(probs, direction);
            expect(result1).toBe(result2);
          },
        ),
        { numRuns: 200 },
      );
    });

    it("computeCalibrationBucket: same input produces identical output", () => {
      fc.assert(
        fc.property(arbConfidenceFinal, (confidenceFinal) => {
          const result1 = computeCalibrationBucket(confidenceFinal);
          const result2 = computeCalibrationBucket(confidenceFinal);
          expect(result1).toBe(result2);
        }),
        { numRuns: 200 },
      );
    });
  });
});
