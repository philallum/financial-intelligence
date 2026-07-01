/**
 * Outcome Distribution Engine
 *
 * Computes empirical outcome distributions from matched historical fingerprints.
 * Queries forward 4H returns for each matched fingerprint and produces statistical
 * summaries including direction probability, volatility profile, and risk ranges.
 *
 * Key invariants:
 * - DETERMINISTIC: identical inputs (same forward returns) produce identical outputs
 * - Equal weight: all matched fingerprints contribute equally (no similarity-score weighting)
 * - FLAT classification: |R| ≤ 2 pips = FLAT, R > +2 = UP, R < -2 = DOWN
 * - Returns error if matched fingerprint count is zero
 * - Stores results with fingerprint_id, batch_id, engine_version
 *
 * Requirements: 3.1, 3.2, 3.3, 3.4, 3.5, 3.6
 */

import type { OutcomeInput, OutcomeDistribution } from "../types/index.js";
import { FLAT_THRESHOLD } from "../config/constants.js";

// =============================================================================
// Constants
// =============================================================================

const ENGINE_VERSION = "1.0.0";

// =============================================================================
// Database Interaction Types
// =============================================================================

/** Forward return record from the market_outcomes table. */
export interface MarketOutcomeRecord {
  fingerprint_id: string;
  forward_return_pips: number;
}

/** Database access interface for dependency injection. */
export interface OutcomeStore {
  /**
   * Query forward 4H returns for the given fingerprint IDs from market_outcomes table.
   */
  getForwardReturns(fingerprintIds: string[]): Promise<MarketOutcomeRecord[]>;

  /**
   * Store the computed outcome distribution.
   */
  storeOutcome(outcome: OutcomeDistribution): Promise<void>;
}

// =============================================================================
// Public API
// =============================================================================

/**
 * Compute outcome distribution from matched fingerprint IDs.
 * This is the main entry point for the outcome engine.
 *
 * @param input - Array of matched fingerprint IDs (no similarity scores)
 * @param store - Database access interface (injected for testability)
 * @param queryFingerprintId - The fingerprint ID of the query (for labelling output)
 * @param batchId - Current batch processing ID
 * @returns OutcomeDistribution with statistical summaries
 * @throws Error if fingerprint_ids array is empty
 */
export async function computeOutcomeDistribution(
  input: OutcomeInput,
  store: OutcomeStore,
  queryFingerprintId: string,
  batchId: string,
): Promise<OutcomeDistribution> {
  if (input.fingerprint_ids.length === 0) {
    throw new Error("Cannot compute outcome distribution: matched fingerprint count is zero");
  }

  // Query forward 4H returns from the database
  const records = await store.getForwardReturns(input.fingerprint_ids);

  const forwardReturns = records.map((r) => r.forward_return_pips);

  // Compute the distribution from forward returns
  const distribution = computeDistributionFromReturns(
    forwardReturns,
    queryFingerprintId,
    batchId,
  );

  // Store the result
  await store.storeOutcome(distribution);

  return distribution;
}

// =============================================================================
// Core Pure Computation (exported for testability)
// =============================================================================

/**
 * Pure computation function: given an array of forward returns (in pips),
 * compute the full OutcomeDistribution.
 *
 * This is deterministic — identical inputs always produce identical outputs.
 * Exported for direct unit testing without database dependencies.
 *
 * @param forwardReturns - Array of forward 4H returns in pips
 * @param queryFingerprintId - The fingerprint ID of the query
 * @param batchId - Current batch processing ID
 * @returns OutcomeDistribution
 */
export function computeDistributionFromReturns(
  forwardReturns: number[],
  queryFingerprintId: string,
  batchId: string,
): OutcomeDistribution {
  const n = forwardReturns.length;

  if (n === 0) {
    throw new Error("Cannot compute distribution from empty returns array");
  }

  // Sort returns for percentile computation
  const sorted = [...forwardReturns].sort((a, b) => a - b);

  const meanReturn = computeMean(forwardReturns);
  const medianReturn = computeMedian(sorted);
  const directionProbability = computeDirectionProbability(forwardReturns);
  const volatilityProfile = computeVolatilityProfile(forwardReturns, meanReturn);
  const riskRange = computeRiskRange(sorted);
  const confidenceInputs = computeConfidenceInputs(forwardReturns, directionProbability);

  return {
    fingerprint_id: queryFingerprintId,
    sample_size: n,
    mean_return: roundTo6(meanReturn),
    median_return: roundTo6(medianReturn),
    direction_probability: {
      up: roundTo6(directionProbability.up),
      down: roundTo6(directionProbability.down),
      flat: roundTo6(directionProbability.flat),
    },
    volatility_profile: {
      std_dev: roundTo6(volatilityProfile.std_dev),
      max_absolute_return: roundTo6(volatilityProfile.max_absolute_return),
    },
    risk_range: {
      p10: roundTo6(riskRange.p10),
      p50: roundTo6(riskRange.p50),
      p90: roundTo6(riskRange.p90),
    },
    confidence_inputs: {
      regime_consistency: roundTo6(confidenceInputs.regime_consistency),
      distribution_sharpness: roundTo6(confidenceInputs.distribution_sharpness),
    },
    batch_id: batchId,
    engine_version: ENGINE_VERSION,
  };
}

// =============================================================================
// Statistical Computation Functions (exported for testability)
// =============================================================================

/**
 * Compute arithmetic mean of an array of numbers.
 */
export function computeMean(values: number[]): number {
  const sum = values.reduce((acc, v) => acc + v, 0);
  return sum / values.length;
}

/**
 * Compute median of a pre-sorted array.
 * @param sorted - Array sorted in ascending order
 */
export function computeMedian(sorted: number[]): number {
  const n = sorted.length;
  if (n % 2 === 1) {
    return sorted[Math.floor(n / 2)]!;
  }
  return (sorted[n / 2 - 1]! + sorted[n / 2]!) / 2;
}

/**
 * Classify each return and compute direction probabilities.
 * FLAT: |R| ≤ FLAT_THRESHOLD (2 pips)
 * UP: R > +FLAT_THRESHOLD
 * DOWN: R < -FLAT_THRESHOLD
 *
 * Equal weight — each match contributes 1/N.
 */
export function computeDirectionProbability(
  returns: number[],
): { up: number; down: number; flat: number } {
  const n = returns.length;
  let upCount = 0;
  let downCount = 0;
  let flatCount = 0;

  for (const r of returns) {
    if (Math.abs(r) <= FLAT_THRESHOLD) {
      flatCount++;
    } else if (r > FLAT_THRESHOLD) {
      upCount++;
    } else {
      downCount++;
    }
  }

  return {
    up: upCount / n,
    down: downCount / n,
    flat: flatCount / n,
  };
}

/**
 * Compute volatility profile: standard deviation and max absolute return.
 */
export function computeVolatilityProfile(
  returns: number[],
  mean: number,
): { std_dev: number; max_absolute_return: number } {
  const n = returns.length;

  // Population standard deviation
  const sumSquaredDiffs = returns.reduce(
    (acc, r) => acc + (r - mean) ** 2,
    0,
  );
  const std_dev = Math.sqrt(sumSquaredDiffs / n);

  const max_absolute_return = returns.reduce(
    (max, r) => Math.max(max, Math.abs(r)),
    0,
  );

  return { std_dev, max_absolute_return };
}

/**
 * Compute risk range percentiles (p10, p50, p90) using linear interpolation.
 * @param sorted - Array sorted in ascending order
 */
export function computeRiskRange(
  sorted: number[],
): { p10: number; p50: number; p90: number } {
  return {
    p10: percentile(sorted, 0.10),
    p50: percentile(sorted, 0.50),
    p90: percentile(sorted, 0.90),
  };
}

/**
 * Compute confidence inputs:
 * - regime_consistency: how concentrated the direction distribution is (1 = all same direction)
 * - distribution_sharpness: inverse of coefficient of variation (tighter = sharper)
 */
export function computeConfidenceInputs(
  returns: number[],
  directionProbability: { up: number; down: number; flat: number },
): { regime_consistency: number; distribution_sharpness: number } {
  // Regime consistency: max probability among directions
  // Higher means more agreement among historical outcomes
  const regime_consistency = Math.max(
    directionProbability.up,
    directionProbability.down,
    directionProbability.flat,
  );

  // Distribution sharpness: based on how tight the distribution is
  // Use 1 / (1 + CV) where CV = std_dev / |mean|
  // If mean is ~0, sharpness is low (ambiguous direction)
  const mean = computeMean(returns);
  const n = returns.length;
  const sumSquaredDiffs = returns.reduce(
    (acc, r) => acc + (r - mean) ** 2,
    0,
  );
  const std_dev = Math.sqrt(sumSquaredDiffs / n);

  const absMean = Math.abs(mean);
  const cv = absMean === 0 ? std_dev : std_dev / absMean;
  const distribution_sharpness = 1 / (1 + cv);

  return { regime_consistency, distribution_sharpness };
}

// =============================================================================
// Utility Functions
// =============================================================================

/**
 * Compute a percentile value using linear interpolation.
 * @param sorted - Array sorted in ascending order
 * @param p - Percentile as a fraction (0 to 1)
 */
function percentile(sorted: number[], p: number): number {
  const n = sorted.length;
  if (n === 1) return sorted[0]!;

  const index = p * (n - 1);
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  const fraction = index - lower;

  if (lower === upper) return sorted[lower]!;
  return sorted[lower]! * (1 - fraction) + sorted[upper]! * fraction;
}

/** Round to 6 decimal places for deterministic output. */
function roundTo6(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}
