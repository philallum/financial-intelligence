/**
 * Unit Tests: Extended Feature Computation
 *
 * Tests the computeExtendedFeatures function from the fingerprint engine
 * with known inputs, neutral defaults, edge cases, and feature enablement.
 *
 * **Validates: Requirements 20.1, 20.4**
 */

import { describe, it, expect } from "vitest";
import { computeExtendedFeatures } from "../../src/engines/fingerprint-engine.js";
import type {
  ExtendedFeaturesInput,
  ExtendedFeaturesConfig,
  OHLC,
  MacroContext,
} from "../../src/types/index.js";

// =============================================================================
// Helpers
// =============================================================================

/** Create an OHLC candle with given close, and a fixed range. */
function makeCandle(close: number, range = 0.001): OHLC {
  return {
    open: close - range / 2,
    high: close + range / 2,
    low: close - range / 2,
    close,
  };
}

/** Create a series of uptrending candles. */
function makeUptrendCandles(count: number, startClose = 1.1, step = 0.001): OHLC[] {
  return Array.from({ length: count }, (_, i) => makeCandle(startClose + i * step));
}

/** Create a series of downtrending candles. */
function makeDowntrendCandles(count: number, startClose = 1.2, step = 0.001): OHLC[] {
  return Array.from({ length: count }, (_, i) => makeCandle(startClose - i * step));
}

/** All features enabled config. */
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

/** Default timestamp for tests (08:00 UTC = London session). */
const LONDON_TIMESTAMP = "2024-01-15T08:00:00Z";

// =============================================================================
// Test Suite 1: Individual Features with Known Inputs
// =============================================================================

describe("computeExtendedFeatures — individual features with known inputs", () => {
  it("rolling_trend: uptrending 50 candles → result > 0.5", () => {
    const candles = makeUptrendCandles(50);
    const input: ExtendedFeaturesInput = {
      historical_candles: candles,
      timestamp_utc: LONDON_TIMESTAMP,
    };
    const config: ExtendedFeaturesConfig = { rolling_trend: true };

    const result = computeExtendedFeatures(input, config);

    expect(result.rolling_trend).toBeDefined();
    expect(result.rolling_trend!).toBeGreaterThan(0.5);
    expect(result.rolling_trend!).toBeLessThanOrEqual(1.0);
  });

  it("rolling_trend: downtrending 50 candles → result < 0.5", () => {
    const candles = makeDowntrendCandles(50);
    const input: ExtendedFeaturesInput = {
      historical_candles: candles,
      timestamp_utc: LONDON_TIMESTAMP,
    };
    const config: ExtendedFeaturesConfig = { rolling_trend: true };

    const result = computeExtendedFeatures(input, config);

    expect(result.rolling_trend).toBeDefined();
    expect(result.rolling_trend!).toBeLessThan(0.5);
    expect(result.rolling_trend!).toBeGreaterThanOrEqual(0.0);
  });

  it("atr_percentile: last candle has largest range → result is 1.0", () => {
    // 9 candles with small range, last candle with largest range
    const smallRangeCandles: OHLC[] = Array.from({ length: 9 }, (_, i) => ({
      open: 1.1,
      high: 1.1 + 0.001, // range = 0.001
      low: 1.1 - 0.001,
      close: 1.1 + (i % 2 === 0 ? 0.0005 : -0.0005),
    }));
    const largestRangeCandle: OHLC = {
      open: 1.1,
      high: 1.1 + 0.01, // range = 0.02 (10x bigger)
      low: 1.1 - 0.01,
      close: 1.1,
    };
    const candles = [...smallRangeCandles, largestRangeCandle];

    const input: ExtendedFeaturesInput = {
      historical_candles: candles,
      timestamp_utc: LONDON_TIMESTAMP,
    };
    const config: ExtendedFeaturesConfig = { atr_percentile: true };

    const result = computeExtendedFeatures(input, config);

    expect(result.atr_percentile).toBeDefined();
    expect(result.atr_percentile!).toBe(1.0);
  });

  it("atr_percentile: last candle has smallest range → result is 0.0", () => {
    // 9 candles with large range, last candle with the smallest range
    const largeRangeCandles: OHLC[] = Array.from({ length: 9 }, () => ({
      open: 1.1,
      high: 1.1 + 0.01,
      low: 1.1 - 0.01,
      close: 1.1,
    }));
    const smallestRangeCandle: OHLC = {
      open: 1.1,
      high: 1.1 + 0.0001, // range = 0.0002 (much smaller)
      low: 1.1 - 0.0001,
      close: 1.1,
    };
    const candles = [...largeRangeCandles, smallestRangeCandle];

    const input: ExtendedFeaturesInput = {
      historical_candles: candles,
      timestamp_utc: LONDON_TIMESTAMP,
    };
    const config: ExtendedFeaturesConfig = { atr_percentile: true };

    const result = computeExtendedFeatures(input, config);

    expect(result.atr_percentile).toBeDefined();
    expect(result.atr_percentile!).toBe(0.0);
  });

  it("volatility_regime_score: last candle double the average range → result > 0.5", () => {
    // 9 candles with consistent range, then last candle with double the range
    const consistentCandles: OHLC[] = Array.from({ length: 9 }, () => ({
      open: 1.1,
      high: 1.1 + 0.005,
      low: 1.1 - 0.005,
      close: 1.1,
    }));
    const doubleRangeCandle: OHLC = {
      open: 1.1,
      high: 1.1 + 0.01, // double the range
      low: 1.1 - 0.01,
      close: 1.1,
    };
    const candles = [...consistentCandles, doubleRangeCandle];

    const input: ExtendedFeaturesInput = {
      historical_candles: candles,
      timestamp_utc: LONDON_TIMESTAMP,
    };
    const config: ExtendedFeaturesConfig = { volatility_regime_score: true };

    const result = computeExtendedFeatures(input, config);

    expect(result.volatility_regime_score).toBeDefined();
    expect(result.volatility_regime_score!).toBeGreaterThan(0.5);
  });

  it("session_statistics: candles at 08:00 UTC → London session gets counted", () => {
    // Single candle with timestamp at 08:00 UTC (London session: 04:00-12:00)
    const candles: OHLC[] = [makeCandle(1.1, 0.002)];
    const input: ExtendedFeaturesInput = {
      historical_candles: candles,
      timestamp_utc: "2024-01-15T08:00:00Z", // 08:00 UTC = London
    };
    const config: ExtendedFeaturesConfig = { session_statistics: true };

    const result = computeExtendedFeatures(input, config);

    expect(result.session_statistics).toBeDefined();
    expect(result.session_statistics!.london.count).toBeGreaterThanOrEqual(1);
  });

  it("correlated_markets: GBPUSD=0.8, USDJPY=0.3 → output contains both clamped and rounded", () => {
    const input: ExtendedFeaturesInput = {
      correlated_markets_data: { GBPUSD: 0.8, USDJPY: 0.3 },
      timestamp_utc: LONDON_TIMESTAMP,
    };
    const config: ExtendedFeaturesConfig = { correlated_markets: true };

    const result = computeExtendedFeatures(input, config);

    expect(result.correlated_markets).toBeDefined();
    expect(result.correlated_markets!["GBPUSD"]).toBe(0.8);
    expect(result.correlated_markets!["USDJPY"]).toBe(0.3);
  });

  it("economic_calendar_summary: passthrough of high_impact_event and hours_to_next_event", () => {
    const input: ExtendedFeaturesInput = {
      economic_calendar_data: { high_impact_event: true, hours_to_next_event: 2.5 },
      timestamp_utc: LONDON_TIMESTAMP,
    };
    const config: ExtendedFeaturesConfig = { economic_calendar_summary: true };

    const result = computeExtendedFeatures(input, config);

    expect(result.economic_calendar_summary).toBeDefined();
    expect(result.economic_calendar_summary!.high_impact_event).toBe(true);
    expect(result.economic_calendar_summary!.hours_to_next_event).toBe(2.5);
  });

  it("macro_state: known MacroContext → expected composite", () => {
    const macroContext: MacroContext = {
      dxy: 100,
      vix: 20,
      spx: 4000,
      us10y: 3,
      gold: 2000,
    };
    const input: ExtendedFeaturesInput = {
      macro_context: macroContext,
      timestamp_utc: LONDON_TIMESTAMP,
    };
    const config: ExtendedFeaturesConfig = { macro_state: true };

    const result = computeExtendedFeatures(input, config);

    expect(result.macro_state).toBeDefined();
    // Manual calculation:
    // dxyNorm = clamp((100-90)/20, 0, 1) = 0.5
    // vixNorm = clamp((20-10)/30, 0, 1) = 0.333...
    // spxNorm = clamp((4000-3000)/2500, 0, 1) = 0.4
    // us10yNorm = clamp((3-1)/4, 0, 1) = 0.5
    // goldNorm = clamp((2000-1500)/1000, 0, 1) = 0.5
    // composite = (0.5 + 0.333... + 0.4 + 0.5 + 0.5) / 5 = 2.2333.../5 = 0.446666...
    const expected = (0.5 + 10 / 30 + 0.4 + 0.5 + 0.5) / 5;
    expect(result.macro_state!).toBeCloseTo(expected, 5);
    expect(result.macro_state!).toBeGreaterThanOrEqual(0);
    expect(result.macro_state!).toBeLessThanOrEqual(1);
  });

  it("sentiment_summary: known MacroContext → deterministic composite", () => {
    const macroContext: MacroContext = {
      dxy: 100,
      vix: 20,
      spx: 4000,
      us10y: 3,
      gold: 2000,
    };
    const input: ExtendedFeaturesInput = {
      macro_context: macroContext,
      timestamp_utc: LONDON_TIMESTAMP,
    };
    const config: ExtendedFeaturesConfig = { sentiment_summary: true };

    const result = computeExtendedFeatures(input, config);

    expect(result.sentiment_summary).toBeDefined();
    // Manual calculation:
    // fearIndex = clamp((20-10)/30, 0, 1) = 0.333...
    // goldProxy = clamp((2000-1500)/1000, 0, 1) = 0.5
    // equityAppetite = clamp((4000-3000)/2500, 0, 1) = 0.4
    // bondStress = clamp((3-1)/4, 0, 1) = 0.5
    // composite = (0.333... + 0.5 + 0.5 + (1 - 0.4)) / 4 = (0.333... + 0.5 + 0.5 + 0.6) / 4 = 1.933.../4 = 0.4833...
    const fearIndex = 10 / 30;
    const goldProxy = 0.5;
    const equityAppetite = 0.4;
    const bondStress = 0.5;
    const expected = (fearIndex + goldProxy + bondStress + (1 - equityAppetite)) / 4;
    expect(result.sentiment_summary!).toBeCloseTo(expected, 5);
    expect(result.sentiment_summary!).toBeGreaterThanOrEqual(0);
    expect(result.sentiment_summary!).toBeLessThanOrEqual(1);
  });
});

// =============================================================================
// Test Suite 2: Neutral Defaults When Data Missing
// =============================================================================

describe("computeExtendedFeatures — neutral defaults when data missing", () => {
  it("empty input (no data) → all scalar features are 0.5", () => {
    const input: ExtendedFeaturesInput = {
      timestamp_utc: LONDON_TIMESTAMP,
    };
    const config: ExtendedFeaturesConfig = {
      rolling_trend: true,
      atr_percentile: true,
      volatility_regime_score: true,
      macro_state: true,
      sentiment_summary: true,
    };

    const result = computeExtendedFeatures(input, config);

    expect(result.rolling_trend).toBe(0.5);
    expect(result.atr_percentile).toBe(0.5);
    expect(result.volatility_regime_score).toBe(0.5);
    expect(result.macro_state).toBe(0.5);
    expect(result.sentiment_summary).toBe(0.5);
  });

  it("historical_candles: [] → rolling_trend is 0.5", () => {
    const input: ExtendedFeaturesInput = {
      historical_candles: [],
      timestamp_utc: LONDON_TIMESTAMP,
    };
    const config: ExtendedFeaturesConfig = { rolling_trend: true };

    const result = computeExtendedFeatures(input, config);

    expect(result.rolling_trend).toBe(0.5);
  });

  it("macro_context: undefined → macro_state is 0.5, sentiment_summary is 0.5", () => {
    const input: ExtendedFeaturesInput = {
      macro_context: undefined,
      timestamp_utc: LONDON_TIMESTAMP,
    };
    const config: ExtendedFeaturesConfig = {
      macro_state: true,
      sentiment_summary: true,
    };

    const result = computeExtendedFeatures(input, config);

    expect(result.macro_state).toBe(0.5);
    expect(result.sentiment_summary).toBe(0.5);
  });
});

// =============================================================================
// Test Suite 3: Rolling Trend with < 50 Candles
// =============================================================================

describe("computeExtendedFeatures — rolling_trend with < 50 candles", () => {
  it("5 uptrending candles → result > 0.5", () => {
    const candles = makeUptrendCandles(5);
    const input: ExtendedFeaturesInput = {
      historical_candles: candles,
      timestamp_utc: LONDON_TIMESTAMP,
    };
    const config: ExtendedFeaturesConfig = { rolling_trend: true };

    const result = computeExtendedFeatures(input, config);

    expect(result.rolling_trend).toBeDefined();
    expect(result.rolling_trend!).toBeGreaterThan(0.5);
  });

  it("1 candle → result computed (not neutral unless flat)", () => {
    // A single candle with close > open should give non-neutral (> 0.5)
    const candle: OHLC = {
      open: 1.1,
      high: 1.105,
      low: 1.095,
      close: 1.105, // close > open → upward bias
    };
    const input: ExtendedFeaturesInput = {
      historical_candles: [candle],
      timestamp_utc: LONDON_TIMESTAMP,
    };
    const config: ExtendedFeaturesConfig = { rolling_trend: true };

    const result = computeExtendedFeatures(input, config);

    expect(result.rolling_trend).toBeDefined();
    // close - open = 0.005, which is 50 pips → should push above 0.5
    expect(result.rolling_trend!).toBeGreaterThan(0.5);
  });

  it("0 candles → result is 0.5", () => {
    const input: ExtendedFeaturesInput = {
      historical_candles: [],
      timestamp_utc: LONDON_TIMESTAMP,
    };
    const config: ExtendedFeaturesConfig = { rolling_trend: true };

    const result = computeExtendedFeatures(input, config);

    expect(result.rolling_trend).toBe(0.5);
  });
});

// =============================================================================
// Test Suite 4: Feature Enablement/Disablement
// =============================================================================

describe("computeExtendedFeatures — feature enablement/disablement", () => {
  it("enable only rolling_trend → only rolling_trend key in result", () => {
    const candles = makeUptrendCandles(10);
    const input: ExtendedFeaturesInput = {
      historical_candles: candles,
      timestamp_utc: LONDON_TIMESTAMP,
    };
    const config: ExtendedFeaturesConfig = { rolling_trend: true };

    const result = computeExtendedFeatures(input, config);

    expect(Object.keys(result)).toEqual(["rolling_trend"]);
  });

  it("enable all → all 8 keys present", () => {
    const candles = makeUptrendCandles(10);
    const input: ExtendedFeaturesInput = {
      historical_candles: candles,
      correlated_markets_data: { GBPUSD: 0.7 },
      economic_calendar_data: { high_impact_event: false, hours_to_next_event: 5 },
      macro_context: { dxy: 100, vix: 20, spx: 4000, us10y: 3, gold: 2000 },
      timestamp_utc: LONDON_TIMESTAMP,
    };

    const result = computeExtendedFeatures(input, ALL_ENABLED);

    const keys = Object.keys(result);
    expect(keys).toContain("rolling_trend");
    expect(keys).toContain("atr_percentile");
    expect(keys).toContain("volatility_regime_score");
    expect(keys).toContain("session_statistics");
    expect(keys).toContain("correlated_markets");
    expect(keys).toContain("economic_calendar_summary");
    expect(keys).toContain("macro_state");
    expect(keys).toContain("sentiment_summary");
    expect(keys.length).toBe(8);
  });

  it("enable none → empty result {}", () => {
    const candles = makeUptrendCandles(10);
    const input: ExtendedFeaturesInput = {
      historical_candles: candles,
      timestamp_utc: LONDON_TIMESTAMP,
    };
    const config: ExtendedFeaturesConfig = {};

    const result = computeExtendedFeatures(input, config);

    expect(Object.keys(result).length).toBe(0);
  });
});

// =============================================================================
// Test Suite 5: Determinism
// =============================================================================

describe("computeExtendedFeatures — determinism", () => {
  it("same inputs produce bit-identical outputs", () => {
    const candles = makeUptrendCandles(20);
    const input: ExtendedFeaturesInput = {
      historical_candles: candles,
      correlated_markets_data: { GBPUSD: 0.75, EURUSD: 0.6 },
      economic_calendar_data: { high_impact_event: true, hours_to_next_event: 1.5 },
      macro_context: { dxy: 95, vix: 15, spx: 4500, us10y: 2.5, gold: 1800 },
      timestamp_utc: LONDON_TIMESTAMP,
    };

    const result1 = computeExtendedFeatures(input, ALL_ENABLED);
    const result2 = computeExtendedFeatures(input, ALL_ENABLED);

    expect(result1).toStrictEqual(result2);
  });
});
