/**
 * Property-Based Test: Feature Enablement via Config
 *
 * Property 17: Feature Enablement via Config
 * - Generate configs with random enabled/disabled features
 * - Verify only enabled features appear in extended_state output
 * - Verify disabled features are absent from output
 *
 * **Validates: Requirements 14.2**
 */

import { describe, it, expect } from "vitest";
import * as fc from "fast-check";
import { computeExtendedFeatures } from "../../src/engines/fingerprint-engine.js";
import type {
  ExtendedFeaturesInput,
  ExtendedFeaturesConfig,
  OHLC,
  MacroContext,
} from "../../src/types/index.js";

// =============================================================================
// Arbitraries
// =============================================================================

/**
 * Generates a valid OHLC candle with realistic price relationships:
 * open and close within [low, high], and high >= low.
 */
const arbOHLC: fc.Arbitrary<OHLC> = fc
  .record({
    base: fc.double({ min: 1.0, max: 2.0, noNaN: true, noDefaultInfinity: true }),
    range: fc.double({ min: 0.0001, max: 0.05, noNaN: true, noDefaultInfinity: true }),
    openFrac: fc.double({ min: 0, max: 1, noNaN: true, noDefaultInfinity: true }),
    closeFrac: fc.double({ min: 0, max: 1, noNaN: true, noDefaultInfinity: true }),
  })
  .map(({ base, range, openFrac, closeFrac }) => ({
    open: base + openFrac * range,
    high: base + range,
    low: base,
    close: base + closeFrac * range,
  }));

/**
 * Generates a valid MacroContext with all fields populated (non-null).
 */
const arbMacroContext: fc.Arbitrary<MacroContext> = fc.record({
  dxy: fc.double({ min: 85, max: 115, noNaN: true, noDefaultInfinity: true }),
  vix: fc.double({ min: 10, max: 50, noNaN: true, noDefaultInfinity: true }),
  spx: fc.double({ min: 3000, max: 6000, noNaN: true, noDefaultInfinity: true }),
  us10y: fc.double({ min: 1, max: 5, noNaN: true, noDefaultInfinity: true }),
  gold: fc.double({ min: 1500, max: 2500, noNaN: true, noDefaultInfinity: true }),
});

/**
 * Generates a valid ExtendedFeaturesInput with all data present,
 * so every feature CAN be computed when enabled.
 */
const arbInput: fc.Arbitrary<ExtendedFeaturesInput> = fc.record({
  historical_candles: fc.array(arbOHLC, { minLength: 50, maxLength: 50 }),
  correlated_markets_data: fc.record({
    EURUSD: fc.double({ min: 0, max: 1, noNaN: true, noDefaultInfinity: true }),
    GBPUSD: fc.double({ min: 0, max: 1, noNaN: true, noDefaultInfinity: true }),
    USDJPY: fc.double({ min: 0, max: 1, noNaN: true, noDefaultInfinity: true }),
  }),
  economic_calendar_data: fc.record({
    high_impact_event: fc.boolean(),
    hours_to_next_event: fc.double({ min: 0, max: 168, noNaN: true, noDefaultInfinity: true }),
  }),
  macro_context: arbMacroContext,
  timestamp_utc: fc
    .integer({
      min: new Date("2024-01-01T00:00:00Z").getTime(),
      max: new Date("2025-01-01T00:00:00Z").getTime(),
    })
    .map((ms) => new Date(ms).toISOString()),
});

/**
 * Generates a random ExtendedFeaturesConfig where each feature flag
 * is randomly true or false.
 */
const arbConfig: fc.Arbitrary<ExtendedFeaturesConfig> = fc.record({
  rolling_trend: fc.boolean(),
  atr_percentile: fc.boolean(),
  volatility_regime_score: fc.boolean(),
  session_statistics: fc.boolean(),
  correlated_markets: fc.boolean(),
  economic_calendar_summary: fc.boolean(),
  macro_state: fc.boolean(),
  sentiment_summary: fc.boolean(),
});

/** All feature keys that can be toggled in the config. */
const ALL_FEATURE_KEYS: (keyof ExtendedFeaturesConfig)[] = [
  "rolling_trend",
  "atr_percentile",
  "volatility_regime_score",
  "session_statistics",
  "correlated_markets",
  "economic_calendar_summary",
  "macro_state",
  "sentiment_summary",
];

// =============================================================================
// Property Tests
// =============================================================================

describe("Property 17: Feature Enablement via Config", () => {
  it("enabled features are present in output", () => {
    fc.assert(
      fc.property(arbInput, arbConfig, (input, config) => {
        const result = computeExtendedFeatures(input, config);

        for (const key of ALL_FEATURE_KEYS) {
          if (config[key] === true) {
            expect(result[key]).not.toBeUndefined();
          }
        }
      }),
      { numRuns: 200 },
    );
  });

  it("disabled features are absent from output", () => {
    fc.assert(
      fc.property(arbInput, arbConfig, (input, config) => {
        const result = computeExtendedFeatures(input, config);

        for (const key of ALL_FEATURE_KEYS) {
          if (config[key] === false) {
            expect(result[key]).toBeUndefined();
          }
        }
      }),
      { numRuns: 200 },
    );
  });

  it("empty config (all disabled) produces empty output", () => {
    fc.assert(
      fc.property(arbInput, (input) => {
        const emptyConfig: ExtendedFeaturesConfig = {
          rolling_trend: false,
          atr_percentile: false,
          volatility_regime_score: false,
          session_statistics: false,
          correlated_markets: false,
          economic_calendar_summary: false,
          macro_state: false,
          sentiment_summary: false,
        };

        const result = computeExtendedFeatures(input, emptyConfig);

        // All keys should be undefined — result should be equivalent to {}
        for (const key of ALL_FEATURE_KEYS) {
          expect(result[key]).toBeUndefined();
        }
        expect(Object.keys(result)).toHaveLength(0);
      }),
      { numRuns: 100 },
    );
  });

  it("full config (all enabled) produces all features", () => {
    fc.assert(
      fc.property(arbInput, (input) => {
        const fullConfig: ExtendedFeaturesConfig = {
          rolling_trend: true,
          atr_percentile: true,
          volatility_regime_score: true,
          session_statistics: true,
          correlated_markets: true,
          economic_calendar_summary: true,
          macro_state: true,
          sentiment_summary: true,
        };

        const result = computeExtendedFeatures(input, fullConfig);

        // All 8 keys should be present (not undefined)
        for (const key of ALL_FEATURE_KEYS) {
          expect(result[key]).not.toBeUndefined();
        }
        expect(Object.keys(result)).toHaveLength(8);
      }),
      { numRuns: 100 },
    );
  });
});
