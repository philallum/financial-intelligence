/**
 * Statistically Bounded Confidence Scoring Engine
 *
 * Computes a confidence score reflecting statistical reliability of a forecast.
 * Formula: C_final = C_raw × S(N) × R
 *
 * Where:
 * - C_raw: Raw confidence derived from distribution quality metrics
 * - S(N): Sample Size Dampener = min(1.0, N / 30), capped at 0.5 when N < 30
 * - R: Regime Consistency from fingerprint regime metadata alignment
 *
 * Key invariants:
 * - C_final bounded [0.0, 1.0]
 * - Rejects if N = 0 or any input outside [0, 1] range
 * - Produces identical output given identical inputs (deterministic)
 * - Regime_Consistency computed exclusively from regime metadata — NOT from outcome data
 * - Outputs both confidence_raw and confidence_final
 *
 * Requirements: 5.1, 5.2, 5.3, 5.4, 5.5, 5.6
 */

import type { ConfidenceInput, ConfidenceOutput } from "../types/index.js";

// =============================================================================
// Constants
// =============================================================================

const ENGINE_VERSION = "1.0.0";

/**
 * Minimum sample size for the dampener to reach 1.0.
 * Below this threshold, S(N) is capped at 0.5.
 */
const SAMPLE_SIZE_THRESHOLD = 30;

/**
 * Maximum S(N) value when sample_size < SAMPLE_SIZE_THRESHOLD.
 */
const DAMPENER_CAP_BELOW_THRESHOLD = 0.5;

// =============================================================================
// Database Interaction Types
// =============================================================================

/** Database access interface for dependency injection. */
export interface ConfidenceStore {
  /**
   * Store the computed confidence output alongside its corresponding forecast.
   */
  storeConfidence(output: ConfidenceOutput, fingerprintId: string): Promise<void>;
}

// =============================================================================
// Public API
// =============================================================================

/**
 * Compute statistically bounded confidence and persist the result.
 * This is the main entry point for the confidence engine.
 *
 * @param input - ConfidenceInput containing distribution metrics and regime metadata
 * @param fingerprintId - The fingerprint ID this confidence score belongs to
 * @param store - Database access interface (injected for testability)
 * @returns ConfidenceOutput with raw and final confidence scores
 * @throws Error if sample_size is 0 or any critical input is outside [0, 1]
 */
export async function computeConfidence(
  input: ConfidenceInput,
  fingerprintId: string,
  store: ConfidenceStore,
): Promise<ConfidenceOutput> {
  validateConfidenceInput(input);

  const output = computeConfidenceFromInput(input);

  await store.storeConfidence(output, fingerprintId);

  return output;
}

// =============================================================================
// Core Pure Computation (exported for testability)
// =============================================================================

/**
 * Pure computation function: given a ConfidenceInput, produce a ConfidenceOutput.
 *
 * This is deterministic — identical inputs always produce identical outputs.
 * Exported for direct unit testing without database dependencies.
 *
 * @param input - The confidence input metrics
 * @returns ConfidenceOutput object
 * @throws Error if sample_size is 0 or any critical input is outside [0, 1]
 */
export function computeConfidenceFromInput(input: ConfidenceInput): ConfidenceOutput {
  validateConfidenceInput(input);

  const confidenceRaw = computeRawConfidence(input);
  const sampleWeight = computeSampleSizeDampener(input.sample_size);
  const regimeStability = computeRegimeConsistency(input.regime_metadata);

  // C_final = C_raw × S(N) × R, bounded [0, 1]
  const confidenceFinal = clamp(confidenceRaw * sampleWeight * regimeStability, 0.0, 1.0);

  return {
    confidence_raw: confidenceRaw,
    sample_weight: sampleWeight,
    regime_stability: regimeStability,
    confidence_final: confidenceFinal,
  };
}

// =============================================================================
// Exported Computation Functions (for testability)
// =============================================================================

/**
 * Compute C_raw from distribution quality metrics.
 *
 * Combines:
 * - Probability concentration (how decisive the directional signal is)
 * - Similarity quality (mean_similarity, spread, top_match_density)
 * - Distribution shape penalties (variance, skew, kurtosis)
 *
 * @param input - The confidence input containing all distribution metrics
 * @returns C_raw ∈ [0, 1]
 */
export function computeRawConfidence(input: ConfidenceInput): number {
  // Probability concentration: how far the dominant direction is from uniform (1/3)
  const maxProb = Math.max(input.up_probability, input.down_probability, input.flat_probability);
  const probabilityConcentration = (maxProb - 1 / 3) / (2 / 3); // normalise to [0, 1]

  // Similarity quality: weighted combination of match metrics
  const similarityQuality =
    0.5 * input.mean_similarity + 0.3 * input.top_match_density + 0.2 * (1 - input.similarity_spread);

  // Distribution shape penalty: high variance, extreme skew, and high kurtosis reduce confidence
  const variancePenalty = 1 - input.variance; // lower variance → higher confidence
  const skewPenalty = 1 - Math.abs(input.skew); // symmetric distributions are more confident
  const kurtosisPenalty = 1 - input.kurtosis; // lower kurtosis → more predictable

  const shapeFactor = (variancePenalty + skewPenalty + kurtosisPenalty) / 3;

  // Weighted combination of all factors
  const rawScore = 0.4 * probabilityConcentration + 0.35 * similarityQuality + 0.25 * shapeFactor;

  return clamp(rawScore, 0.0, 1.0);
}

/**
 * Compute Sample Size Dampener: S(N) = min(1.0, N / 30).
 * When N < 30, the result is capped at 0.5.
 *
 * @param sampleSize - Number of matched historical fingerprints (N)
 * @returns S(N) ∈ [0, 1]
 */
export function computeSampleSizeDampener(sampleSize: number): number {
  const rawDampener = Math.min(1.0, sampleSize / SAMPLE_SIZE_THRESHOLD);

  if (sampleSize < SAMPLE_SIZE_THRESHOLD) {
    return Math.min(rawDampener, DAMPENER_CAP_BELOW_THRESHOLD);
  }

  return rawDampener;
}

/**
 * Compute Regime Consistency (R) from fingerprint regime metadata alignment.
 *
 * Uses regime_match_ratio as the primary signal, modulated by regime_diversity.
 * Higher match ratio and lower diversity (more uniform regime) = higher consistency.
 *
 * This computation uses ONLY regime metadata — never outcome data or forecast results.
 *
 * @param regimeMetadata - RegimeOverlapContext from the confidence input
 * @returns R ∈ [0, 1]
 */
export function computeRegimeConsistency(regimeMetadata: {
  regime_match_ratio: number;
  dominant_regime: string;
  regime_diversity: number;
}): number {
  // regime_match_ratio is the primary signal (how many matches share the same regime)
  // regime_diversity penalises scattered regime assignments (higher diversity = less consistency)
  const diversityPenalty = 1 - regimeMetadata.regime_diversity;

  // Weighted combination: primarily regime_match_ratio, modulated by diversity
  const consistency = 0.7 * regimeMetadata.regime_match_ratio + 0.3 * diversityPenalty;

  return clamp(consistency, 0.0, 1.0);
}

// =============================================================================
// Validation
// =============================================================================

/**
 * Validate the confidence input.
 * Rejects if sample_size is 0 or any critical input is outside [0, 1].
 *
 * @throws Error if input is invalid
 */
export function validateConfidenceInput(input: ConfidenceInput): void {
  if (input.sample_size === 0) {
    throw new Error(
      "Cannot compute confidence: sample_size is 0 (insufficient data for statistical reliability)",
    );
  }

  if (input.sample_size < 0) {
    throw new Error(
      "Cannot compute confidence: sample_size must be non-negative",
    );
  }

  // Validate probability inputs are in [0, 1]
  const probabilities: Array<[string, number]> = [
    ["up_probability", input.up_probability],
    ["down_probability", input.down_probability],
    ["flat_probability", input.flat_probability],
  ];

  for (const [name, value] of probabilities) {
    if (value < 0 || value > 1) {
      throw new Error(
        `Cannot compute confidence: ${name} (${value}) is outside valid range [0, 1]`,
      );
    }
  }

  // Validate similarity metrics are in [0, 1]
  const similarityMetrics: Array<[string, number]> = [
    ["mean_similarity", input.mean_similarity],
    ["similarity_spread", input.similarity_spread],
    ["top_match_density", input.top_match_density],
  ];

  for (const [name, value] of similarityMetrics) {
    if (value < 0 || value > 1) {
      throw new Error(
        `Cannot compute confidence: ${name} (${value}) is outside valid range [0, 1]`,
      );
    }
  }

  // Validate distribution shape inputs are in [0, 1]
  const shapeMetrics: Array<[string, number]> = [
    ["variance", input.variance],
    ["skew", input.skew],
    ["kurtosis", input.kurtosis],
  ];

  for (const [name, value] of shapeMetrics) {
    if (value < 0 || value > 1) {
      throw new Error(
        `Cannot compute confidence: ${name} (${value}) is outside valid range [0, 1]`,
      );
    }
  }

  // Validate regime metadata fields are in [0, 1]
  const regimeMetrics: Array<[string, number]> = [
    ["regime_metadata.regime_match_ratio", input.regime_metadata.regime_match_ratio],
    ["regime_metadata.regime_diversity", input.regime_metadata.regime_diversity],
  ];

  for (const [name, value] of regimeMetrics) {
    if (value < 0 || value > 1) {
      throw new Error(
        `Cannot compute confidence: ${name} (${value}) is outside valid range [0, 1]`,
      );
    }
  }
}

// =============================================================================
// Utility Functions
// =============================================================================

/** Clamp a value to [min, max]. */
function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

/** Get the engine version. */
export function getEngineVersion(): string {
  return ENGINE_VERSION;
}
