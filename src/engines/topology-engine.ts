/**
 * Topology Engine
 *
 * Computes deterministic Support & Resistance topology from historical price data.
 * Identifies structural levels (support, resistance, flip zones) with strength,
 * touch/rejection/breakout counts, and produces a fixed-length 40-dimensional
 * normalised vector for similarity comparison.
 *
 * Key invariants:
 * - DETERMINISTIC: identical ordered price history → identical output
 * - Pure function: no side effects, no database access in computation
 * - Up to 20 structural levels per topology
 * - All vector values normalised to [0, 1]
 * - relative_importance normalised to sum to 1.0
 * - Minimum 30 candles required; uses most recent 120 candles (480H)
 *
 * Requirements: 13.1, 13.2, 13.3, 13.4, 13.5, 13.7
 */

import type { OHLC } from "../types/index.js";

// =============================================================================
// Constants
// =============================================================================

const TOPOLOGY_ENGINE_VERSION = "1.0.0";

/** Maximum number of candles to use for topology computation */
const MAX_CANDLES = 120;

/** Minimum number of candles required for topology computation */
const MIN_CANDLES = 30;

/** Maximum number of structural levels in output */
const MAX_LEVELS = 20;

/** Topology vector dimensionality */
const TOPOLOGY_VECTOR_DIM = 40;

/** 1 pip = 0.0001 for major FX pairs */
const PIP_DIVISOR = 0.0001;

/**
 * Price clustering tolerance in pips.
 * Levels within this distance are merged into one.
 */
const CLUSTER_TOLERANCE_PIPS = 5;

/**
 * Proximity threshold in pips for touch/rejection/breakout detection.
 * A candle interacts with a level if its price is within this distance.
 */
const INTERACTION_THRESHOLD_PIPS = 3;

/**
 * Similarity Engine weight for topology layer (research-only, disabled).
 * Set to 0.0 until explicitly activated in a future release.
 */
export const TOPOLOGY_SIMILARITY_WEIGHT = 0.0;

// =============================================================================
// Public Interfaces
// =============================================================================

/** A single structural level in the topology. */
export interface TopologyLevel {
  price: number;
  type: "support" | "resistance" | "flip_zone";
  strength: number; // [0, 1] normalised rejection frequency
  touch_count: number;
  rejection_count: number;
  breakout_count: number;
  age_in_candles: number;
  distance_from_current_price_pips: number;
  relative_importance: number; // normalised to sum to 1.0
}

/** Input to the Topology Engine. */
export interface TopologyInput {
  fingerprint_id: string;
  asset: string;
  candles: OHLC[]; // ordered chronologically, most recent last
}

/** Output from the Topology Engine. */
export interface TopologyOutput {
  fingerprint_id: string;
  asset: string;
  levels: TopologyLevel[]; // max 20
  topology_vector: number[]; // 40 dimensions, normalised [0, 1]
  insufficient_history: boolean;
  candle_count_used: number;
  engine_version: string;
}

// =============================================================================
// Internal Types
// =============================================================================

/** Raw candidate level before filtering and normalisation. */
interface CandidateLevel {
  price: number;
  first_seen_index: number;
  touches: number;
  rejections: number;
  breakouts: number;
  support_interactions: number;
  resistance_interactions: number;
}

// =============================================================================
// Public API
// =============================================================================

/**
 * Compute a deterministic Support & Resistance topology from price history.
 * This is a pure function — no side effects, no database access.
 *
 * @param input - TopologyInput containing fingerprint_id, asset, and candles
 * @returns TopologyOutput with structural levels and normalised vector
 */
export function computeTopology(input: TopologyInput): TopologyOutput {
  const { fingerprint_id, asset, candles } = input;

  // Use at most the most recent 120 candles
  const recentCandles = candles.slice(-MAX_CANDLES);
  const candleCount = recentCandles.length;

  // Insufficient history check
  if (candleCount < MIN_CANDLES) {
    return {
      fingerprint_id,
      asset,
      levels: [],
      topology_vector: Array(TOPOLOGY_VECTOR_DIM).fill(0),
      insufficient_history: true,
      candle_count_used: candleCount,
      engine_version: TOPOLOGY_ENGINE_VERSION,
    };
  }

  // 1. Identify candidate price levels from swing highs/lows
  const candidates = identifyCandidateLevels(recentCandles);

  // 2. Cluster nearby levels
  const clustered = clusterLevels(candidates);

  // 3. Count interactions (touches, rejections, breakouts) for each level
  const enriched = countInteractions(clustered, recentCandles);

  // 4. Score and rank levels, take top 20
  const ranked = rankAndTrimLevels(enriched, recentCandles);

  // 5. Classify level types and compute final properties
  const currentPrice = recentCandles[recentCandles.length - 1].close;
  const levels = buildTopologyLevels(ranked, currentPrice, candleCount);

  // 6. Compute 40-dimensional normalised vector
  const topologyVector = computeTopologyVector(levels, candleCount);

  return {
    fingerprint_id,
    asset,
    levels,
    topology_vector: topologyVector,
    insufficient_history: false,
    candle_count_used: candleCount,
    engine_version: TOPOLOGY_ENGINE_VERSION,
  };
}

// =============================================================================
// Level Identification
// =============================================================================

/**
 * Identify candidate S/R levels from swing highs and swing lows.
 * A swing high is a candle whose high is greater than both its neighbours' highs.
 * A swing low is a candle whose low is less than both its neighbours' lows.
 * Also includes open/close clusters as secondary level candidates.
 */
function identifyCandidateLevels(candles: OHLC[]): CandidateLevel[] {
  const candidates: CandidateLevel[] = [];

  for (let i = 1; i < candles.length - 1; i++) {
    const prev = candles[i - 1];
    const curr = candles[i];
    const next = candles[i + 1];

    // Swing high detection
    if (curr.high > prev.high && curr.high > next.high) {
      candidates.push({
        price: curr.high,
        first_seen_index: i,
        touches: 1,
        rejections: 0,
        breakouts: 0,
        support_interactions: 0,
        resistance_interactions: 1,
      });
    }

    // Swing low detection
    if (curr.low < prev.low && curr.low < next.low) {
      candidates.push({
        price: curr.low,
        first_seen_index: i,
        touches: 1,
        rejections: 0,
        breakouts: 0,
        support_interactions: 1,
        resistance_interactions: 0,
      });
    }
  }

  // Add open/close levels from significant candles (large body candles)
  for (let i = 0; i < candles.length; i++) {
    const candle = candles[i];
    const bodySize = Math.abs(candle.close - candle.open);
    const range = candle.high - candle.low;

    // Only consider candles where body is > 60% of range (strong directional candles)
    if (range > 0 && bodySize / range > 0.6) {
      // The open and close of strong candles form natural levels
      const bodyBottom = Math.min(candle.open, candle.close);
      const bodyTop = Math.max(candle.open, candle.close);

      candidates.push({
        price: bodyBottom,
        first_seen_index: i,
        touches: 1,
        rejections: 0,
        breakouts: 0,
        support_interactions: 1,
        resistance_interactions: 0,
      });

      candidates.push({
        price: bodyTop,
        first_seen_index: i,
        touches: 1,
        rejections: 0,
        breakouts: 0,
        support_interactions: 0,
        resistance_interactions: 1,
      });
    }
  }

  return candidates;
}

// =============================================================================
// Level Clustering
// =============================================================================

/**
 * Cluster candidate levels that are within CLUSTER_TOLERANCE_PIPS of each other.
 * Merges nearby levels into a single level at the average price.
 * Uses deterministic ordering (sorted by price ascending).
 */
function clusterLevels(candidates: CandidateLevel[]): CandidateLevel[] {
  if (candidates.length === 0) return [];

  // Sort by price ascending for deterministic clustering
  const sorted = [...candidates].sort((a, b) => a.price - b.price);
  const tolerance = CLUSTER_TOLERANCE_PIPS * PIP_DIVISOR;
  const clusters: CandidateLevel[][] = [];
  let currentCluster: CandidateLevel[] = [sorted[0]];

  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i].price - currentCluster[0].price <= tolerance) {
      currentCluster.push(sorted[i]);
    } else {
      clusters.push(currentCluster);
      currentCluster = [sorted[i]];
    }
  }
  clusters.push(currentCluster);

  // Merge each cluster into a single representative level
  return clusters.map((cluster) => {
    const avgPrice =
      cluster.reduce((sum, c) => sum + c.price, 0) / cluster.length;
    const firstSeen = Math.min(...cluster.map((c) => c.first_seen_index));
    const totalSupport = cluster.reduce(
      (sum, c) => sum + c.support_interactions,
      0,
    );
    const totalResistance = cluster.reduce(
      (sum, c) => sum + c.resistance_interactions,
      0,
    );

    return {
      price: roundToPrecision(avgPrice, 5),
      first_seen_index: firstSeen,
      touches: cluster.length,
      rejections: 0,
      breakouts: 0,
      support_interactions: totalSupport,
      resistance_interactions: totalResistance,
    };
  });
}

// =============================================================================
// Interaction Counting
// =============================================================================

/**
 * Count touches, rejections, and breakouts for each level against all candles.
 *
 * - Touch: candle high/low comes within INTERACTION_THRESHOLD_PIPS of the level
 * - Rejection: touch that doesn't close beyond the level (price bounced)
 * - Breakout: candle closes beyond the level after a touch
 */
function countInteractions(
  levels: CandidateLevel[],
  candles: OHLC[],
): CandidateLevel[] {
  const threshold = INTERACTION_THRESHOLD_PIPS * PIP_DIVISOR;

  return levels.map((level) => {
    let touches = 0;
    let rejections = 0;
    let breakouts = 0;

    for (let i = 0; i < candles.length; i++) {
      const candle = candles[i];
      const levelPrice = level.price;

      // Check if candle interacts with this level
      const highDistance = Math.abs(candle.high - levelPrice);
      const lowDistance = Math.abs(candle.low - levelPrice);
      const closestDistance = Math.min(highDistance, lowDistance);

      // A touch occurs when candle range crosses or comes within threshold of the level
      const candleCrossesLevel =
        candle.low <= levelPrice + threshold &&
        candle.high >= levelPrice - threshold;

      if (candleCrossesLevel) {
        touches++;

        // Rejection: candle touches but doesn't close beyond
        // For a level above close: if level > candle.close → rejection from above (resistance holds)
        // For a level below close: if level < candle.close → rejection from below (support holds)
        const closedAbove = candle.close > levelPrice + threshold;
        const closedBelow = candle.close < levelPrice - threshold;

        if (!closedAbove && !closedBelow) {
          // Close is near the level (within threshold) or bounced back
          rejections++;
        } else {
          // Close moved decisively through the level
          breakouts++;
        }
      }
    }

    return {
      ...level,
      touches: Math.max(touches, 1), // at least 1 touch (the initial detection)
      rejections,
      breakouts,
    };
  });
}

// =============================================================================
// Ranking and Trimming
// =============================================================================

/**
 * Score levels by significance and take the top MAX_LEVELS.
 * Score = rejections * 2 + touches - breakouts (rewarding holding, penalising breaks).
 * Deterministic ordering: score descending, then price ascending for ties.
 */
function rankAndTrimLevels(
  levels: CandidateLevel[],
  candles: OHLC[],
): CandidateLevel[] {
  const scored = levels.map((level) => ({
    level,
    score: level.rejections * 2 + level.touches - level.breakouts,
  }));

  // Sort by score descending, then by price ascending for deterministic tie-breaking
  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return a.level.price - b.level.price;
  });

  return scored.slice(0, MAX_LEVELS).map((s) => s.level);
}

// =============================================================================
// Level Classification and Final Assembly
// =============================================================================

/**
 * Build final TopologyLevel array with type classification and normalised importance.
 *
 * Type classification:
 * - support: predominantly support interactions (support_interactions > resistance_interactions)
 * - resistance: predominantly resistance interactions
 * - flip_zone: both support and resistance (balance within 30%)
 *
 * Strength: rejection_count / touch_count (normalised [0, 1])
 *
 * relative_importance: strength × (1 / distance_from_current_price_pips),
 * normalised to sum to 1.0 across all levels.
 */
function buildTopologyLevels(
  candidates: CandidateLevel[],
  currentPrice: number,
  totalCandles: number,
): TopologyLevel[] {
  if (candidates.length === 0) return [];

  // Build raw levels
  const rawLevels = candidates.map((c) => {
    const distancePips = roundToPrecision(
      Math.abs(c.price - currentPrice) / PIP_DIVISOR,
      2,
    );
    const strength = c.touches > 0 ? clamp(c.rejections / c.touches, 0, 1) : 0;
    const ageInCandles = totalCandles - c.first_seen_index;

    // Classify type based on interaction balance
    const total = c.support_interactions + c.resistance_interactions;
    let type: "support" | "resistance" | "flip_zone";
    if (total === 0) {
      type = distancePips > 0 && c.price < currentPrice ? "support" : "resistance";
    } else {
      const supportRatio = c.support_interactions / total;
      if (supportRatio > 0.65) {
        type = "support";
      } else if (supportRatio < 0.35) {
        type = "resistance";
      } else {
        type = "flip_zone";
      }
    }

    return {
      price: c.price,
      type,
      strength: roundToPrecision(strength, 6),
      touch_count: c.touches,
      rejection_count: c.rejections,
      breakout_count: c.breakouts,
      age_in_candles: ageInCandles,
      distance_from_current_price_pips: distancePips,
      relative_importance: 0, // placeholder, computed below
    };
  });

  // Compute relative_importance:
  // raw_importance = strength × (1 / max(distance_pips, 1))
  // Then normalise to sum to 1.0
  const rawImportances = rawLevels.map((level) => {
    const safeDistance = Math.max(level.distance_from_current_price_pips, 1);
    return level.strength * (1 / safeDistance);
  });

  const importanceSum = rawImportances.reduce((sum, v) => sum + v, 0);

  // Normalise to sum to 1.0
  const normalisedImportances =
    importanceSum === 0
      ? rawLevels.map(() => 1 / rawLevels.length) // equal weight if all zero
      : rawImportances.map((v) => v / importanceSum);

  // Apply normalised importance values
  const levels: TopologyLevel[] = rawLevels.map((level, i) => ({
    ...level,
    relative_importance: roundToPrecision(normalisedImportances[i], 6),
  }));

  // Final correction: ensure sum is exactly 1.0 (adjust largest element for rounding)
  const currentSum = levels.reduce((s, l) => s + l.relative_importance, 0);
  if (levels.length > 0 && Math.abs(currentSum - 1.0) > 1e-10) {
    const maxIdx = levels.reduce(
      (maxI, l, i, arr) =>
        l.relative_importance > arr[maxI].relative_importance ? i : maxI,
      0,
    );
    levels[maxIdx].relative_importance = roundToPrecision(
      levels[maxIdx].relative_importance + (1.0 - currentSum),
      6,
    );
  }

  return levels;
}

// =============================================================================
// Topology Vector Computation
// =============================================================================

/**
 * Compute a 40-dimensional normalised vector encoding the topology state.
 * The vector is fixed-length regardless of how many levels exist, suitable
 * for cosine similarity comparison.
 *
 * Vector layout (40 dimensions):
 *  [0]      Level count (normalised: count / MAX_LEVELS)
 *  [1-3]    Type distribution (support_ratio, resistance_ratio, flip_zone_ratio)
 *  [4-7]    Strength distribution (min, max, mean, std_dev)
 *  [8-11]   Distance distribution (min, max, mean, std_dev) normalised
 *  [12-15]  Age distribution (min, max, mean, std_dev) normalised
 *  [16-19]  Touch count distribution (min, max, mean, std_dev) normalised
 *  [20-23]  Rejection count distribution (min, max, mean, std_dev) normalised
 *  [24-27]  Breakout count distribution (min, max, mean, std_dev) normalised
 *  [28-31]  Importance distribution (min, max, mean, std_dev)
 *  [32-35]  Spatial distribution (4 quartile densities: levels per price quartile)
 *  [36]     Average strength of top 5 levels
 *  [37]     Flip zone ratio (flip zones / total levels)
 *  [38]     Near-price density (levels within 20 pips / total)
 *  [39]     Symmetry (levels above vs below current price balance)
 */
function computeTopologyVector(
  levels: TopologyLevel[],
  candleCount: number,
): number[] {
  const vector = new Array(TOPOLOGY_VECTOR_DIM).fill(0);

  if (levels.length === 0) {
    return vector;
  }

  const n = levels.length;

  // [0] Level count normalised
  vector[0] = clamp(n / MAX_LEVELS, 0, 1);

  // [1-3] Type distribution
  const supportCount = levels.filter((l) => l.type === "support").length;
  const resistanceCount = levels.filter((l) => l.type === "resistance").length;
  const flipZoneCount = levels.filter((l) => l.type === "flip_zone").length;
  vector[1] = supportCount / n;
  vector[2] = resistanceCount / n;
  vector[3] = flipZoneCount / n;

  // [4-7] Strength distribution
  const strengths = levels.map((l) => l.strength);
  const strengthStats = computeStats(strengths);
  vector[4] = strengthStats.min;
  vector[5] = strengthStats.max;
  vector[6] = strengthStats.mean;
  vector[7] = strengthStats.stdDev;

  // [8-11] Distance distribution (normalise using 500 pips as reference max)
  const distances = levels.map((l) => l.distance_from_current_price_pips);
  const distStats = computeStats(distances);
  const distMax = 500; // reference max for normalisation
  vector[8] = clamp(distStats.min / distMax, 0, 1);
  vector[9] = clamp(distStats.max / distMax, 0, 1);
  vector[10] = clamp(distStats.mean / distMax, 0, 1);
  vector[11] = clamp(distStats.stdDev / distMax, 0, 1);

  // [12-15] Age distribution (normalise using candleCount as max)
  const ages = levels.map((l) => l.age_in_candles);
  const ageStats = computeStats(ages);
  const ageMax = Math.max(candleCount, 1);
  vector[12] = clamp(ageStats.min / ageMax, 0, 1);
  vector[13] = clamp(ageStats.max / ageMax, 0, 1);
  vector[14] = clamp(ageStats.mean / ageMax, 0, 1);
  vector[15] = clamp(ageStats.stdDev / ageMax, 0, 1);

  // [16-19] Touch count distribution (normalise using candleCount as max)
  const touches = levels.map((l) => l.touch_count);
  const touchStats = computeStats(touches);
  const touchMax = Math.max(candleCount, 1);
  vector[16] = clamp(touchStats.min / touchMax, 0, 1);
  vector[17] = clamp(touchStats.max / touchMax, 0, 1);
  vector[18] = clamp(touchStats.mean / touchMax, 0, 1);
  vector[19] = clamp(touchStats.stdDev / touchMax, 0, 1);

  // [20-23] Rejection count distribution
  const rejections = levels.map((l) => l.rejection_count);
  const rejStats = computeStats(rejections);
  const rejMax = Math.max(candleCount, 1);
  vector[20] = clamp(rejStats.min / rejMax, 0, 1);
  vector[21] = clamp(rejStats.max / rejMax, 0, 1);
  vector[22] = clamp(rejStats.mean / rejMax, 0, 1);
  vector[23] = clamp(rejStats.stdDev / rejMax, 0, 1);

  // [24-27] Breakout count distribution
  const breakouts = levels.map((l) => l.breakout_count);
  const bkStats = computeStats(breakouts);
  const bkMax = Math.max(candleCount, 1);
  vector[24] = clamp(bkStats.min / bkMax, 0, 1);
  vector[25] = clamp(bkStats.max / bkMax, 0, 1);
  vector[26] = clamp(bkStats.mean / bkMax, 0, 1);
  vector[27] = clamp(bkStats.stdDev / bkMax, 0, 1);

  // [28-31] Importance distribution (already [0, 1])
  const importances = levels.map((l) => l.relative_importance);
  const impStats = computeStats(importances);
  vector[28] = impStats.min;
  vector[29] = impStats.max;
  vector[30] = impStats.mean;
  vector[31] = clamp(impStats.stdDev, 0, 1);

  // [32-35] Spatial distribution: density per price quartile
  // Divide the price range of levels into 4 quartiles
  const prices = levels.map((l) => l.price).sort((a, b) => a - b);
  const priceMin = prices[0];
  const priceMax = prices[prices.length - 1];
  const priceRange = priceMax - priceMin;

  if (priceRange > 0) {
    const quartileCounts = [0, 0, 0, 0];
    for (const p of prices) {
      const position = (p - priceMin) / priceRange;
      const quartile = Math.min(Math.floor(position * 4), 3);
      quartileCounts[quartile]++;
    }
    vector[32] = quartileCounts[0] / n;
    vector[33] = quartileCounts[1] / n;
    vector[34] = quartileCounts[2] / n;
    vector[35] = quartileCounts[3] / n;
  } else {
    // All levels at same price
    vector[32] = 1.0;
    vector[33] = 0;
    vector[34] = 0;
    vector[35] = 0;
  }

  // [36] Average strength of top 5 levels (by strength)
  const topStrengths = [...strengths].sort((a, b) => b - a).slice(0, 5);
  vector[36] =
    topStrengths.length > 0
      ? topStrengths.reduce((s, v) => s + v, 0) / topStrengths.length
      : 0;

  // [37] Flip zone ratio
  vector[37] = flipZoneCount / n;

  // [38] Near-price density (levels within 20 pips of current price)
  const nearPriceLevels = levels.filter(
    (l) => l.distance_from_current_price_pips <= 20,
  ).length;
  vector[38] = nearPriceLevels / n;

  // [39] Symmetry: balance of levels above vs below current price
  // 1.0 = perfectly balanced, 0.0 = all on one side
  const aboveCount = levels.filter(
    (l) => l.distance_from_current_price_pips > 0 && l.type === "resistance",
  ).length;
  const belowCount = levels.filter(
    (l) => l.distance_from_current_price_pips > 0 && l.type === "support",
  ).length;
  const totalAboveBelow = aboveCount + belowCount;
  vector[39] =
    totalAboveBelow > 0
      ? 1 - Math.abs(aboveCount - belowCount) / totalAboveBelow
      : 0.5;

  // Round all values and clamp to [0, 1]
  return vector.map((v) => clamp(roundToPrecision(v, 6), 0, 1));
}

// =============================================================================
// Utility Functions
// =============================================================================

/** Compute min, max, mean, and standard deviation of an array. */
function computeStats(values: number[]): {
  min: number;
  max: number;
  mean: number;
  stdDev: number;
} {
  if (values.length === 0) {
    return { min: 0, max: 0, mean: 0, stdDev: 0 };
  }

  const n = values.length;
  const min = Math.min(...values);
  const max = Math.max(...values);
  const mean = values.reduce((s, v) => s + v, 0) / n;
  const variance = values.reduce((s, v) => s + (v - mean) ** 2, 0) / n;
  const stdDev = Math.sqrt(variance);

  return { min, max, mean, stdDev };
}

/** Clamp a value between min and max. */
function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

/** Round to a fixed number of decimal places for deterministic output. */
function roundToPrecision(value: number, decimals: number): number {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}
