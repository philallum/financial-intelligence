/**
 * Property-Based Test: Extended Feature Bounds and Defaults
 *
 * Property 16: Extended Feature Bounds and Defaults
 * - Generate random/missing inputs
 * - Verify all feature values in [0.0, 1.0] rounded to 6 decimal places
 * - Verify missing data → 0.5 default
 *
 * **Validates: Requirements 14.1, 14.3**
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
// Constants
// =============================================================================

/** All features enabled configuration. */
const ALL_ENABLED: ExtendedFeaturesConfig = {
  rolling_trend: true,
  atr_percentile: true,
  volatility_regime_score: true,
  session_statistics: true,
  correlated_markets: true,
  economic_calendar_summary: true,
  macro_state: true,
  sentiment_summary: true,
};

// =============================================================================
// Arbitraries
// =============================================================================

/**
 * Generates a valid OHLC candle with prices in a typical FX range (1.0000–1.5000).
 * Ensures high >= open, close, low and low <= open, close.
 */
const arbOHLC: fc.Arbitrary<OHLC> = fc
  .record({
    open: fc.double({ min: 1.0, max: 1.5, noNaN: true, noDefaultInfinity: true }),
    close: fc.double({ min: 1.0, max: 1.5, noNaN: true, noDefaultInfinity: true }),
    spread: fc.double({ min: 0.0001, max: 0.05, noNaN: true, noDefaultInfinity: true }),
  })
  .map(({ open, close, spread }) => {
    const high = Math.max(open, close) + spread;
    const low = Math.min(open, close) - spread * 0.5;
    return { open, high, low: Math.max(low, 0.5), close };
  });

/**
 * Generates an optional array of OHLC candles (0–60 candles).
 */
const arbHistoricalCandles: fc.Arbitrary<OHLC[] | undefined> = fc.option(
  fc.array(arbOHLC, { minLength: 0, maxLength: 60 }),
  { nil: undefined },
);

/**
 * Generates optional correlated markets data: 0–5 entries with values in [0, 1].
 */
const arbCorrelatedMarketsData: fc.Arbitrary<Record<string, number> | undefined> = fc.option(
  fc.dictionary(
    fc.constantFrom("EURUSD", "GBPUSD", "USDJPY", "AUDUSD", "USDCAD"),
    fc.double({ min: 0, max: 1, noNaN: true, noDefaultInfinity: true }),
    { minKeys: 0, maxKeys: 5 },
  ),
  { nil: undefined },
);

/**
 * Generates optional economic calendar data.
 */
const arbEconomicCalendarData: fc.Arbitrary<
  { high_impact_event: boolean; hours_to_next_event: number } | undefined
> = fc.option(
  fc.record({
    high_impact_event: fc.boolean(),
    hours_to_next_event: fc.double({ min: 0, max: 168, noNaN: true, noDefaultInfinity: true }),
  }),
  { nil: undefined },
);

/**
 * Generates optional MacroContext with typical value ranges.
 */
const arbMacroContext: fc.Arbitrary<MacroContext | undefined> = fc.option(
  fc.record({
    dxy: fc.option(fc.double({ min: 90, max: 110, noNaN: true, noDefaultInfinity: true }), { nil: null }),
    vix: fc.option(fc.double({ min: 10, max: 40, noNaN: true, noDefaultInfinity: true }), { nil: null }),
    spx: fc.option(fc.double({ min: 3000, max: 5500, noNaN: true, noDefaultInfinity: true }), { nil: null }),
    us10y: fc.option(fc.double({ min: 1, max: 5, noNaN: true, noDefaultInfinity: true }), { nil: null }),
    gold: fc.option(fc.double({ min: 1500, max: 2500, noNaN: true, noDefaultInfinity: true }), { nil: null }),
  }),
  { nil: undefined },
);

/**
 * Generates a random ISO-8601 UTC timestamp using integer milliseconds
 * to avoid invalid date issues during shrinking.
 */
const arbTimestampUtc: fc.Arbitrary<string> = fc
  .integer({
    min: new Date("2020-01-01T00:00:00Z").getTime(),
    max: new Date("2025-12-31T23:59:59Z").getTime(),
  })
  .map((ms) => new Date(ms).toISOString());

/**
 * Generates a complete ExtendedFeaturesInput with random/optional fields.
 */
const arbExtendedFeaturesInput: fc.Arbitrary<ExtendedFeaturesInput> = fc.record({
  historical_candles: arbHistoricalCandles,
  correlated_markets_data: arbCorrelatedMarketsData,
  economic_calendar_data: arbEconomicCalendarData,
  macro_context: arbMacroContext,
  timestamp_utc: arbTimestampUtc,
});

// =============================================================================
// Property Tests
// =============================================================================

describe("Property 16: Extended Feature Bounds and Defaults", () => {
  it("all scalar features are bounded [0, 1]", () => {
    fc.assert(
      fc.property(arbExtendedFeaturesInput, (input: ExtendedFeaturesInput) => {
        const result = computeExtendedFeatures(input, ALL_ENABLED);

        if (result.rolling_trend !== undefined) {
          expect(result.rolling_trend).toBeGreaterThanOrEqual(0.0);
          expect(result.rolling_trend).toBeLessThanOrEqual(1.0);
        }

        if (result.atr_percentile !== undefined) {
          expect(result.atr_percentile).toBeGreaterThanOrEqual(0.0);
          expect(result.atr_percentile).toBeLessThanOrEqual(1.0);
        }

        if (result.volatility_regime_score !== undefined) {
          expect(result.volatility_regime_score).toBeGreaterThanOrEqual(0.0);
          expect(result.volatility_regime_score).toBeLessThanOrEqual(1.0);
        }

        if (result.macro_state !== undefined) {
          expect(result.macro_state).toBeGreaterThanOrEqual(0.0);
          expect(result.macro_state).toBeLessThanOrEqual(1.0);
        }

        if (result.sentiment_summary !== undefined) {
          expect(result.sentiment_summary).toBeGreaterThanOrEqual(0.0);
          expect(result.sentiment_summary).toBeLessThanOrEqual(1.0);
        }
      }),
      { numRuns: 500 },
    );
  });

  it("all scalar features have ≤ 6 decimal places", () => {
    fc.assert(
      fc.property(arbExtendedFeaturesInput, (input: ExtendedFeaturesInput) => {
        const result = computeExtendedFeatures(input, ALL_ENABLED);

        const checkDecimalPlaces = (value: number | undefined) => {
          if (value === undefined) return;
          const decimalStr = value.toString().split(".")[1];
          if (decimalStr) {
            expect(decimalStr.length).toBeLessThanOrEqual(6);
          }
        };

        checkDecimalPlaces(result.rolling_trend);
        checkDecimalPlaces(result.atr_percentile);
        checkDecimalPlaces(result.volatility_regime_score);
        checkDecimalPlaces(result.macro_state);
        checkDecimalPlaces(result.sentiment_summary);
      }),
      { numRuns: 500 },
    );
  });

  it("correlated markets values are bounded [0, 1]", () => {
    fc.assert(
      fc.property(arbExtendedFeaturesInput, (input: ExtendedFeaturesInput) => {
        const result = computeExtendedFeatures(input, ALL_ENABLED);

        if (result.correlated_markets) {
          for (const [, value] of Object.entries(result.correlated_markets)) {
            expect(value).toBeGreaterThanOrEqual(0.0);
            expect(value).toBeLessThanOrEqual(1.0);
          }
        }
      }),
      { numRuns: 500 },
    );
  });

  it("session statistics avg_range is finite and non-negative", () => {
    fc.assert(
      fc.property(arbExtendedFeaturesInput, (input: ExtendedFeaturesInput) => {
        const result = computeExtendedFeatures(input, ALL_ENABLED);

        if (result.session_statistics) {
          for (const session of ["asia", "london", "ny"] as const) {
            const stats = result.session_statistics[session];
            expect(Number.isFinite(stats.avg_range)).toBe(true);
            expect(stats.avg_range).toBeGreaterThanOrEqual(0);
          }
        }
      }),
      { numRuns: 500 },
    );
  });

  it("missing data defaults to 0.5", () => {
    fc.assert(
      fc.property(arbTimestampUtc, (timestamp: string) => {
        // Input with no historical candles, no macro context, no correlated markets
        const emptyInput: ExtendedFeaturesInput = {
          timestamp_utc: timestamp,
        };

        const result = computeExtendedFeatures(emptyInput, ALL_ENABLED);

        // Scalar features that depend on missing data should default to 0.5
        expect(result.rolling_trend).toBe(0.5);
        expect(result.atr_percentile).toBe(0.5);
        expect(result.volatility_regime_score).toBe(0.5);
        expect(result.macro_state).toBe(0.5);
        expect(result.sentiment_summary).toBe(0.5);
      }),
      { numRuns: 100 },
    );
  });
});
