/**
 * Regime Engine v2
 *
 * Deterministic rule-based market regime classification using fingerprint
 * state_layers and extended_state features from Phase 7.
 *
 * Key invariants:
 * - DETERMINISTIC: identical state_layers + extended_state = bit-identical output
 * - No ML, no neural networks, no black-box classifiers
 * - 9 regime types: trend, ranging, expansion, contraction, macro_driven,
 *   breakout, reversal, accumulation, distribution
 * - Exactly one primary_regime, up to 2 secondary_regimes with relevance_score [0, 1]
 * - Structured explanation for every classification decision
 * - Handles neutral defaults gracefully (0.5 = missing data)
 * - Both v1 and v2 persist concurrently until v1 deactivated
 *
 * Requirements: 15.1, 15.2, 15.3, 15.4, 15.5, 15.6, 15.7
 */

import type { Fingerprint } from "../types/index.js";

// =============================================================================
// Constants
// =============================================================================

/** Engine version identifier for regime engine v2. */
export const ENGINE_VERSION = "2.0.0";

/** Neutral default value indicating missing/unavailable data. */
const NEUTRAL_DEFAULT = 0.5;

/** Tolerance for detecting neutral default values. */
const NEUTRAL_TOLERANCE = 1e-9;

/** Maximum number of secondary regimes. */
const MAX_SECONDARY_REGIMES = 2;

/** The 9 valid regime types. */
export const VALID_REGIME_TYPES = [
  "trend",
  "ranging",
  "expansion",
  "contraction",
  "macro_driven",
  "breakout",
  "reversal",
  "accumulation",
  "distribution",
] as const;

export type RegimeType = (typeof VALID_REGIME_TYPES)[number];

// =============================================================================
// Thresholds for Rule-Based Classification
// =============================================================================

/** Trend regime: strong directional movement. */
const TREND_STRENGTH_THRESHOLD = 0.55;
const TREND_IMPULSE_THRESHOLD = 0.5;

/** Ranging regime: low directional movement, narrow range. */
const RANGING_STRENGTH_CEILING = 0.35;
const RANGING_EXPANSION_CEILING = 0.4;

/** Expansion regime: high volatility / range expansion. */
const EXPANSION_INDICATOR_THRESHOLD = 0.65;
const EXPANSION_ATR_THRESHOLD = 0.6;

/** Contraction regime: low volatility / range compression. */
const CONTRACTION_INDICATOR_THRESHOLD = 0.65;
const CONTRACTION_ATR_CEILING = 0.35;

/** Macro-driven regime: macro context dominates price action. */
const MACRO_STATE_DEVIATION_THRESHOLD = 0.3;
const MACRO_CONTEXT_DEVIATION_THRESHOLD = 0.3;

/** Breakout regime: strong impulse out of compression. */
const BREAKOUT_IMPULSE_THRESHOLD = 0.6;
const BREAKOUT_SPEED_THRESHOLD = 0.6;
const BREAKOUT_EXPANSION_THRESHOLD = 0.55;

/** Reversal regime: direction contradiction with prior trend. */
const REVERSAL_REJECTION_THRESHOLD = 0.5;
const REVERSAL_DIRECTION_SHIFT_THRESHOLD = 0.3;

/** Accumulation regime: low volatility with subtle bullish bias. */
const ACCUMULATION_CONTRACTION_THRESHOLD = 0.5;
const ACCUMULATION_CLOSE_POSITION_THRESHOLD = 0.55;

/** Distribution regime: low volatility with subtle bearish bias. */
const DISTRIBUTION_CONTRACTION_THRESHOLD = 0.5;
const DISTRIBUTION_CLOSE_POSITION_CEILING = 0.45;

// =============================================================================
// Public Interfaces
// =============================================================================

/** Output from the Regime Engine v2. */
export interface RegimeV2Output {
  /** One of 9 regime types — the strongest classification. */
  primary_regime: RegimeType;
  /** Up to 2 secondary regimes with relevance scores in [0, 1]. */
  secondary_regimes: Array<{
    regime: RegimeType;
    relevance_score: number;
  }>;
  /** Structured explanation of classification decision. */
  explanation: {
    rules_fired: string[];
    features_evaluated: Record<string, number>;
    threshold_conditions: Record<string, {
      threshold: number;
      actual: number;
      passed: boolean;
    }>;
    unavailable_features: string[];
  };
  /** Engine version identifier. */
  engine_version: string;
}

/** Input structure for regime classification. */
export interface RegimeV2Input {
  state_layers: Fingerprint["state_layers"];
  extended_state?: Fingerprint["extended_state"];
}

// =============================================================================
// Internal Types
// =============================================================================

/** A scored regime from rule evaluation. */
interface ScoredRegime {
  regime: RegimeType;
  score: number;
  rules_fired: string[];
}

/** Extracted features from state_layers and extended_state. */
interface ExtractedFeatures {
  // L1: Market Structure
  direction: number;
  trendStrength: number;
  impulseRatio: number;
  rangeNorm: number;
  closePosition: number;
  rejectionRatio: number;

  // L2: Volatility Profile
  atrProxy: number;
  expansionIndicator: number;
  contractionIndicator: number;
  speedProxy: number;
  volRegimeScore: number;

  // Extended features (from Phase 7)
  rollingTrend: number;
  atrPercentile: number;
  volatilityRegimeScore: number;
  macroState: number;
  sentimentSummary: number;
}

// =============================================================================
// Public API
// =============================================================================

/**
 * Classify regime using deterministic rules over state_layers and extended_state.
 * This is a pure function — no side effects, no randomness, no external state.
 *
 * @param input - State layers and optional extended state from fingerprint
 * @returns RegimeV2Output with primary regime, secondary regimes, and explanation
 */
export function classifyRegimeV2(input: RegimeV2Input): RegimeV2Output {
  const { state_layers, extended_state } = input;

  // 1. Extract features from state_layers and extended_state
  const { features, unavailableFeatures, featuresEvaluated } =
    extractFeatures(state_layers, extended_state);

  // 2. Evaluate all regime rules and collect scores
  const thresholdConditions: Record<string, {
    threshold: number;
    actual: number;
    passed: boolean;
  }> = {};

  const scoredRegimes = evaluateAllRules(features, thresholdConditions);

  // 3. Sort by score descending (deterministic tie-break by regime name)
  scoredRegimes.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return a.regime.localeCompare(b.regime);
  });

  // 4. Primary regime is the highest scoring
  const primary = scoredRegimes[0];

  // 5. Secondary regimes: up to 2 others with score > 0
  const secondaries = scoredRegimes
    .slice(1)
    .filter((r) => r.score > 0)
    .slice(0, MAX_SECONDARY_REGIMES)
    .map((r) => ({
      regime: r.regime,
      relevance_score: roundTo6(clamp(r.score / (primary.score || 1), 0, 1)),
    }));

  // 6. Collect all rules that fired across all regimes
  const allRulesFired = scoredRegimes
    .filter((r) => r.score > 0)
    .flatMap((r) => r.rules_fired);

  // 7. Build the output
  return {
    primary_regime: primary.regime,
    secondary_regimes: secondaries,
    explanation: {
      rules_fired: allRulesFired,
      features_evaluated: featuresEvaluated,
      threshold_conditions: thresholdConditions,
      unavailable_features: unavailableFeatures,
    },
    engine_version: ENGINE_VERSION,
  };
}

/**
 * Get the engine version for regime engine v2.
 */
export function getEngineVersion(): string {
  return ENGINE_VERSION;
}

// =============================================================================
// Feature Extraction
// =============================================================================

/**
 * Extract features from state_layers and extended_state.
 * Detects neutral defaults (0.5) in extended features and marks them unavailable.
 */
function extractFeatures(
  stateLayers: Fingerprint["state_layers"],
  extendedState?: Fingerprint["extended_state"],
): {
  features: ExtractedFeatures;
  unavailableFeatures: string[];
  featuresEvaluated: Record<string, number>;
} {
  const unavailableFeatures: string[] = [];
  const featuresEvaluated: Record<string, number> = {};

  // --- L1: Market Structure (indices from fingerprint-engine.ts) ---
  const direction = stateLayers.market_structure[4] ?? NEUTRAL_DEFAULT;
  const trendStrength = stateLayers.market_structure[5] ?? NEUTRAL_DEFAULT;
  const impulseRatio = stateLayers.market_structure[6] ?? NEUTRAL_DEFAULT;
  const rangeNorm = stateLayers.market_structure[12] ?? NEUTRAL_DEFAULT;
  const closePosition = stateLayers.market_structure[8] ?? NEUTRAL_DEFAULT;
  const rejectionRatio = stateLayers.market_structure[7] ?? NEUTRAL_DEFAULT;

  featuresEvaluated["l1_direction"] = direction;
  featuresEvaluated["l1_trendStrength"] = trendStrength;
  featuresEvaluated["l1_impulseRatio"] = impulseRatio;
  featuresEvaluated["l1_rangeNorm"] = rangeNorm;
  featuresEvaluated["l1_closePosition"] = closePosition;
  featuresEvaluated["l1_rejectionRatio"] = rejectionRatio;

  // --- L2: Volatility Profile (indices from fingerprint-engine.ts) ---
  const atrProxy = stateLayers.volatility_profile[0] ?? NEUTRAL_DEFAULT;
  const expansionIndicator = stateLayers.volatility_profile[4] ?? NEUTRAL_DEFAULT;
  const contractionIndicator = stateLayers.volatility_profile[5] ?? NEUTRAL_DEFAULT;
  const speedProxy = stateLayers.volatility_profile[6] ?? NEUTRAL_DEFAULT;
  const volRegimeScore = stateLayers.volatility_profile[9] ?? NEUTRAL_DEFAULT;

  featuresEvaluated["l2_atrProxy"] = atrProxy;
  featuresEvaluated["l2_expansionIndicator"] = expansionIndicator;
  featuresEvaluated["l2_contractionIndicator"] = contractionIndicator;
  featuresEvaluated["l2_speedProxy"] = speedProxy;
  featuresEvaluated["l2_volRegimeScore"] = volRegimeScore;

  // --- Extended features from Phase 7 ---
  const extFeatures = extendedState?.extended_market_features;

  const rollingTrend = extractExtendedFeature(
    extFeatures?.rolling_trend, "ext_rollingTrend",
    featuresEvaluated, unavailableFeatures,
  );
  const atrPercentile = extractExtendedFeature(
    extFeatures?.atr_percentile, "ext_atrPercentile",
    featuresEvaluated, unavailableFeatures,
  );
  const volatilityRegimeScore = extractExtendedFeature(
    extFeatures?.volatility_regime_score, "ext_volatilityRegimeScore",
    featuresEvaluated, unavailableFeatures,
  );
  const macroState = extractExtendedFeature(
    extFeatures?.macro_state, "ext_macroState",
    featuresEvaluated, unavailableFeatures,
  );
  const sentimentSummary = extractExtendedFeature(
    extFeatures?.sentiment_summary, "ext_sentimentSummary",
    featuresEvaluated, unavailableFeatures,
  );

  const features: ExtractedFeatures = {
    direction,
    trendStrength,
    impulseRatio,
    rangeNorm,
    closePosition,
    rejectionRatio,
    atrProxy,
    expansionIndicator,
    contractionIndicator,
    speedProxy,
    volRegimeScore,
    rollingTrend,
    atrPercentile,
    volatilityRegimeScore,
    macroState,
    sentimentSummary,
  };

  return { features, unavailableFeatures, featuresEvaluated };
}

/**
 * Extract an extended feature value.
 * If undefined or at neutral default (0.5), marks it as unavailable.
 */
function extractExtendedFeature(
  value: number | undefined,
  name: string,
  featuresEvaluated: Record<string, number>,
  unavailableFeatures: string[],
): number {
  if (value === undefined || value === null) {
    unavailableFeatures.push(name);
    featuresEvaluated[name] = NEUTRAL_DEFAULT;
    return NEUTRAL_DEFAULT;
  }

  // Check if value is neutral default (indicates missing data from Phase 7)
  if (Math.abs(value - NEUTRAL_DEFAULT) < NEUTRAL_TOLERANCE) {
    unavailableFeatures.push(name);
  }

  featuresEvaluated[name] = value;
  return value;
}

// =============================================================================
// Rule Evaluation
// =============================================================================

/**
 * Evaluate all regime rules against extracted features.
 * Each regime has explicit threshold-based conditions.
 * Returns scored regimes with the rules that fired for each.
 */
function evaluateAllRules(
  features: ExtractedFeatures,
  thresholdConditions: Record<string, { threshold: number; actual: number; passed: boolean }>,
): ScoredRegime[] {
  return [
    evaluateTrend(features, thresholdConditions),
    evaluateRanging(features, thresholdConditions),
    evaluateExpansion(features, thresholdConditions),
    evaluateContraction(features, thresholdConditions),
    evaluateMacroDriven(features, thresholdConditions),
    evaluateBreakout(features, thresholdConditions),
    evaluateReversal(features, thresholdConditions),
    evaluateAccumulation(features, thresholdConditions),
    evaluateDistribution(features, thresholdConditions),
  ];
}

/**
 * TREND: Strong directional movement with high trend strength and impulse.
 * Rules:
 *   - trendStrength > 0.55
 *   - impulseRatio > 0.5
 *   - (optional boost) rollingTrend deviates from 0.5
 */
function evaluateTrend(
  f: ExtractedFeatures,
  tc: Record<string, { threshold: number; actual: number; passed: boolean }>,
): ScoredRegime {
  const rules: string[] = [];
  let score = 0;

  const strengthPassed = f.trendStrength > TREND_STRENGTH_THRESHOLD;
  tc["trend_strength"] = {
    threshold: TREND_STRENGTH_THRESHOLD,
    actual: f.trendStrength,
    passed: strengthPassed,
  };

  const impulsePassed = f.impulseRatio > TREND_IMPULSE_THRESHOLD;
  tc["trend_impulse"] = {
    threshold: TREND_IMPULSE_THRESHOLD,
    actual: f.impulseRatio,
    passed: impulsePassed,
  };

  if (strengthPassed) {
    rules.push("trend_strength_above_threshold");
    score += 0.5;
  }
  if (impulsePassed) {
    rules.push("trend_impulse_above_threshold");
    score += 0.3;
  }

  // Boost from extended rolling trend if available and not neutral
  if (!isNeutral(f.rollingTrend)) {
    const trendDeviation = Math.abs(f.rollingTrend - NEUTRAL_DEFAULT);
    if (trendDeviation > 0.2) {
      rules.push("trend_rolling_trend_confirms");
      score += 0.2;
    }
  }

  return { regime: "trend", score, rules_fired: rules };
}

/**
 * RANGING: Low directional movement, modest range.
 * Rules:
 *   - trendStrength < 0.35
 *   - expansionIndicator < 0.4
 */
function evaluateRanging(
  f: ExtractedFeatures,
  tc: Record<string, { threshold: number; actual: number; passed: boolean }>,
): ScoredRegime {
  const rules: string[] = [];
  let score = 0;

  const strengthPassed = f.trendStrength < RANGING_STRENGTH_CEILING;
  tc["ranging_strength_ceiling"] = {
    threshold: RANGING_STRENGTH_CEILING,
    actual: f.trendStrength,
    passed: strengthPassed,
  };

  const expansionPassed = f.expansionIndicator < RANGING_EXPANSION_CEILING;
  tc["ranging_expansion_ceiling"] = {
    threshold: RANGING_EXPANSION_CEILING,
    actual: f.expansionIndicator,
    passed: expansionPassed,
  };

  if (strengthPassed) {
    rules.push("ranging_low_trend_strength");
    score += 0.5;
  }
  if (expansionPassed) {
    rules.push("ranging_low_expansion");
    score += 0.3;
  }

  // Boost if rolling trend is close to 0.5 (indecisive) and available
  if (!isNeutral(f.rollingTrend)) {
    const trendDeviation = Math.abs(f.rollingTrend - NEUTRAL_DEFAULT);
    if (trendDeviation < 0.15) {
      rules.push("ranging_rolling_trend_indecisive");
      score += 0.2;
    }
  }

  return { regime: "ranging", score, rules_fired: rules };
}

/**
 * EXPANSION: High volatility, wide range.
 * Rules:
 *   - expansionIndicator > 0.65
 *   - atrProxy > 0.6 (or atrPercentile if available)
 */
function evaluateExpansion(
  f: ExtractedFeatures,
  tc: Record<string, { threshold: number; actual: number; passed: boolean }>,
): ScoredRegime {
  const rules: string[] = [];
  let score = 0;

  const expansionPassed = f.expansionIndicator > EXPANSION_INDICATOR_THRESHOLD;
  tc["expansion_indicator"] = {
    threshold: EXPANSION_INDICATOR_THRESHOLD,
    actual: f.expansionIndicator,
    passed: expansionPassed,
  };

  const atrPassed = f.atrProxy > EXPANSION_ATR_THRESHOLD;
  tc["expansion_atr"] = {
    threshold: EXPANSION_ATR_THRESHOLD,
    actual: f.atrProxy,
    passed: atrPassed,
  };

  if (expansionPassed) {
    rules.push("expansion_indicator_above_threshold");
    score += 0.5;
  }
  if (atrPassed) {
    rules.push("expansion_atr_above_threshold");
    score += 0.3;
  }

  // Boost from extended atrPercentile if available
  if (!isNeutral(f.atrPercentile) && f.atrPercentile > 0.7) {
    rules.push("expansion_atr_percentile_high");
    score += 0.2;
  }

  return { regime: "expansion", score, rules_fired: rules };
}

/**
 * CONTRACTION: Low volatility, narrow range, compression.
 * Rules:
 *   - contractionIndicator > 0.65
 *   - atrProxy < 0.35
 */
function evaluateContraction(
  f: ExtractedFeatures,
  tc: Record<string, { threshold: number; actual: number; passed: boolean }>,
): ScoredRegime {
  const rules: string[] = [];
  let score = 0;

  const contractionPassed = f.contractionIndicator > CONTRACTION_INDICATOR_THRESHOLD;
  tc["contraction_indicator"] = {
    threshold: CONTRACTION_INDICATOR_THRESHOLD,
    actual: f.contractionIndicator,
    passed: contractionPassed,
  };

  const atrPassed = f.atrProxy < CONTRACTION_ATR_CEILING;
  tc["contraction_atr_ceiling"] = {
    threshold: CONTRACTION_ATR_CEILING,
    actual: f.atrProxy,
    passed: atrPassed,
  };

  if (contractionPassed) {
    rules.push("contraction_indicator_above_threshold");
    score += 0.5;
  }
  if (atrPassed) {
    rules.push("contraction_atr_below_ceiling");
    score += 0.3;
  }

  // Boost from extended atrPercentile if available and low
  if (!isNeutral(f.atrPercentile) && f.atrPercentile < 0.3) {
    rules.push("contraction_atr_percentile_low");
    score += 0.2;
  }

  return { regime: "contraction", score, rules_fired: rules };
}

/**
 * MACRO_DRIVEN: Macro context dominates price action.
 * Rules:
 *   - macroState deviates significantly from 0.5 (strong macro influence)
 *   - L4 macro_context average deviates from 0.5
 */
function evaluateMacroDriven(
  f: ExtractedFeatures,
  tc: Record<string, { threshold: number; actual: number; passed: boolean }>,
): ScoredRegime {
  const rules: string[] = [];
  let score = 0;

  // Extended macro_state check
  const macroDeviation = Math.abs(f.macroState - NEUTRAL_DEFAULT);
  const macroPassed = macroDeviation > MACRO_STATE_DEVIATION_THRESHOLD;
  tc["macro_state_deviation"] = {
    threshold: MACRO_STATE_DEVIATION_THRESHOLD,
    actual: macroDeviation,
    passed: macroPassed,
  };

  if (macroPassed && !isNeutral(f.macroState)) {
    rules.push("macro_state_strong_deviation");
    score += 0.6;
  }

  // L4 macro context deviation (sentiment from macro context layer)
  const sentimentDeviation = Math.abs(f.sentimentSummary - NEUTRAL_DEFAULT);
  const sentimentPassed = sentimentDeviation > MACRO_CONTEXT_DEVIATION_THRESHOLD;
  tc["macro_sentiment_deviation"] = {
    threshold: MACRO_CONTEXT_DEVIATION_THRESHOLD,
    actual: sentimentDeviation,
    passed: sentimentPassed,
  };

  if (sentimentPassed && !isNeutral(f.sentimentSummary)) {
    rules.push("macro_sentiment_strong_deviation");
    score += 0.3;
  }

  // Low trend strength (price not leading, macro leading)
  if (f.trendStrength < 0.4) {
    rules.push("macro_low_price_trend");
    score += 0.1;
  }

  return { regime: "macro_driven", score, rules_fired: rules };
}

/**
 * BREAKOUT: Strong impulsive move with high speed out of compression.
 * Rules:
 *   - impulseRatio > 0.6
 *   - speedProxy > 0.6
 *   - expansionIndicator > 0.55
 */
function evaluateBreakout(
  f: ExtractedFeatures,
  tc: Record<string, { threshold: number; actual: number; passed: boolean }>,
): ScoredRegime {
  const rules: string[] = [];
  let score = 0;

  const impulsePassed = f.impulseRatio > BREAKOUT_IMPULSE_THRESHOLD;
  tc["breakout_impulse"] = {
    threshold: BREAKOUT_IMPULSE_THRESHOLD,
    actual: f.impulseRatio,
    passed: impulsePassed,
  };

  const speedPassed = f.speedProxy > BREAKOUT_SPEED_THRESHOLD;
  tc["breakout_speed"] = {
    threshold: BREAKOUT_SPEED_THRESHOLD,
    actual: f.speedProxy,
    passed: speedPassed,
  };

  const expansionPassed = f.expansionIndicator > BREAKOUT_EXPANSION_THRESHOLD;
  tc["breakout_expansion"] = {
    threshold: BREAKOUT_EXPANSION_THRESHOLD,
    actual: f.expansionIndicator,
    passed: expansionPassed,
  };

  if (impulsePassed) {
    rules.push("breakout_high_impulse");
    score += 0.35;
  }
  if (speedPassed) {
    rules.push("breakout_high_speed");
    score += 0.35;
  }
  if (expansionPassed) {
    rules.push("breakout_range_expansion");
    score += 0.3;
  }

  return { regime: "breakout", score, rules_fired: rules };
}

/**
 * REVERSAL: Direction contradiction with large rejection wicks.
 * Rules:
 *   - rejectionRatio > 0.5 (large wick relative to range)
 *   - direction shift: close position contradicts direction expectation
 */
function evaluateReversal(
  f: ExtractedFeatures,
  tc: Record<string, { threshold: number; actual: number; passed: boolean }>,
): ScoredRegime {
  const rules: string[] = [];
  let score = 0;

  const rejectionPassed = f.rejectionRatio > REVERSAL_REJECTION_THRESHOLD;
  tc["reversal_rejection"] = {
    threshold: REVERSAL_REJECTION_THRESHOLD,
    actual: f.rejectionRatio,
    passed: rejectionPassed,
  };

  // Direction shift: if direction is bullish (>0.5) but close is low,
  // or direction is bearish (<0.5) but close is high
  const directionShift = Math.abs(f.direction - f.closePosition);
  const shiftPassed = directionShift > REVERSAL_DIRECTION_SHIFT_THRESHOLD;
  tc["reversal_direction_shift"] = {
    threshold: REVERSAL_DIRECTION_SHIFT_THRESHOLD,
    actual: directionShift,
    passed: shiftPassed,
  };

  if (rejectionPassed) {
    rules.push("reversal_high_rejection");
    score += 0.5;
  }
  if (shiftPassed) {
    rules.push("reversal_direction_contradiction");
    score += 0.3;
  }

  // Boost if rolling trend shows counter-direction movement
  if (!isNeutral(f.rollingTrend)) {
    const trendVsDirection = Math.abs(f.rollingTrend - f.direction);
    if (trendVsDirection > 0.3) {
      rules.push("reversal_rolling_trend_contradicts");
      score += 0.2;
    }
  }

  return { regime: "reversal", score, rules_fired: rules };
}

/**
 * ACCUMULATION: Low volatility with subtle bullish bias (buying pressure).
 * Rules:
 *   - contractionIndicator > 0.5 (low volatility)
 *   - closePosition > 0.55 (closes near highs)
 *   - low trend strength (not yet trending)
 */
function evaluateAccumulation(
  f: ExtractedFeatures,
  tc: Record<string, { threshold: number; actual: number; passed: boolean }>,
): ScoredRegime {
  const rules: string[] = [];
  let score = 0;

  const contractionPassed = f.contractionIndicator > ACCUMULATION_CONTRACTION_THRESHOLD;
  tc["accumulation_contraction"] = {
    threshold: ACCUMULATION_CONTRACTION_THRESHOLD,
    actual: f.contractionIndicator,
    passed: contractionPassed,
  };

  const closePositionPassed = f.closePosition > ACCUMULATION_CLOSE_POSITION_THRESHOLD;
  tc["accumulation_close_position"] = {
    threshold: ACCUMULATION_CLOSE_POSITION_THRESHOLD,
    actual: f.closePosition,
    passed: closePositionPassed,
  };

  if (contractionPassed) {
    rules.push("accumulation_low_volatility");
    score += 0.4;
  }
  if (closePositionPassed) {
    rules.push("accumulation_bullish_close_bias");
    score += 0.4;
  }

  // Low trend strength means not yet trending (accumulation precedes trend)
  if (f.trendStrength < 0.4) {
    rules.push("accumulation_low_trend_strength");
    score += 0.2;
  }

  return { regime: "accumulation", score, rules_fired: rules };
}

/**
 * DISTRIBUTION: Low volatility with subtle bearish bias (selling pressure).
 * Rules:
 *   - contractionIndicator > 0.5 (low volatility)
 *   - closePosition < 0.45 (closes near lows)
 *   - low trend strength (not yet trending down)
 */
function evaluateDistribution(
  f: ExtractedFeatures,
  tc: Record<string, { threshold: number; actual: number; passed: boolean }>,
): ScoredRegime {
  const rules: string[] = [];
  let score = 0;

  const contractionPassed = f.contractionIndicator > DISTRIBUTION_CONTRACTION_THRESHOLD;
  tc["distribution_contraction"] = {
    threshold: DISTRIBUTION_CONTRACTION_THRESHOLD,
    actual: f.contractionIndicator,
    passed: contractionPassed,
  };

  const closePositionPassed = f.closePosition < DISTRIBUTION_CLOSE_POSITION_CEILING;
  tc["distribution_close_position"] = {
    threshold: DISTRIBUTION_CLOSE_POSITION_CEILING,
    actual: f.closePosition,
    passed: closePositionPassed,
  };

  if (contractionPassed) {
    rules.push("distribution_low_volatility");
    score += 0.4;
  }
  if (closePositionPassed) {
    rules.push("distribution_bearish_close_bias");
    score += 0.4;
  }

  // Low trend strength means not yet trending (distribution precedes downtrend)
  if (f.trendStrength < 0.4) {
    rules.push("distribution_low_trend_strength");
    score += 0.2;
  }

  return { regime: "distribution", score, rules_fired: rules };
}

// =============================================================================
// Utility Functions
// =============================================================================

/**
 * Check if a value is at the neutral default (0.5), indicating unavailable data.
 */
function isNeutral(value: number): boolean {
  return Math.abs(value - NEUTRAL_DEFAULT) < NEUTRAL_TOLERANCE;
}

/**
 * Clamp a value to [min, max].
 */
function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

/**
 * Round a number to 6 decimal places.
 */
function roundTo6(value: number): number {
  const factor = 1_000_000;
  return Math.round(value * factor) / factor;
}
