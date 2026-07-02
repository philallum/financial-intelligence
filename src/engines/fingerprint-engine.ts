/**
 * Fingerprint Engine
 *
 * Transforms resampled OHLC and market context into a deterministic market state
 * fingerprint. The fingerprint is the canonical representation of a 4H market state.
 *
 * Key invariants:
 * - DETERMINISTIC: identical inputs produce bit-identical outputs
 * - fingerprint_id = SHA-256 hash of (asset + timestamp_utc)
 * - 5 state layers computed INDEPENDENTLY with no cross-layer leakage
 * - All vector values normalised to [0, 1]
 * - Immutable once created
 *
 * Requirements: 1.1, 1.2, 1.3, 1.4, 1.6
 */

import { createHash } from "node:crypto";
import type {
  FingerprintInput,
  Fingerprint,
  OHLC,
  MacroContext,
  RegimeClassification,
  ExtendedMarketFeatures,
  ExtendedFeaturesConfig,
  ExtendedFeaturesInput,
} from "../types/index.js";
import type { VolatilityRegime, TrendRegime, Session } from "../types/enums.js";

// =============================================================================
// Constants
// =============================================================================

const MARKET_STATE_VERSION = "1.1.0";
const QUANTILE_TABLE_VERSION = "v1_0";
const SCALING_METHOD = "fixed";
const TIMEFRAME = "4H";

/** 1 pip = 0.0001 for EUR/USD (and most major FX pairs) */
const PIP_DIVISOR = 0.0001;

/** Volatility regime thresholds (in pips based on range_pips) */
const VOLATILITY_LOW_THRESHOLD = 30;
const VOLATILITY_HIGH_THRESHOLD = 70;

/** Trend regime: ratio of |net_return| to range that classifies trending vs ranging */
const TREND_RATIO_THRESHOLD = 0.3;

/** State layer dimensions */
const L1_MARKET_STRUCTURE_DIM = 16;
const L2_VOLATILITY_PROFILE_DIM = 12;
const L3_LIQUIDITY_FIELD_DIM = 20;
const L4_MACRO_CONTEXT_DIM = 8;
const L5_SENTIMENT_PRESSURE_DIM = 6;

// =============================================================================
// Public API
// =============================================================================

/**
 * Generate a deterministic fingerprint from the given input.
 * This is a pure function — no side effects, no database access.
 */
export function generateFingerprint(input: FingerprintInput): Fingerprint {
  const { asset, timestamp_utc, ohlc, market_context } = input;

  // 1. Generate deterministic fingerprint_id
  const fingerprint_id = computeFingerprintId(asset, timestamp_utc);

  // 2. Compute return profile from OHLC
  const return_profile = computeReturnProfile(ohlc);

  // 3. Classify regime deterministically
  const regime = classifyRegime(return_profile, timestamp_utc);

  // 4. Compute 5 state layers independently (no cross-layer leakage)
  const state_layers = computeStateLayers(ohlc, return_profile, market_context);

  // 5. Assemble immutable fingerprint
  const fingerprint: Fingerprint = {
    fingerprint_id,
    asset,
    timeframe: TIMEFRAME,
    timestamp_utc,
    market_state_version: MARKET_STATE_VERSION,
    ohlc,
    return_profile,
    regime,
    state_layers,
    normalisation: {
      quantile_table_version: QUANTILE_TABLE_VERSION,
      scaling_method: SCALING_METHOD,
    },
  };

  return fingerprint;
}

/**
 * Store a fingerprint. Accepts a callback to decouple from database implementation.
 * The fingerprint is immutable — this function only stores, never modifies.
 */
export async function storeFingerprint(
  fingerprint: Fingerprint,
  storeFn: (fp: Fingerprint) => Promise<void>,
): Promise<void> {
  await storeFn(fingerprint);
}

// =============================================================================
// Deterministic ID Generation
// =============================================================================

/**
 * Compute fingerprint_id as SHA-256 hex hash of (asset + timestamp_utc).
 * Deterministic: same inputs always produce the same hash.
 */
export function computeFingerprintId(
  asset: string,
  timestamp_utc: string,
): string {
  const input = `${asset}:${timestamp_utc}`;
  return createHash("sha256").update(input).digest("hex");
}

// =============================================================================
// Return Profile Computation
// =============================================================================

/**
 * Compute return profile from OHLC data.
 * - net_return_pips = (close - open) in pips
 * - range_pips = (high - low) in pips
 */
export function computeReturnProfile(ohlc: OHLC): {
  net_return_pips: number;
  range_pips: number;
} {
  const net_return_pips = roundToPrecision(
    (ohlc.close - ohlc.open) / PIP_DIVISOR,
    2,
  );
  const range_pips = roundToPrecision(
    (ohlc.high - ohlc.low) / PIP_DIVISOR,
    2,
  );
  return { net_return_pips, range_pips };
}

// =============================================================================
// Regime Classification
// =============================================================================

/**
 * Classify the market regime deterministically from price/volatility inputs.
 * No learned classifications, no adaptive labels, no downstream influence.
 */
export function classifyRegime(
  return_profile: { net_return_pips: number; range_pips: number },
  timestamp_utc: string,
): RegimeClassification {
  return {
    volatility_regime: classifyVolatilityRegime(return_profile.range_pips),
    trend_regime: classifyTrendRegime(
      return_profile.net_return_pips,
      return_profile.range_pips,
    ),
    session: classifySession(timestamp_utc),
  };
}

/**
 * Volatility regime based on range_pips thresholds.
 * LOW: range < 30 pips
 * NORMAL: 30 <= range <= 70 pips
 * HIGH: range > 70 pips
 */
export function classifyVolatilityRegime(range_pips: number): VolatilityRegime {
  if (range_pips < VOLATILITY_LOW_THRESHOLD) return "LOW";
  if (range_pips > VOLATILITY_HIGH_THRESHOLD) return "HIGH";
  return "NORMAL";
}

/**
 * Trend regime based on net_return_pips vs range_pips ratio.
 * If the absolute net return is > 30% of the range, it's trending.
 * Direction determined by sign of net_return.
 * Otherwise it's ranging.
 */
export function classifyTrendRegime(
  net_return_pips: number,
  range_pips: number,
): TrendRegime {
  // Avoid division by zero
  if (range_pips === 0) return "RANGING";

  const ratio = Math.abs(net_return_pips) / range_pips;

  if (ratio > TREND_RATIO_THRESHOLD) {
    return net_return_pips > 0 ? "BULLISH" : "BEARISH";
  }
  return "RANGING";
}

/**
 * Session mapping from UTC timestamp.
 * ASIA:   20:00 - 04:00 UTC
 * LONDON: 04:00 - 12:00 UTC
 * NY:     12:00 - 20:00 UTC
 */
export function classifySession(timestamp_utc: string): Session {
  const date = new Date(timestamp_utc);
  const hour = date.getUTCHours();

  if (hour >= 4 && hour < 12) return "LONDON";
  if (hour >= 12 && hour < 20) return "NY";
  // hour >= 20 || hour < 4
  return "ASIA";
}

// =============================================================================
// State Layer Computation
// =============================================================================

/**
 * Compute all 5 state layers independently.
 * Each layer is computed from its own inputs — no cross-layer leakage.
 * All values normalised to [0, 1].
 */
export function computeStateLayers(
  ohlc: OHLC,
  return_profile: { net_return_pips: number; range_pips: number },
  market_context?: MacroContext,
): Fingerprint["state_layers"] {
  return {
    market_structure: computeL1MarketStructure(ohlc, return_profile),
    volatility_profile: computeL2VolatilityProfile(ohlc, return_profile),
    liquidity_field: computeL3LiquidityField(ohlc),
    macro_context: computeL4MacroContext(market_context),
    sentiment_pressure: computeL5SentimentPressure(market_context),
  };
}

/**
 * L1: Market Structure (16 dimensions)
 * Encodes price geometry, swing structure, trend strength.
 * Computed solely from OHLC and return profile.
 */
export function computeL1MarketStructure(
  ohlc: OHLC,
  return_profile: { net_return_pips: number; range_pips: number },
): number[] {
  const { open, high, low, close } = ohlc;
  const range = high - low;

  // Avoid division by zero
  const safeRange = range === 0 ? 1 : range;

  // Body position within range [0, 1]
  const bodyTop = Math.max(open, close);
  const bodyBottom = Math.min(open, close);
  const bodyMidpoint = (bodyTop + bodyBottom) / 2;
  const bodyPositionInRange = (bodyMidpoint - low) / safeRange;

  // Body size relative to range [0, 1]
  const bodySize = (bodyTop - bodyBottom) / safeRange;

  // Upper shadow ratio [0, 1]
  const upperShadow = (high - bodyTop) / safeRange;

  // Lower shadow ratio [0, 1]
  const lowerShadow = (bodyBottom - low) / safeRange;

  // Direction: 1 for bullish, 0 for bearish, 0.5 for doji
  const direction =
    close > open ? 1 : close < open ? 0 : 0.5;

  // Trend strength: |net_return| / range normalised (capped at 1)
  const trendStrength =
    return_profile.range_pips === 0
      ? 0
      : clamp(
          Math.abs(return_profile.net_return_pips) /
            return_profile.range_pips,
          0,
          1,
        );

  // Impulse ratio: body / range (how much of the range was directional)
  const impulseRatio = bodySize;

  // Rejection ratio: larger shadow / range
  const rejectionRatio = Math.max(upperShadow, lowerShadow);

  // Close position in range [0, 1]
  const closePosition = (close - low) / safeRange;

  // Open position in range [0, 1]
  const openPosition = (open - low) / safeRange;

  // High-Low symmetry: how centered is the body
  const symmetry = 1 - Math.abs(bodyPositionInRange - 0.5) * 2;

  // Net return normalised (sigmoid-like mapping to [0, 1])
  const netReturnNorm = sigmoid(return_profile.net_return_pips / 50);

  // Range normalised (using 100 pips as reference max)
  const rangeNorm = clamp(return_profile.range_pips / 100, 0, 1);

  // Momentum proxy: close vs midpoint of range
  const rangeMid = (high + low) / 2;
  const momentumProxy = (close - rangeMid) / safeRange * 0.5 + 0.5;

  // Volatility-adjusted direction
  const volAdjDirection = clamp(
    direction * trendStrength,
    0,
    1,
  );

  // Geometric complexity: shadow-to-body ratio
  const geometricComplexity =
    bodySize === 0 ? 0.5 : clamp((upperShadow + lowerShadow) / bodySize / 2, 0, 1);

  const vector = [
    bodyPositionInRange,  // 0
    bodySize,             // 1
    upperShadow,          // 2
    lowerShadow,          // 3
    direction,            // 4
    trendStrength,        // 5
    impulseRatio,         // 6
    rejectionRatio,       // 7
    closePosition,        // 8
    openPosition,         // 9
    symmetry,             // 10
    netReturnNorm,        // 11
    rangeNorm,            // 12
    momentumProxy,        // 13
    volAdjDirection,      // 14
    geometricComplexity,  // 15
  ];

  return vector.map((v) => clamp(roundToPrecision(v, 6), 0, 1));
}

/**
 * L2: Volatility Profile (12 dimensions)
 * Encodes movement intensity and dispersion.
 * Computed solely from OHLC and return profile.
 */
export function computeL2VolatilityProfile(
  ohlc: OHLC,
  return_profile: { net_return_pips: number; range_pips: number },
): number[] {
  const { open, high, low, close } = ohlc;
  const range = high - low;
  const safeRange = range === 0 ? 1 : range;

  // ATR proxy normalised (using 100 pips as reference)
  const atrProxy = clamp(return_profile.range_pips / 100, 0, 1);

  // Body-to-range ratio (efficiency)
  const bodyToRange = Math.abs(close - open) / safeRange;

  // Upper wick ratio
  const upperWick = (high - Math.max(open, close)) / safeRange;

  // Lower wick ratio
  const lowerWick = (Math.min(open, close) - low) / safeRange;

  // Expansion indicator: range > 50 pips normalised
  const expansionIndicator = clamp(return_profile.range_pips / 50, 0, 1);

  // Contraction indicator: inverse of expansion
  const contractionIndicator = 1 - expansionIndicator;

  // Speed proxy: |net_return| / range (directional efficiency)
  const speedProxy =
    return_profile.range_pips === 0
      ? 0
      : clamp(
          Math.abs(return_profile.net_return_pips) /
            return_profile.range_pips,
          0,
          1,
        );

  // Candle body size normalised (50 pips reference)
  const bodySizeNorm = clamp(
    (Math.abs(close - open) / PIP_DIVISOR) / 50,
    0,
    1,
  );

  // Range vs typical (30 pips typical)
  const rangeVsTypical = clamp(return_profile.range_pips / 30, 0, 1);

  // Volatility regime encoding
  const volRegimeScore =
    return_profile.range_pips < VOLATILITY_LOW_THRESHOLD
      ? 0
      : return_profile.range_pips > VOLATILITY_HIGH_THRESHOLD
        ? 1
        : (return_profile.range_pips - VOLATILITY_LOW_THRESHOLD) /
          (VOLATILITY_HIGH_THRESHOLD - VOLATILITY_LOW_THRESHOLD);

  // Wick symmetry: how balanced are the wicks
  const totalWick = upperWick + lowerWick;
  const wickSymmetry =
    totalWick === 0 ? 0.5 : 1 - Math.abs(upperWick - lowerWick) / totalWick;

  // Dispersion: 1 - bodyToRange (how much was wasted on wicks)
  const dispersion = 1 - bodyToRange;

  const vector = [
    atrProxy,             // 0
    bodyToRange,          // 1
    upperWick,            // 2
    lowerWick,            // 3
    expansionIndicator,   // 4
    contractionIndicator, // 5
    speedProxy,           // 6
    bodySizeNorm,         // 7
    rangeVsTypical,       // 8
    volRegimeScore,       // 9
    wickSymmetry,         // 10
    dispersion,           // 11
  ];

  return vector.map((v) => clamp(roundToPrecision(v, 6), 0, 1));
}

/**
 * L3: Liquidity Field (20 dimensions)
 * Fixed-length spatial representation of S/R pressure density.
 * Computed solely from OHLC (price-relative density field).
 */
export function computeL3LiquidityField(ohlc: OHLC): number[] {
  const { open, high, low, close } = ohlc;
  const range = high - low;
  const safeRange = range === 0 ? 1 : range;
  const mid = (high + low) / 2;

  // Generate a 20-bin spatial density field relative to current price
  // Each bin represents a price level zone from low to high
  const vector: number[] = [];

  for (let i = 0; i < L3_LIQUIDITY_FIELD_DIM; i++) {
    // Position within the range (0 to 1)
    const binPosition = i / (L3_LIQUIDITY_FIELD_DIM - 1);
    const priceLevel = low + binPosition * range;

    // Distance from key levels creates "density"
    const distFromOpen = 1 - Math.abs(priceLevel - open) / safeRange;
    const distFromClose = 1 - Math.abs(priceLevel - close) / safeRange;
    const distFromMid = 1 - Math.abs(priceLevel - mid) / safeRange;

    // Combine into a density score with deterministic weights
    const density = clamp(
      distFromOpen * 0.3 + distFromClose * 0.4 + distFromMid * 0.3,
      0,
      1,
    );

    vector.push(roundToPrecision(density, 6));
  }

  return vector;
}

/**
 * L4: Macro Context (8 dimensions)
 * Cross-asset alignment scores from macro data.
 * Computed solely from market_context (no dependency on L1-L3 or L5).
 */
export function computeL4MacroContext(
  market_context?: MacroContext,
): number[] {
  if (!market_context) {
    // No macro data available — return neutral vector
    return Array(L4_MACRO_CONTEXT_DIM).fill(0.5);
  }

  const { dxy, vix, spx, us10y, gold } = market_context;

  // Normalise each macro input to [0, 1] using fixed reference ranges
  // DXY: typically 90-110, normalise around 100
  const dxyNorm = dxy !== null ? clamp((dxy - 90) / 20, 0, 1) : 0.5;

  // VIX: typically 10-40, normalise
  const vixNorm = vix !== null ? clamp((vix - 10) / 30, 0, 1) : 0.5;

  // SPX: typically 3000-5500, normalise
  const spxNorm = spx !== null ? clamp((spx - 3000) / 2500, 0, 1) : 0.5;

  // US10Y: typically 1-5%, normalise
  const us10yNorm = us10y !== null ? clamp((us10y - 1) / 4, 0, 1) : 0.5;

  // Gold: typically 1500-2500, normalise
  const goldNorm = gold !== null ? clamp((gold - 1500) / 1000, 0, 1) : 0.5;

  // Derived: DXY-EUR inverse correlation proxy
  const dxyEurInverse = 1 - dxyNorm;

  // Derived: Risk-on proxy (high SPX + low VIX = risk on)
  const riskOnProxy = clamp((spxNorm + (1 - vixNorm)) / 2, 0, 1);

  // Derived: Yield-Gold divergence
  const yieldGoldDivergence = clamp(
    Math.abs(us10yNorm - goldNorm),
    0,
    1,
  );

  const vector = [
    dxyNorm,              // 0
    vixNorm,              // 1
    spxNorm,              // 2
    us10yNorm,            // 3
    goldNorm,             // 4
    dxyEurInverse,        // 5
    riskOnProxy,          // 6
    yieldGoldDivergence,  // 7
  ];

  return vector.map((v) => clamp(roundToPrecision(v, 6), 0, 1));
}

/**
 * L5: Sentiment Pressure (6 dimensions)
 * Event/news pressure proxies.
 * Computed solely from market_context (no dependency on L1-L4).
 */
export function computeL5SentimentPressure(
  market_context?: MacroContext,
): number[] {
  if (!market_context) {
    // No sentiment data available — return neutral vector
    return Array(L5_SENTIMENT_PRESSURE_DIM).fill(0.5);
  }

  const { vix, dxy, spx, gold, us10y } = market_context;

  // VIX-based fear index normalised [0, 1]
  const fearIndex = vix !== null ? clamp((vix - 10) / 30, 0, 1) : 0.5;

  // Risk aversion: VIX high + Gold high = risk averse
  const goldProxy = gold !== null ? clamp((gold - 1500) / 1000, 0, 1) : 0.5;
  const riskAversion = clamp((fearIndex + goldProxy) / 2, 0, 1);

  // Dollar strength sentiment: strong DXY = bearish EUR sentiment
  const dxySentiment = dxy !== null ? clamp((dxy - 90) / 20, 0, 1) : 0.5;

  // Equity risk appetite: SPX strength = risk-on sentiment
  const equityRiskAppetite = spx !== null ? clamp((spx - 3000) / 2500, 0, 1) : 0.5;

  // Bond market stress: high yields = tightening pressure
  const bondStress = us10y !== null ? clamp((us10y - 1) / 4, 0, 1) : 0.5;

  // Composite sentiment: average of all signals
  const compositeSentiment = clamp(
    (fearIndex + riskAversion + dxySentiment + equityRiskAppetite + bondStress) / 5,
    0,
    1,
  );

  const vector = [
    fearIndex,          // 0
    riskAversion,       // 1
    dxySentiment,       // 2
    equityRiskAppetite, // 3
    bondStress,         // 4
    compositeSentiment, // 5
  ];

  return vector.map((v) => clamp(roundToPrecision(v, 6), 0, 1));
}

// =============================================================================
// Extended Market Features (Phase 7 — Rich Market Context)
// =============================================================================

/**
 * Neutral default value for scalar extended features when data is missing.
 * Requirement 14.3: Missing data → substitute 0.5 (neutral default).
 */
const NEUTRAL_DEFAULT = 0.5;

/**
 * Maximum candle lookback for rolling_trend computation.
 * Requirement 14.1, 14.4: from 50 most recent candles.
 */
const ROLLING_TREND_MAX_CANDLES = 50;

/**
 * Compute extended market features based on the provided input and config.
 *
 * This is a pure, deterministic function — no side effects, no randomness.
 * Each feature is independently enableable via the config parameter.
 * Missing data defaults to 0.5 (neutral). All values rounded to 6 decimal places.
 *
 * Requirements: 14.1, 14.2, 14.3, 14.4, 14.5, 14.6, 14.7
 *
 * @param input - The data needed to compute extended features
 * @param config - Which features to compute (true = enabled)
 * @returns ExtendedMarketFeatures with only the enabled features populated
 */
export function computeExtendedFeatures(
  input: ExtendedFeaturesInput,
  config: ExtendedFeaturesConfig,
): ExtendedMarketFeatures {
  const result: ExtendedMarketFeatures = {};

  if (config.rolling_trend) {
    result.rolling_trend = computeRollingTrend(input.historical_candles);
  }

  if (config.atr_percentile) {
    result.atr_percentile = computeAtrPercentile(input.historical_candles);
  }

  if (config.volatility_regime_score) {
    result.volatility_regime_score = computeVolatilityRegimeScore(input.historical_candles);
  }

  if (config.session_statistics) {
    result.session_statistics = computeSessionStatistics(input.historical_candles, input.timestamp_utc);
  }

  if (config.correlated_markets) {
    result.correlated_markets = computeCorrelatedMarkets(input.correlated_markets_data);
  }

  if (config.economic_calendar_summary) {
    result.economic_calendar_summary = computeEconomicCalendarSummary(input.economic_calendar_data);
  }

  if (config.macro_state) {
    result.macro_state = computeMacroState(input.macro_context);
  }

  if (config.sentiment_summary) {
    result.sentiment_summary = computeSentimentSummary(input.macro_context);
  }

  return result;
}

/**
 * Compute rolling_trend from historical candles.
 * Normalised to [0, 1]: 0 = strong downtrend, 0.5 = flat, 1 = strong uptrend.
 * Uses up to 50 candles; if fewer are available, computes with available candles.
 *
 * Requirement 14.4: If fewer than 50 candles, compute with available, record count.
 */
function computeRollingTrend(candles?: OHLC[]): number {
  if (!candles || candles.length === 0) {
    return NEUTRAL_DEFAULT;
  }

  // Use up to ROLLING_TREND_MAX_CANDLES most recent candles
  const relevantCandles = candles.slice(-ROLLING_TREND_MAX_CANDLES);
  const n = relevantCandles.length;

  if (n === 1) {
    // With only one candle, determine trend from close vs open
    const singleReturn = relevantCandles[0].close - relevantCandles[0].open;
    // Normalise: use sigmoid-like mapping, capped reference of 50 pips
    const pips = singleReturn / PIP_DIVISOR;
    return roundToPrecision(clamp(sigmoid(pips / 25), 0, 1), 6);
  }

  // Compute linear regression slope over close prices using least squares
  // x = 0, 1, 2, ..., n-1 (candle index)
  // y = close prices
  let sumX = 0;
  let sumY = 0;
  let sumXY = 0;
  let sumX2 = 0;

  for (let i = 0; i < n; i++) {
    const y = relevantCandles[i].close;
    sumX += i;
    sumY += y;
    sumXY += i * y;
    sumX2 += i * i;
  }

  const denominator = n * sumX2 - sumX * sumX;
  if (denominator === 0) {
    return NEUTRAL_DEFAULT;
  }

  const slope = (n * sumXY - sumX * sumY) / denominator;

  // Normalise slope to [0, 1] using sigmoid
  // Scale by pip reference: a slope of 0.0001 per candle ≈ 1 pip per candle
  const slopeInPips = slope / PIP_DIVISOR;
  // Use sigmoid mapping: +/-5 pips/candle maps to near 0 or 1
  const normalised = sigmoid(slopeInPips / 2.5);

  return roundToPrecision(clamp(normalised, 0, 1), 6);
}

/**
 * Compute ATR percentile from historical candles.
 * The current candle's range is ranked relative to historical ranges.
 * Normalised to [0, 1]: 0 = lowest range in history, 1 = highest.
 *
 * Requirement 14.1: atr_percentile normalised to [0.0, 1.0].
 */
function computeAtrPercentile(candles?: OHLC[]): number {
  if (!candles || candles.length === 0) {
    return NEUTRAL_DEFAULT;
  }

  const relevantCandles = candles.slice(-ROLLING_TREND_MAX_CANDLES);
  const n = relevantCandles.length;

  if (n === 1) {
    // With only one candle, no percentile context — return neutral
    return NEUTRAL_DEFAULT;
  }

  // Current candle is the last one
  const currentRange = relevantCandles[n - 1].high - relevantCandles[n - 1].low;

  // Compute all ranges
  const ranges: number[] = [];
  for (let i = 0; i < n; i++) {
    ranges.push(relevantCandles[i].high - relevantCandles[i].low);
  }

  // Sort ranges ascending for percentile ranking
  const sortedRanges = [...ranges].sort((a, b) => a - b);

  // Count how many ranges are strictly less than current
  let countBelow = 0;
  for (let i = 0; i < sortedRanges.length; i++) {
    if (sortedRanges[i] < currentRange) {
      countBelow++;
    }
  }

  // Percentile = count_below / (n - 1) to normalise to [0, 1]
  const percentile = n > 1 ? countBelow / (n - 1) : NEUTRAL_DEFAULT;

  return roundToPrecision(clamp(percentile, 0, 1), 6);
}

/**
 * Compute volatility regime score from historical candles.
 * Normalised [0, 1]: 0 = very low volatility, 1 = very high volatility.
 * Based on current ATR relative to a rolling window.
 *
 * Requirement 14.1: volatility_regime_score normalised to [0.0, 1.0].
 */
function computeVolatilityRegimeScore(candles?: OHLC[]): number {
  if (!candles || candles.length === 0) {
    return NEUTRAL_DEFAULT;
  }

  const relevantCandles = candles.slice(-ROLLING_TREND_MAX_CANDLES);
  const n = relevantCandles.length;

  // Compute average true range of all candles in the window
  let totalRange = 0;
  for (let i = 0; i < n; i++) {
    totalRange += relevantCandles[i].high - relevantCandles[i].low;
  }
  const avgRange = totalRange / n;

  // Current candle's range
  const currentRange = relevantCandles[n - 1].high - relevantCandles[n - 1].low;

  if (avgRange === 0) {
    return NEUTRAL_DEFAULT;
  }

  // Ratio of current range to average range
  // A ratio of 1.0 = normal, >2 = high, <0.5 = low
  const ratio = currentRange / avgRange;

  // Normalise using sigmoid: ratio of 1 → 0.5, ratio of 2 → ~0.73, ratio of 0.5 → ~0.27
  const normalised = sigmoid((ratio - 1) * 2);

  return roundToPrecision(clamp(normalised, 0, 1), 6);
}

/**
 * Compute session statistics: count and average range per trading session.
 * Sessions: ASIA (20:00-04:00 UTC), LONDON (04:00-12:00 UTC), NY (12:00-20:00 UTC).
 *
 * Requirement 14.1: session_statistics (candle count and average range per session).
 */
function computeSessionStatistics(
  candles?: OHLC[],
  timestamp_utc?: string,
): ExtendedMarketFeatures["session_statistics"] {
  const defaultStats = {
    asia: { count: 0, avg_range: roundToPrecision(NEUTRAL_DEFAULT, 6) },
    london: { count: 0, avg_range: roundToPrecision(NEUTRAL_DEFAULT, 6) },
    ny: { count: 0, avg_range: roundToPrecision(NEUTRAL_DEFAULT, 6) },
  };

  if (!candles || candles.length === 0 || !timestamp_utc) {
    return defaultStats;
  }

  const relevantCandles = candles.slice(-ROLLING_TREND_MAX_CANDLES);
  const n = relevantCandles.length;

  // We need timestamps for session classification. Since we only have OHLC data,
  // we infer session assignment by distributing candles backwards from the timestamp_utc
  // at 4H intervals (deterministic reconstruction).
  const baseDate = new Date(timestamp_utc);
  const sessions: { asia: number[]; london: number[]; ny: number[] } = {
    asia: [],
    london: [],
    ny: [],
  };

  for (let i = 0; i < n; i++) {
    // Compute timestamp for candle at position i (i=n-1 is the most recent / current)
    const offsetMs = (n - 1 - i) * 4 * 60 * 60 * 1000;
    const candleTime = new Date(baseDate.getTime() - offsetMs);
    const hour = candleTime.getUTCHours();

    const range = relevantCandles[i].high - relevantCandles[i].low;
    const rangePips = range / PIP_DIVISOR;

    if (hour >= 4 && hour < 12) {
      sessions.london.push(rangePips);
    } else if (hour >= 12 && hour < 20) {
      sessions.ny.push(rangePips);
    } else {
      sessions.asia.push(rangePips);
    }
  }

  const computeAvg = (arr: number[]): number => {
    if (arr.length === 0) return NEUTRAL_DEFAULT;
    const sum = arr.reduce((a, b) => a + b, 0);
    return sum / arr.length;
  };

  return {
    asia: {
      count: sessions.asia.length,
      avg_range: roundToPrecision(computeAvg(sessions.asia), 6),
    },
    london: {
      count: sessions.london.length,
      avg_range: roundToPrecision(computeAvg(sessions.london), 6),
    },
    ny: {
      count: sessions.ny.length,
      avg_range: roundToPrecision(computeAvg(sessions.ny), 6),
    },
  };
}

/**
 * Compute correlated markets alignment scores.
 * If data is missing, each instrument receives the neutral default (0.5).
 *
 * Requirement 14.1: correlated_markets (alignment scores for up to 5 instruments, each [0, 1]).
 * Requirement 14.3: Missing data → substitute 0.5.
 */
function computeCorrelatedMarkets(
  data?: Record<string, number>,
): Record<string, number> {
  if (!data || Object.keys(data).length === 0) {
    return {};
  }

  const result: Record<string, number> = {};

  // Process up to 5 correlated instruments, sorted by key for determinism
  const sortedKeys = Object.keys(data).sort().slice(0, 5);

  for (const key of sortedKeys) {
    const value = data[key];
    if (value === null || value === undefined || isNaN(value)) {
      result[key] = NEUTRAL_DEFAULT;
    } else {
      result[key] = roundToPrecision(clamp(value, 0, 1), 6);
    }
  }

  return result;
}

/**
 * Compute economic calendar summary.
 * If data is missing, returns neutral defaults.
 *
 * Requirement 14.1: economic_calendar_summary (binary high-impact event flag, hours-to-next-event).
 * Requirement 14.3: Missing data → substitute neutral.
 */
function computeEconomicCalendarSummary(
  data?: { high_impact_event: boolean; hours_to_next_event: number },
): ExtendedMarketFeatures["economic_calendar_summary"] {
  if (!data) {
    return {
      high_impact_event: false,
      hours_to_next_event: roundToPrecision(24, 6),
    };
  }

  return {
    high_impact_event: data.high_impact_event,
    hours_to_next_event: roundToPrecision(Math.max(0, data.hours_to_next_event), 6),
  };
}

/**
 * Compute composite macro state from macro context.
 * Normalised [0, 1]: composite of all available macro indicators.
 *
 * Requirement 14.1: macro_state (composite of MacroContext fields normalised to [0, 1]).
 * Requirement 14.3: Missing data → 0.5.
 */
function computeMacroState(macroContext?: MacroContext): number {
  if (!macroContext) {
    return NEUTRAL_DEFAULT;
  }

  const { dxy, vix, spx, us10y, gold } = macroContext;

  // Normalise each field using the same fixed ranges as L4
  const dxyNorm = dxy !== null ? clamp((dxy - 90) / 20, 0, 1) : NEUTRAL_DEFAULT;
  const vixNorm = vix !== null ? clamp((vix - 10) / 30, 0, 1) : NEUTRAL_DEFAULT;
  const spxNorm = spx !== null ? clamp((spx - 3000) / 2500, 0, 1) : NEUTRAL_DEFAULT;
  const us10yNorm = us10y !== null ? clamp((us10y - 1) / 4, 0, 1) : NEUTRAL_DEFAULT;
  const goldNorm = gold !== null ? clamp((gold - 1500) / 1000, 0, 1) : NEUTRAL_DEFAULT;

  // Composite: equal-weighted average of all normalised macro indicators
  const composite = (dxyNorm + vixNorm + spxNorm + us10yNorm + goldNorm) / 5;

  return roundToPrecision(clamp(composite, 0, 1), 6);
}

/**
 * Compute composite sentiment summary from macro context.
 * Normalised [0, 1]: composite sentiment derived from VIX, gold, SPX signals.
 *
 * Requirement 14.1: sentiment_summary (composite sentiment score normalised to [0, 1]).
 * Requirement 14.3: Missing data → 0.5.
 */
function computeSentimentSummary(macroContext?: MacroContext): number {
  if (!macroContext) {
    return NEUTRAL_DEFAULT;
  }

  const { vix, gold, spx, us10y } = macroContext;

  // Fear index from VIX
  const fearIndex = vix !== null ? clamp((vix - 10) / 30, 0, 1) : NEUTRAL_DEFAULT;
  // Gold as safe haven proxy
  const goldProxy = gold !== null ? clamp((gold - 1500) / 1000, 0, 1) : NEUTRAL_DEFAULT;
  // Equity risk appetite from SPX
  const equityAppetite = spx !== null ? clamp((spx - 3000) / 2500, 0, 1) : NEUTRAL_DEFAULT;
  // Bond stress from yields
  const bondStress = us10y !== null ? clamp((us10y - 1) / 4, 0, 1) : NEUTRAL_DEFAULT;

  // Composite: risk-off signals (fear, gold safe haven, bond stress) vs risk-on (equity)
  // Higher value = more risk-off sentiment
  const composite = (fearIndex + goldProxy + bondStress + (1 - equityAppetite)) / 4;

  return roundToPrecision(clamp(composite, 0, 1), 6);
}

// =============================================================================
// Utility Functions
// =============================================================================

/** Clamp a value between min and max. */
function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

/** Sigmoid function mapping any real number to (0, 1). */
function sigmoid(x: number): number {
  return 1 / (1 + Math.exp(-x));
}

/** Round to a fixed number of decimal places for deterministic output. */
function roundToPrecision(value: number, decimals: number): number {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}
