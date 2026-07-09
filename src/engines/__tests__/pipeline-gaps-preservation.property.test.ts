/**
 * Pipeline Gaps Preservation Property Tests
 *
 * These tests capture the existing behavior of the code BEFORE any fixes are applied.
 * They MUST PASS on the unfixed code — confirming baseline behavior to preserve.
 *
 * **Property 2: Preservation** - Existing Tradeability Formula, Graceful Degradation,
 * 5-Layer Aggregation Unchanged
 *
 * **Validates: Requirements 3.1, 3.2, 3.3, 3.4, 3.7**
 */

import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';
import {
  computeTradeabilityFromInput,
  computeStaticScore,
  computeDynamicScore,
  computeLabel,
  computeSpreadFactor,
  computeSessionFactor,
  computeLiquidityFactor,
  computeNewsFactor,
} from '../tradeability-engine.js';
import {
  computeAggregateScore,
  getRegimeWeights,
  REGIME_WEIGHT_MATRICES,
} from '../similarity-engine.js';
import {
  computeConfidenceV2FromInput,
  type CalibrationParameters,
} from '../confidence-engine-v2.js';
import { Session, VolatilityRegime, TrendRegime, TradeabilityLabel } from '../../types/enums.js';
import type { Forecast, RegimeWeightMatrix, RegimeClassification } from '../../types/index.js';

// =============================================================================
// Shared Generators
// =============================================================================

/**
 * Generates a valid Forecast with confidence_final in (0, 1].
 */
function arbForecast(): fc.Arbitrary<Forecast> {
  return fc.record({
    fingerprint_id: fc.constant('test-fp-001'),
    direction_probabilities: fc.record({
      up: fc.double({ min: 0.01, max: 0.98, noNaN: true, noDefaultInfinity: true }),
      down: fc.double({ min: 0.01, max: 0.98, noNaN: true, noDefaultInfinity: true }),
      flat: fc.double({ min: 0.01, max: 0.98, noNaN: true, noDefaultInfinity: true }),
    }),
    expected_move_pips: fc.double({ min: 1, max: 200, noNaN: true, noDefaultInfinity: true }),
    confidence_raw: fc.double({ min: 0.01, max: 1, noNaN: true, noDefaultInfinity: true }),
    confidence_final: fc.double({ min: 0.01, max: 1, noNaN: true, noDefaultInfinity: true }),
    engine_version: fc.constant('1.0.0'),
    batch_id: fc.constant('batch-001'),
  });
}

/**
 * Generates a valid Session enum value.
 */
function arbSession(): fc.Arbitrary<Session> {
  return fc.constantFrom(Session.ASIA, Session.LONDON, Session.NY);
}

/**
 * Generates a valid spread_pips value (>= 0).
 */
function arbSpreadPips(): fc.Arbitrary<number> {
  return fc.double({ min: 0, max: 20, noNaN: true, noDefaultInfinity: true });
}

/**
 * Generates a valid live_liquidity_proxy in [0, 1].
 */
function arbLiquidityProxy(): fc.Arbitrary<number> {
  return fc.double({ min: 0, max: 1, noNaN: true, noDefaultInfinity: true });
}

/**
 * Generates a valid VolatilityRegime.
 */
function arbVolatilityRegime(): fc.Arbitrary<VolatilityRegime> {
  return fc.constantFrom(VolatilityRegime.LOW, VolatilityRegime.NORMAL, VolatilityRegime.HIGH);
}

/**
 * Generates a valid TrendRegime.
 */
function arbTrendRegime(): fc.Arbitrary<TrendRegime> {
  return fc.constantFrom(TrendRegime.BULLISH, TrendRegime.BEARISH, TrendRegime.RANGING);
}

/**
 * Generates a valid RegimeClassification.
 */
function arbRegimeClassification(): fc.Arbitrary<RegimeClassification> {
  return fc.record({
    volatility_regime: arbVolatilityRegime(),
    trend_regime: arbTrendRegime(),
    session: arbSession(),
  });
}

/**
 * Generates valid layer scores, each in [0, 1].
 */
function arbLayerScores() {
  return fc.record({
    market_structure: fc.double({ min: 0, max: 1, noNaN: true, noDefaultInfinity: true }),
    volatility: fc.double({ min: 0, max: 1, noNaN: true, noDefaultInfinity: true }),
    liquidity: fc.double({ min: 0, max: 1, noNaN: true, noDefaultInfinity: true }),
    macro: fc.double({ min: 0, max: 1, noNaN: true, noDefaultInfinity: true }),
    sentiment: fc.double({ min: 0, max: 1, noNaN: true, noDefaultInfinity: true }),
  });
}

/**
 * Generates a valid RegimeWeightMatrix (weights in [0, 1]).
 */
function arbWeightMatrix(): fc.Arbitrary<RegimeWeightMatrix> {
  return fc.record({
    market_structure: fc.double({ min: 0, max: 1, noNaN: true, noDefaultInfinity: true }),
    volatility: fc.double({ min: 0, max: 1, noNaN: true, noDefaultInfinity: true }),
    liquidity: fc.double({ min: 0, max: 1, noNaN: true, noDefaultInfinity: true }),
    macro: fc.double({ min: 0, max: 1, noNaN: true, noDefaultInfinity: true }),
    sentiment: fc.double({ min: 0, max: 1, noNaN: true, noDefaultInfinity: true }),
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

// =============================================================================
// Helper: Clamp and round to match engine behavior
// =============================================================================

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function roundTo2dp(value: number): number {
  return Math.round(value * 100) / 100;
}

function roundTo6dp(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}

// =============================================================================
// 1. Tradeability Formula Preservation
// =============================================================================

describe('Preservation: Tradeability Formula', () => {
  /**
   * **Validates: Requirements 3.2**
   *
   * For all forecast.confidence_final ∈ (0, 1] with all non-null dynamic inputs,
   * assert score = clamp(S_static × D_dynamic, 0, 1) with label bands
   * GO > 0.75, CONDITIONAL ≥ 0.45, NO_GO < 0.45.
   */
  it('tradeability_score = clamp(S_static × D_dynamic, 0, 1) for all valid non-null inputs', () => {
    fc.assert(
      fc.property(
        arbForecast(),
        arbSpreadPips(),
        arbSession(),
        arbLiquidityProxy(),
        fc.boolean(),
        (forecast, spreadPips, session, liquidityProxy, newsRisk) => {
          const input = {
            forecast,
            spread_pips: spreadPips,
            session_state: session,
            live_liquidity_proxy: liquidityProxy,
            news_risk_flag: newsRisk,
          };

          const result = computeTradeabilityFromInput(input);

          // Compute expected S_static and D_dynamic
          const sStatic = clamp(forecast.confidence_final, 0, 1);
          const spreadFactor = computeSpreadFactor(spreadPips);
          const sessionFactor = computeSessionFactor(session);
          const liquidityFactor = computeLiquidityFactor(liquidityProxy);
          const newsFactor = computeNewsFactor(newsRisk);
          const dDynamic = clamp(spreadFactor * sessionFactor * liquidityFactor * newsFactor, 0, 1);

          const expectedScore = roundTo2dp(clamp(sStatic * dDynamic, 0, 1));

          // Score must match formula
          expect(result.tradeability_score).toBe(expectedScore);

          // Label banding must be correct
          if (expectedScore > 0.75) {
            expect(result.tradeability_label).toBe(TradeabilityLabel.GO);
          } else if (expectedScore >= 0.45) {
            expect(result.tradeability_label).toBe(TradeabilityLabel.CONDITIONAL);
          } else {
            expect(result.tradeability_label).toBe(TradeabilityLabel.NO_GO);
          }
        },
      ),
      { numRuns: 200 },
    );
  });
});

// =============================================================================
// 2. Graceful Degradation Preservation
// =============================================================================

describe('Preservation: Graceful Degradation', () => {
  /**
   * **Validates: Requirements 3.3**
   *
   * For all inputs with at least one null dynamic source,
   * assert score = 0, label = NO_GO, unavailable_sources lists the null fields.
   */
  it('null dynamic sources produce score = 0, label = NO_GO, and list unavailable sources', () => {
    // Generate inputs where at least one dynamic field is null
    const arbNullableInput = fc.record({
      forecast: arbForecast(),
      spread_pips: fc.oneof(
        fc.constant(null as number | null),
        fc.double({ min: 0, max: 10, noNaN: true, noDefaultInfinity: true }),
      ),
      session_state: fc.oneof(
        fc.constant(null as Session | null),
        arbSession(),
      ),
      live_liquidity_proxy: fc.oneof(
        fc.constant(null as number | null),
        fc.double({ min: 0, max: 1, noNaN: true, noDefaultInfinity: true }),
      ),
      news_risk_flag: fc.oneof(
        fc.constant(null as boolean | null),
        fc.boolean(),
      ),
    }).filter((input) => {
      // Ensure at least one field is null
      return (
        input.spread_pips === null ||
        input.session_state === null ||
        input.live_liquidity_proxy === null ||
        input.news_risk_flag === null
      );
    });

    fc.assert(
      fc.property(arbNullableInput, (input) => {
        const result = computeTradeabilityFromInput(input);

        // Score must be 0
        expect(result.tradeability_score).toBe(0);

        // Label must be NO_GO
        expect(result.tradeability_label).toBe(TradeabilityLabel.NO_GO);

        // Must be degraded
        expect(result.degraded).toBe(true);

        // unavailable_sources must list the null fields
        expect(result.unavailable_sources).toBeDefined();
        expect(result.unavailable_sources!.length).toBeGreaterThan(0);

        // Verify each null field is listed
        if (input.spread_pips === null) {
          expect(result.unavailable_sources).toContain('spread_pips');
        }
        if (input.session_state === null) {
          expect(result.unavailable_sources).toContain('session_state');
        }
        if (input.live_liquidity_proxy === null) {
          expect(result.unavailable_sources).toContain('live_liquidity_proxy');
        }
        if (input.news_risk_flag === null) {
          expect(result.unavailable_sources).toContain('news_risk_flag');
        }
      }),
      { numRuns: 200 },
    );
  });
});

// =============================================================================
// 3. 5-Layer Aggregate Preservation
// =============================================================================

describe('Preservation: 5-Layer Aggregate Score', () => {
  /**
   * **Validates: Requirements 3.1, 3.7**
   *
   * For all valid layer scores in [0,1] and valid RegimeWeightMatrix,
   * assert computeAggregateScore produces sum(layer_i × weight_i) clamped and rounded to 6dp.
   */
  it('computeAggregateScore produces sum(layer_i × weight_i) clamped [0,1] rounded to 6dp', () => {
    fc.assert(
      fc.property(
        arbLayerScores(),
        arbWeightMatrix(),
        (layerScores, weights) => {
          const result = computeAggregateScore(layerScores, weights);

          // Compute expected: linear combination, clamped, rounded to 6dp
          const rawSum =
            layerScores.market_structure * weights.market_structure +
            layerScores.volatility * weights.volatility +
            layerScores.liquidity * weights.liquidity +
            layerScores.macro * weights.macro +
            layerScores.sentiment * weights.sentiment;

          const expected = roundTo6dp(clamp(rawSum, 0, 1));

          expect(result).toBe(expected);

          // Result must be bounded [0, 1]
          expect(result).toBeGreaterThanOrEqual(0);
          expect(result).toBeLessThanOrEqual(1);
        },
      ),
      { numRuns: 200 },
    );
  });

  /**
   * Additional property: computeAggregateScore is deterministic —
   * identical inputs produce identical outputs.
   */
  it('computeAggregateScore is deterministic for identical inputs', () => {
    fc.assert(
      fc.property(
        arbLayerScores(),
        arbWeightMatrix(),
        (layerScores, weights) => {
          const result1 = computeAggregateScore(layerScores, weights);
          const result2 = computeAggregateScore(layerScores, weights);
          expect(result1).toBe(result2);
        },
      ),
      { numRuns: 100 },
    );
  });
});

// =============================================================================
// 4. Regime Weight Immutability
// =============================================================================

describe('Preservation: Regime Weight Immutability', () => {
  /**
   * **Validates: Requirements 3.1, 3.7**
   *
   * For all valid RegimeClassification, assert getRegimeWeights returns values
   * matching frozen REGIME_WEIGHT_MATRICES.
   */
  it('getRegimeWeights returns values matching frozen REGIME_WEIGHT_MATRICES', () => {
    fc.assert(
      fc.property(
        arbRegimeClassification(),
        (regime) => {
          const result = getRegimeWeights(regime);
          const key = `${regime.volatility_regime}_${regime.trend_regime}`;

          const expectedMatrix = REGIME_WEIGHT_MATRICES[key];

          if (expectedMatrix) {
            // When a matching key exists, the result must match exactly
            expect(result.market_structure).toBe(expectedMatrix.market_structure);
            expect(result.volatility).toBe(expectedMatrix.volatility);
            expect(result.liquidity).toBe(expectedMatrix.liquidity);
            expect(result.macro).toBe(expectedMatrix.macro);
            expect(result.sentiment).toBe(expectedMatrix.sentiment);
          } else {
            // Default matrix: all 0.20
            expect(result.market_structure).toBe(0.20);
            expect(result.volatility).toBe(0.20);
            expect(result.liquidity).toBe(0.20);
            expect(result.macro).toBe(0.20);
            expect(result.sentiment).toBe(0.20);
          }
        },
      ),
      { numRuns: 100 },
    );
  });

  /**
   * All valid regime combinations have a defined weight matrix.
   */
  it('all valid regime combinations have a matrix in REGIME_WEIGHT_MATRICES', () => {
    fc.assert(
      fc.property(
        arbRegimeClassification(),
        (regime) => {
          const key = `${regime.volatility_regime}_${regime.trend_regime}`;
          // All 9 combinations (3 volatility × 3 trend) should be defined
          expect(REGIME_WEIGHT_MATRICES[key]).toBeDefined();
        },
      ),
      { numRuns: 100 },
    );
  });
});

// =============================================================================
// 5. Confidence V2 Zero-Sample Rejection
// =============================================================================

describe('Preservation: Confidence V2 Zero-Sample Rejection', () => {
  /**
   * **Validates: Requirements 3.4**
   *
   * Assert computeConfidenceV2FromInput throws for sample_size = 0
   * regardless of calibration parameters.
   */
  it('computeConfidenceV2FromInput throws for sample_size = 0 regardless of calibration', () => {
    fc.assert(
      fc.property(
        arbCalibrationParameters(),
        (calibration) => {
          const input = {
            up_probability: 0.5,
            down_probability: 0.3,
            flat_probability: 0.2,
            sample_size: 0,
            variance: 0.3,
            skew: 0.4,
            kurtosis: 0.5,
            mean_similarity: 0.7,
            similarity_spread: 0.2,
            top_match_density: 0.6,
            regime_metadata: {
              regime_match_ratio: 0.8,
              dominant_regime: 'NORMAL_RANGING',
              regime_diversity: 0.3,
            },
          };

          expect(() => computeConfidenceV2FromInput(input, calibration)).toThrow(
            'Cannot compute confidence: sample_size is 0',
          );
        },
      ),
      { numRuns: 100 },
    );
  });
});
