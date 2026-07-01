/**
 * Property-Based Test: Engine Output Schema Completeness
 *
 * Property 2: Engine Output Schema Completeness
 * For random valid inputs to each engine, every successful output contains
 * engine_version, quantile_table_version (where applicable),
 * fingerprint_schema_version (where applicable), and all schema-required fields.
 *
 * **Validates: Requirements 1.3, 2.3, 3.5, 4.4, 5.5, 10.1, 16.1**
 *
 * Minimum 100 iterations per engine.
 */

import { describe, it, expect } from "vitest";
import * as fc from "fast-check";
import { generateFingerprint } from "../../src/engines/fingerprint-engine.js";
import {
  getRegimeWeights,
  computeAggregateScore,
  generateMatchExplanation,
} from "../../src/engines/similarity-engine.js";
import { computeDistributionFromReturns } from "../../src/engines/outcome-engine.js";
import { computeForecastFromDistribution } from "../../src/engines/forecast-engine.js";
import { computeConfidenceFromInput } from "../../src/engines/confidence-engine.js";
import { computeTradeabilityFromInput } from "../../src/engines/tradeability-engine.js";
import type {
  FingerprintInput,
  MacroContext,
  OutcomeDistribution,
  ConfidenceInput,
  RegimeClassification,
  Forecast,
} from "../../src/types/index.js";
import { Session } from "../../src/types/enums.js";

// =============================================================================
// Arbitraries
// =============================================================================

const arbOHLC = fc
  .record({
    open: fc.double({ min: 0.5, max: 2.0, noNaN: true, noDefaultInfinity: true }),
    close: fc.double({ min: 0.5, max: 2.0, noNaN: true, noDefaultInfinity: true }),
    highExtension: fc.double({ min: 0, max: 0.05, noNaN: true, noDefaultInfinity: true }),
    lowExtension: fc.double({ min: 0, max: 0.05, noNaN: true, noDefaultInfinity: true }),
  })
  .map(({ open, close, highExtension, lowExtension }) => ({
    open,
    close,
    high: Math.max(open, close) + highExtension,
    low: Math.min(open, close) - lowExtension,
  }));

const arbTimestamp = fc
  .integer({
    min: new Date("2019-01-01T00:00:00.000Z").getTime(),
    max: new Date("2025-12-31T23:59:59.000Z").getTime(),
  })
  .map((ms) => new Date(ms).toISOString());

const arbMacroContext: fc.Arbitrary<MacroContext> = fc.record({
  dxy: fc.oneof(
    fc.constant(null),
    fc.double({ min: 85, max: 115, noNaN: true, noDefaultInfinity: true }),
  ),
  vix: fc.oneof(
    fc.constant(null),
    fc.double({ min: 8, max: 50, noNaN: true, noDefaultInfinity: true }),
  ),
  spx: fc.oneof(
    fc.constant(null),
    fc.double({ min: 2500, max: 6000, noNaN: true, noDefaultInfinity: true }),
  ),
  us10y: fc.oneof(
    fc.constant(null),
    fc.double({ min: 0.5, max: 6, noNaN: true, noDefaultInfinity: true }),
  ),
  gold: fc.oneof(
    fc.constant(null),
    fc.double({ min: 1200, max: 2800, noNaN: true, noDefaultInfinity: true }),
  ),
});

const arbFingerprintInput: fc.Arbitrary<FingerprintInput> = fc.record({
  asset: fc.constantFrom("EURUSD", "GBPUSD", "USDJPY", "AUDUSD"),
  timestamp_utc: arbTimestamp,
  ohlc: arbOHLC,
  market_context: fc.oneof(fc.constant(undefined), arbMacroContext),
});

/** Generates an array of non-zero-length forward returns */
const arbForwardReturns = fc.array(
  fc.double({ min: -100, max: 100, noNaN: true, noDefaultInfinity: true }),
  { minLength: 1, maxLength: 200 },
);

/** Generates a valid RegimeClassification */
const arbRegimeClassification: fc.Arbitrary<RegimeClassification> = fc.record({
  volatility_regime: fc.constantFrom("LOW" as const, "NORMAL" as const, "HIGH" as const),
  trend_regime: fc.constantFrom("BULLISH" as const, "BEARISH" as const, "RANGING" as const),
  session: fc.constantFrom("ASIA" as const, "LONDON" as const, "NY" as const),
});

/** Generates a valid ConfidenceInput */
const arbConfidenceInput: fc.Arbitrary<ConfidenceInput> = fc.record({
  up_probability: fc.double({ min: 0, max: 1, noNaN: true, noDefaultInfinity: true }),
  down_probability: fc.double({ min: 0, max: 1, noNaN: true, noDefaultInfinity: true }),
  flat_probability: fc.double({ min: 0, max: 1, noNaN: true, noDefaultInfinity: true }),
  sample_size: fc.integer({ min: 1, max: 500 }),
  variance: fc.double({ min: 0, max: 1, noNaN: true, noDefaultInfinity: true }),
  skew: fc.double({ min: 0, max: 1, noNaN: true, noDefaultInfinity: true }),
  kurtosis: fc.double({ min: 0, max: 1, noNaN: true, noDefaultInfinity: true }),
  mean_similarity: fc.double({ min: 0, max: 1, noNaN: true, noDefaultInfinity: true }),
  similarity_spread: fc.double({ min: 0, max: 1, noNaN: true, noDefaultInfinity: true }),
  top_match_density: fc.double({ min: 0, max: 1, noNaN: true, noDefaultInfinity: true }),
  regime_metadata: fc.record({
    regime_match_ratio: fc.double({ min: 0, max: 1, noNaN: true, noDefaultInfinity: true }),
    dominant_regime: fc.constantFrom("LOW_RANGING", "HIGH_BULLISH", "NORMAL_BEARISH"),
    regime_diversity: fc.double({ min: 0, max: 1, noNaN: true, noDefaultInfinity: true }),
  }),
});

/** Generates a valid Forecast for tradeability input */
const arbForecast: fc.Arbitrary<Forecast> = fc.record({
  fingerprint_id: fc.uuid(),
  direction_probabilities: fc.record({
    up: fc.double({ min: 0, max: 1, noNaN: true, noDefaultInfinity: true }),
    down: fc.double({ min: 0, max: 1, noNaN: true, noDefaultInfinity: true }),
    flat: fc.double({ min: 0, max: 1, noNaN: true, noDefaultInfinity: true }),
  }),
  expected_move_pips: fc.double({ min: -100, max: 100, noNaN: true, noDefaultInfinity: true }),
  confidence_raw: fc.double({ min: 0, max: 1, noNaN: true, noDefaultInfinity: true }),
  confidence_final: fc.double({ min: 0, max: 1, noNaN: true, noDefaultInfinity: true }),
  engine_version: fc.constant("1.0.0"),
  batch_id: fc.uuid(),
});

// =============================================================================
// Property Tests
// =============================================================================

describe("Property 2: Engine Output Schema Completeness", () => {
  describe("Fingerprint Engine", () => {
    it("output contains all schema-required fields including quantile_table_version", () => {
      fc.assert(
        fc.property(arbFingerprintInput, (input) => {
          const fp = generateFingerprint(input);

          // Top-level required fields
          expect(fp.fingerprint_id).toBeDefined();
          expect(typeof fp.fingerprint_id).toBe("string");
          expect(fp.asset).toBeDefined();
          expect(typeof fp.asset).toBe("string");
          expect(fp.timeframe).toBeDefined();
          expect(typeof fp.timeframe).toBe("string");
          expect(fp.timestamp_utc).toBeDefined();
          expect(typeof fp.timestamp_utc).toBe("string");
          expect(fp.market_state_version).toBeDefined();
          expect(typeof fp.market_state_version).toBe("string");

          // OHLC required fields
          expect(fp.ohlc).toBeDefined();
          expect(typeof fp.ohlc.open).toBe("number");
          expect(typeof fp.ohlc.high).toBe("number");
          expect(typeof fp.ohlc.low).toBe("number");
          expect(typeof fp.ohlc.close).toBe("number");

          // Return profile required fields
          expect(fp.return_profile).toBeDefined();
          expect(typeof fp.return_profile.net_return_pips).toBe("number");
          expect(typeof fp.return_profile.range_pips).toBe("number");

          // Regime required fields
          expect(fp.regime).toBeDefined();
          expect(fp.regime.volatility_regime).toBeDefined();
          expect(fp.regime.trend_regime).toBeDefined();
          expect(fp.regime.session).toBeDefined();

          // State layers: all 5 layers with correct dimensions
          expect(fp.state_layers).toBeDefined();
          expect(fp.state_layers.market_structure).toHaveLength(16);
          expect(fp.state_layers.volatility_profile).toHaveLength(12);
          expect(fp.state_layers.liquidity_field).toHaveLength(20);
          expect(fp.state_layers.macro_context).toHaveLength(8);
          expect(fp.state_layers.sentiment_pressure).toHaveLength(6);

          // Normalisation with quantile_table_version and scaling_method
          expect(fp.normalisation).toBeDefined();
          expect(fp.normalisation.quantile_table_version).toBeDefined();
          expect(typeof fp.normalisation.quantile_table_version).toBe("string");
          expect(fp.normalisation.scaling_method).toBeDefined();
          expect(typeof fp.normalisation.scaling_method).toBe("string");
        }),
        { numRuns: 100 },
      );
    });
  });

  describe("Similarity Engine (pure helpers)", () => {
    it("getRegimeWeights returns all 5 layer weights for any valid regime", () => {
      fc.assert(
        fc.property(arbRegimeClassification, (regime) => {
          const weights = getRegimeWeights(regime);

          // All 5 layer weights must be present
          expect(weights).toBeDefined();
          expect(typeof weights.market_structure).toBe("number");
          expect(typeof weights.volatility).toBe("number");
          expect(typeof weights.liquidity).toBe("number");
          expect(typeof weights.macro).toBe("number");
          expect(typeof weights.sentiment).toBe("number");

          // Weights should be in valid range [0, 1]
          expect(weights.market_structure).toBeGreaterThanOrEqual(0);
          expect(weights.market_structure).toBeLessThanOrEqual(1);
          expect(weights.volatility).toBeGreaterThanOrEqual(0);
          expect(weights.volatility).toBeLessThanOrEqual(1);
          expect(weights.liquidity).toBeGreaterThanOrEqual(0);
          expect(weights.liquidity).toBeLessThanOrEqual(1);
          expect(weights.macro).toBeGreaterThanOrEqual(0);
          expect(weights.macro).toBeLessThanOrEqual(1);
          expect(weights.sentiment).toBeGreaterThanOrEqual(0);
          expect(weights.sentiment).toBeLessThanOrEqual(1);
        }),
        { numRuns: 100 },
      );
    });

    it("computeAggregateScore returns a score with generateMatchExplanation providing all required fields", () => {
      const arbLayerScores = fc.record({
        market_structure: fc.double({ min: 0, max: 1, noNaN: true, noDefaultInfinity: true }),
        volatility: fc.double({ min: 0, max: 1, noNaN: true, noDefaultInfinity: true }),
        liquidity: fc.double({ min: 0, max: 1, noNaN: true, noDefaultInfinity: true }),
        macro: fc.double({ min: 0, max: 1, noNaN: true, noDefaultInfinity: true }),
        sentiment: fc.double({ min: 0, max: 1, noNaN: true, noDefaultInfinity: true }),
      });

      fc.assert(
        fc.property(arbLayerScores, arbRegimeClassification, (layerScores, regime) => {
          const weights = getRegimeWeights(regime);
          const score = computeAggregateScore(layerScores, weights);

          // Score must be a number in [0, 1]
          expect(typeof score).toBe("number");
          expect(score).toBeGreaterThanOrEqual(0);
          expect(score).toBeLessThanOrEqual(1);

          // Match explanation must have all required fields
          const explanation = generateMatchExplanation(layerScores, weights);
          expect(explanation).toBeDefined();
          expect(Array.isArray(explanation.matched_layers)).toBe(true);
          expect(Array.isArray(explanation.mismatched_layers)).toBe(true);
          expect(typeof explanation.primary_match_reason).toBe("string");
          expect(explanation.primary_match_reason.length).toBeGreaterThan(0);
        }),
        { numRuns: 100 },
      );
    });
  });

  describe("Outcome Engine", () => {
    it("output contains all schema-required fields including engine_version", () => {
      fc.assert(
        fc.property(
          arbForwardReturns,
          fc.uuid(),
          fc.uuid(),
          (forwardReturns, queryFingerprintId, batchId) => {
            const distribution = computeDistributionFromReturns(
              forwardReturns,
              queryFingerprintId,
              batchId,
            );

            // All required top-level fields
            expect(distribution.fingerprint_id).toBeDefined();
            expect(typeof distribution.fingerprint_id).toBe("string");
            expect(typeof distribution.sample_size).toBe("number");
            expect(distribution.sample_size).toBeGreaterThanOrEqual(1);
            expect(typeof distribution.mean_return).toBe("number");
            expect(typeof distribution.median_return).toBe("number");

            // Direction probability required fields
            expect(distribution.direction_probability).toBeDefined();
            expect(typeof distribution.direction_probability.up).toBe("number");
            expect(typeof distribution.direction_probability.down).toBe("number");
            expect(typeof distribution.direction_probability.flat).toBe("number");

            // Volatility profile required fields
            expect(distribution.volatility_profile).toBeDefined();
            expect(typeof distribution.volatility_profile.std_dev).toBe("number");
            expect(typeof distribution.volatility_profile.max_absolute_return).toBe("number");

            // Risk range required fields
            expect(distribution.risk_range).toBeDefined();
            expect(typeof distribution.risk_range.p10).toBe("number");
            expect(typeof distribution.risk_range.p50).toBe("number");
            expect(typeof distribution.risk_range.p90).toBe("number");

            // Confidence inputs required fields
            expect(distribution.confidence_inputs).toBeDefined();
            expect(typeof distribution.confidence_inputs.regime_consistency).toBe("number");
            expect(typeof distribution.confidence_inputs.distribution_sharpness).toBe("number");

            // Versioning / tracing fields
            expect(distribution.batch_id).toBeDefined();
            expect(typeof distribution.batch_id).toBe("string");
            expect(distribution.engine_version).toBeDefined();
            expect(typeof distribution.engine_version).toBe("string");
          },
        ),
        { numRuns: 100 },
      );
    });
  });

  describe("Forecast Engine", () => {
    it("output contains all schema-required fields including engine_version", () => {
      // Generate a valid OutcomeDistribution as input
      const arbOutcomeDistribution: fc.Arbitrary<OutcomeDistribution> = fc
        .tuple(arbForwardReturns, fc.uuid(), fc.uuid())
        .map(([returns, fpId, batchId]) =>
          computeDistributionFromReturns(returns, fpId, batchId),
        );

      fc.assert(
        fc.property(arbOutcomeDistribution, (distribution) => {
          const forecast = computeForecastFromDistribution(distribution);

          // All required top-level fields
          expect(forecast.fingerprint_id).toBeDefined();
          expect(typeof forecast.fingerprint_id).toBe("string");

          // Direction probabilities
          expect(forecast.direction_probabilities).toBeDefined();
          expect(typeof forecast.direction_probabilities.up).toBe("number");
          expect(typeof forecast.direction_probabilities.down).toBe("number");
          expect(typeof forecast.direction_probabilities.flat).toBe("number");

          // Expected move
          expect(typeof forecast.expected_move_pips).toBe("number");

          // Confidence fields (placeholders from Forecast Engine)
          expect(typeof forecast.confidence_raw).toBe("number");
          expect(typeof forecast.confidence_final).toBe("number");

          // Versioning / tracing fields
          expect(forecast.engine_version).toBeDefined();
          expect(typeof forecast.engine_version).toBe("string");
          expect(forecast.batch_id).toBeDefined();
          expect(typeof forecast.batch_id).toBe("string");
        }),
        { numRuns: 100 },
      );
    });
  });

  describe("Confidence Engine", () => {
    it("output contains all schema-required fields", () => {
      fc.assert(
        fc.property(arbConfidenceInput, (input) => {
          const output = computeConfidenceFromInput(input);

          // All required output fields
          expect(typeof output.confidence_raw).toBe("number");
          expect(typeof output.sample_weight).toBe("number");
          expect(typeof output.regime_stability).toBe("number");
          expect(typeof output.confidence_final).toBe("number");

          // All values bounded [0, 1]
          expect(output.confidence_raw).toBeGreaterThanOrEqual(0);
          expect(output.confidence_raw).toBeLessThanOrEqual(1);
          expect(output.sample_weight).toBeGreaterThanOrEqual(0);
          expect(output.sample_weight).toBeLessThanOrEqual(1);
          expect(output.regime_stability).toBeGreaterThanOrEqual(0);
          expect(output.regime_stability).toBeLessThanOrEqual(1);
          expect(output.confidence_final).toBeGreaterThanOrEqual(0);
          expect(output.confidence_final).toBeLessThanOrEqual(1);
        }),
        { numRuns: 100 },
      );
    });
  });

  describe("Tradeability Engine", () => {
    it("output contains all schema-required fields", () => {
      fc.assert(
        fc.property(
          arbForecast,
          fc.double({ min: 0, max: 20, noNaN: true, noDefaultInfinity: true }),
          fc.constantFrom(Session.ASIA, Session.LONDON, Session.NY),
          fc.double({ min: 0, max: 1, noNaN: true, noDefaultInfinity: true }),
          fc.boolean(),
          (forecast, spreadPips, sessionState, liquidityProxy, newsRisk) => {
            const output = computeTradeabilityFromInput({
              forecast,
              spread_pips: spreadPips,
              session_state: sessionState,
              live_liquidity_proxy: liquidityProxy,
              news_risk_flag: newsRisk,
            });

            // All required output fields
            expect(typeof output.tradeability_score).toBe("number");
            expect(output.tradeability_score).toBeGreaterThanOrEqual(0);
            expect(output.tradeability_score).toBeLessThanOrEqual(1);

            expect(output.tradeability_label).toBeDefined();
            expect(["GO", "CONDITIONAL", "NO_GO"]).toContain(output.tradeability_label);

            // Execution metrics required fields
            expect(output.execution_metrics).toBeDefined();
            expect(output.execution_metrics.spread_penalty).toBeDefined();
            expect(["low", "medium", "high"]).toContain(output.execution_metrics.spread_penalty);
            expect(output.execution_metrics.session_alignment).toBeDefined();
            expect(["optimal", "suboptimal", "poor"]).toContain(
              output.execution_metrics.session_alignment,
            );
            expect(output.execution_metrics.news_buffer_status).toBeDefined();
            expect(["clear", "warning", "blocked"]).toContain(
              output.execution_metrics.news_buffer_status,
            );
          },
        ),
        { numRuns: 100 },
      );
    });
  });
});
