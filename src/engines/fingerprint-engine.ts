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
} from "../types/index.js";
import type { VolatilityRegime, TrendRegime, Session } from "../types/enums.js";

// =============================================================================
// Constants
// =============================================================================

const MARKET_STATE_VERSION = "1.0.0";
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
