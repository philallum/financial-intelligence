/**
 * Shared fast-check arbitraries for the Financial Intelligence Platform.
 * Provides constrained generators for domain-specific data structures.
 */
import * as fc from 'fast-check';

// --- OHLC Generator ---

export interface OHLC {
  open: number;
  high: number;
  low: number;
  close: number;
}

/**
 * Generates valid OHLC candle data satisfying the invariant:
 * high >= max(open, close) and low <= min(open, close)
 */
export const arbOHLC: fc.Arbitrary<OHLC> = fc
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

// --- State Layer Generators ---

/**
 * Generates a normalized vector of specified length with values in [0, 1].
 */
function arbNormalizedVector(length: number): fc.Arbitrary<number[]> {
  return fc.array(
    fc.double({ min: 0, max: 1, noNaN: true, noDefaultInfinity: true }),
    { minLength: length, maxLength: length }
  );
}

/** L1: Market structure vector (16 dimensions, values in [0,1]) */
export const arbMarketStructure: fc.Arbitrary<number[]> = arbNormalizedVector(16);

/** L2: Volatility profile vector (12 dimensions, values in [0,1]) */
export const arbVolatilityProfile: fc.Arbitrary<number[]> = arbNormalizedVector(12);

/** L3: Liquidity field vector (20 dimensions, values in [0,1]) */
export const arbLiquidityField: fc.Arbitrary<number[]> = arbNormalizedVector(20);

/** L4: Macro context vector (8 dimensions, values in [0,1]) */
export const arbMacroContext: fc.Arbitrary<number[]> = arbNormalizedVector(8);

/** L5: Sentiment pressure vector (6 dimensions, values in [0,1]) */
export const arbSentimentPressure: fc.Arbitrary<number[]> = arbNormalizedVector(6);

/** All 5 state layers as a single record */
export interface StateLayers {
  market_structure: number[];
  volatility_profile: number[];
  liquidity_field: number[];
  macro_context: number[];
  sentiment_pressure: number[];
}

export const arbStateLayers: fc.Arbitrary<StateLayers> = fc.record({
  market_structure: arbMarketStructure,
  volatility_profile: arbVolatilityProfile,
  liquidity_field: arbLiquidityField,
  macro_context: arbMacroContext,
  sentiment_pressure: arbSentimentPressure,
});

// --- Similarity Score Generator ---

/**
 * Generates a similarity score in [0, 1] with 6 decimal places.
 */
export const arbSimilarityScore: fc.Arbitrary<number> = fc
  .integer({ min: 0, max: 1_000_000 })
  .map((n) => n / 1_000_000);

// --- Return in Pips Generator ---

/**
 * Generates return values in pips, typically -100 to +100.
 */
export const arbReturnPips: fc.Arbitrary<number> = fc.double({
  min: -100,
  max: 100,
  noNaN: true,
  noDefaultInfinity: true,
});

// --- Regime Generators ---

export const arbVolatilityRegime = fc.constantFrom('LOW', 'NORMAL', 'HIGH') as fc.Arbitrary<
  'LOW' | 'NORMAL' | 'HIGH'
>;

export const arbTrendRegime = fc.constantFrom('BULLISH', 'BEARISH', 'RANGING') as fc.Arbitrary<
  'BULLISH' | 'BEARISH' | 'RANGING'
>;

export const arbSession = fc.constantFrom('ASIA', 'LONDON', 'NY') as fc.Arbitrary<
  'ASIA' | 'LONDON' | 'NY'
>;

export interface Regime {
  volatility_regime: 'LOW' | 'NORMAL' | 'HIGH';
  trend_regime: 'BULLISH' | 'BEARISH' | 'RANGING';
  session: 'ASIA' | 'LONDON' | 'NY';
}

export const arbRegime: fc.Arbitrary<Regime> = fc.record({
  volatility_regime: arbVolatilityRegime,
  trend_regime: arbTrendRegime,
  session: arbSession,
});

// --- Fingerprint ID Generator ---

/**
 * Generates a deterministic-style UUID (v4 format).
 */
export const arbFingerprintId: fc.Arbitrary<string> = fc.uuid();

// --- Fingerprint Generator ---

export interface Fingerprint {
  fingerprint_id: string;
  asset: string;
  timeframe: string;
  timestamp_utc: string;
  market_state_version: string;
  ohlc: OHLC;
  return_profile: { net_return_pips: number; range_pips: number };
  regime: Regime;
  state_layers: StateLayers;
  session: 'ASIA' | 'LONDON' | 'NY';
}

export const arbFingerprint: fc.Arbitrary<Fingerprint> = fc.record({
  fingerprint_id: arbFingerprintId,
  asset: fc.constant('EURUSD'),
  timeframe: fc.constant('4H'),
  timestamp_utc: fc.integer({ min: new Date('2019-01-01').getTime(), max: new Date('2025-01-01').getTime() }).map((ts) => new Date(ts).toISOString()),
  market_state_version: fc.constant('1.0.0'),
  ohlc: arbOHLC,
  return_profile: fc.record({
    net_return_pips: arbReturnPips,
    range_pips: fc.double({ min: 0, max: 200, noNaN: true, noDefaultInfinity: true }),
  }),
  regime: arbRegime,
  state_layers: arbStateLayers,
  session: arbSession,
});
