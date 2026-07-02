/**
 * Evidence-Based Confidence Scoring Engine (v2)
 *
 * Computes a confidence score using empirically derived calibration parameters
 * from the Evaluation Engine dataset. Unlike v1 (which uses theoretical dampening),
 * v2 uses observed prediction accuracy, regime-specific success rates, and
 * sample-density accuracy curves to produce calibrated confidence scores.
 *
 * Formula: C_final = calibration_adjusted_base × regime_accuracy_modifier × sample_density_modifier
 *
 * Key invariants:
 * - C_final bounded [0.0, 1.0], 6 decimal places
 * - Deterministic: identical inputs + identical calibration parameters = bit-identical output
 * - No ML, no self-learning, no adaptive behaviour
 * - Calibration parameters frozen per engine version (stored in engine_versions.config)
 * - Requires minimum 30 evaluated forecasts per grouping; falls back to global if insufficient
 * - Both v1 and v2 loadable via VersionService for comparison
 *
 * Requirements: 11.1, 11.2, 11.3, 11.4, 11.5, 11.6, 11.7, 11.8, 11.9
 */

import type { ConfidenceInput } from "../types/index.js";

// =============================================================================
// Constants
// =============================================================================

/** Engine version identifier for confidence engine v2. */
const ENGINE_VERSION = "2.0.0";

/**
 * Minimum number of evaluated forecasts required per grouping (regime or bucket)
 * before grouping-specific calibration parameters are used.
 * Below this threshold, falls back to global calibration parameters.
 */
const MIN_EVALUATED_FORECASTS = 30;

/** Number of decimal places for confidence output. */
const DECIMAL_PLACES = 6;

// =============================================================================
// Types
// =============================================================================

/**
 * Frozen calibration parameters derived from the Evaluation Engine dataset.
 * These are loaded from the engine_versions.config field at initialization
 * and remain immutable for the duration of the batch.
 *
 * Each parameter set is frozen per engine version and only changes
 * via a new versioned release (Requirement 11.6).
 */
export interface CalibrationParameters {
  /** Observed prediction accuracy grouped by regime classification. */
  regime_accuracy: Record<string, number>;

  /** Observed success rate per calibration bucket. */
  bucket_success_rates: Record<string, number>;

  /**
   * Sample density accuracy curve: maps sample_size index → observed accuracy.
   * Index i represents accuracy observed at sample_size = i.
   * Array length defines the maximum tracked sample size.
   */
  sample_density_curve: number[];

  /**
   * Global fallback parameters used when a specific regime or bucket
   * has fewer than MIN_EVALUATED_FORECASTS (30) evaluated forecasts.
   */
  global_fallback: {
    /** Base confidence score derived from global accuracy. */
    base_score: number;
    /** Global regime accuracy modifier. */
    regime_modifier: number;
    /** Global sample density modifier. */
    sample_modifier: number;
  };
}

/**
 * Output from the Confidence Engine v2.
 * Each contributing factor is individually bounded to [0.0, 1.0].
 * The final composed score is bounded to [0.0, 1.0] with 6 decimal places.
 *
 * Requirements: 11.5, 11.7
 */
export interface ConfidenceV2Output {
  /** Calibration-adjusted base score derived from bucket success rate. [0.0, 1.0] */
  calibration_adjusted_base: number;

  /** Regime-specific accuracy modifier. [0.0, 1.0] */
  regime_accuracy_modifier: number;

  /** Sample-density accuracy modifier from the density curve. [0.0, 1.0] */
  sample_density_modifier: number;

  /** Final composed confidence score. [0.0, 1.0], 6 decimal places. */
  confidence_final: number;

  /** Whether global fallback calibration was used due to insufficient data. */
  using_fallback: boolean;
}

// =============================================================================
// Validation
// =============================================================================

/**
 * Validate the confidence input for v2 computation.
 * Rejects if sample_size is 0 or any critical input is outside [0, 1].
 *
 * @param input - The confidence input metrics
 * @throws Error if input is invalid
 */
export function validateConfidenceV2Input(input: ConfidenceInput): void {
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

/**
 * Validate calibration parameters structure.
 *
 * @param params - The calibration parameters to validate
 * @throws Error if parameters are invalid
 */
export function validateCalibrationParameters(params: CalibrationParameters): void {
  if (!params.global_fallback) {
    throw new Error(
      "Cannot compute confidence: calibration parameters missing global_fallback",
    );
  }

  const { base_score, regime_modifier, sample_modifier } = params.global_fallback;

  if (base_score < 0 || base_score > 1) {
    throw new Error(
      `Cannot compute confidence: global_fallback.base_score (${base_score}) is outside valid range [0, 1]`,
    );
  }

  if (regime_modifier < 0 || regime_modifier > 1) {
    throw new Error(
      `Cannot compute confidence: global_fallback.regime_modifier (${regime_modifier}) is outside valid range [0, 1]`,
    );
  }

  if (sample_modifier < 0 || sample_modifier > 1) {
    throw new Error(
      `Cannot compute confidence: global_fallback.sample_modifier (${sample_modifier}) is outside valid range [0, 1]`,
    );
  }

  if (!Array.isArray(params.sample_density_curve)) {
    throw new Error(
      "Cannot compute confidence: calibration parameters missing sample_density_curve array",
    );
  }
}

// =============================================================================
// Core Pure Computation (exported for testability)
// =============================================================================

/**
 * Pure computation function: given a ConfidenceInput and frozen CalibrationParameters,
 * produce a ConfidenceV2Output.
 *
 * This is deterministic — identical inputs and calibration parameters always produce
 * identical outputs. Exported for direct unit testing without database dependencies.
 *
 * Computation steps:
 * 1. Determine the calibration bucket from the input's probability concentration
 * 2. Look up bucket success rate (or fall back to global if insufficient data)
 * 3. Look up regime-specific accuracy (or fall back to global)
 * 4. Look up sample-density accuracy from the density curve (or fall back to global)
 * 5. Compose final score via multiplicative composition: base × regime × density
 *
 * @param input - The confidence input metrics (same interface as v1)
 * @param calibration - Frozen calibration parameters loaded from engine_versions.config
 * @returns ConfidenceV2Output with named components and final score
 * @throws Error if input is invalid or calibration parameters are malformed
 */
export function computeConfidenceV2FromInput(
  input: ConfidenceInput,
  calibration: CalibrationParameters,
): ConfidenceV2Output {
  validateConfidenceV2Input(input);
  validateCalibrationParameters(calibration);

  let usingFallback = false;

  // -------------------------------------------------------------------------
  // 1. Calibration-Adjusted Base Score
  //    Derived from the bucket success rate for the input's confidence bucket.
  //    The bucket is determined by the raw probability concentration.
  // -------------------------------------------------------------------------
  const maxProb = Math.max(input.up_probability, input.down_probability, input.flat_probability);
  const bucketKey = getBucketKey(maxProb);

  let calibrationAdjustedBase: number;

  if (
    calibration.bucket_success_rates[bucketKey] !== undefined &&
    hasSufficientData(calibration, bucketKey)
  ) {
    calibrationAdjustedBase = calibration.bucket_success_rates[bucketKey];
  } else {
    calibrationAdjustedBase = calibration.global_fallback.base_score;
    usingFallback = true;
  }

  // -------------------------------------------------------------------------
  // 2. Regime Accuracy Modifier
  //    Derived from the observed accuracy for the dominant regime classification.
  // -------------------------------------------------------------------------
  const regimeKey = input.regime_metadata.dominant_regime;

  let regimeAccuracyModifier: number;

  if (
    calibration.regime_accuracy[regimeKey] !== undefined &&
    hasSufficientRegimeData(calibration, regimeKey)
  ) {
    regimeAccuracyModifier = calibration.regime_accuracy[regimeKey];
  } else {
    regimeAccuracyModifier = calibration.global_fallback.regime_modifier;
    usingFallback = true;
  }

  // -------------------------------------------------------------------------
  // 3. Sample Density Modifier
  //    Derived from the sample_density_curve at the input's sample_size index.
  //    Larger sample sizes generally yield higher accuracy.
  // -------------------------------------------------------------------------
  let sampleDensityModifier: number;

  const sampleIndex = Math.min(
    input.sample_size,
    calibration.sample_density_curve.length - 1,
  );

  if (
    calibration.sample_density_curve.length > 0 &&
    sampleIndex >= 0 &&
    input.sample_size >= MIN_EVALUATED_FORECASTS
  ) {
    sampleDensityModifier = calibration.sample_density_curve[sampleIndex];
  } else {
    sampleDensityModifier = calibration.global_fallback.sample_modifier;
    usingFallback = true;
  }

  // -------------------------------------------------------------------------
  // 4. Final Composition (multiplicative, same style as v1)
  //    C_final = base × regime × density, bounded [0.0, 1.0], 6 decimal places
  // -------------------------------------------------------------------------
  const rawFinal = calibrationAdjustedBase * regimeAccuracyModifier * sampleDensityModifier;
  const confidenceFinal = roundToDecimalPlaces(clamp(rawFinal, 0.0, 1.0), DECIMAL_PLACES);

  return {
    calibration_adjusted_base: clamp(calibrationAdjustedBase, 0.0, 1.0),
    regime_accuracy_modifier: clamp(regimeAccuracyModifier, 0.0, 1.0),
    sample_density_modifier: clamp(sampleDensityModifier, 0.0, 1.0),
    confidence_final: confidenceFinal,
    using_fallback: usingFallback,
  };
}

// =============================================================================
// Factory Function
// =============================================================================

/**
 * Database access interface for storing confidence v2 outputs.
 * Injected for testability — no database calls in the compute path.
 */
export interface ConfidenceV2Store {
  /**
   * Store the computed confidence v2 output alongside its corresponding forecast.
   */
  storeConfidenceV2(output: ConfidenceV2Output, fingerprintId: string): Promise<void>;
}

/**
 * Factory function that creates a confidence v2 compute function with frozen
 * calibration parameters. The parameters are loaded once at batch start from
 * the engine_versions.config field and remain immutable for the batch duration.
 *
 * Usage:
 *   const versionInfo = versionService.getVersionSnapshot()['confidence'];
 *   const calibration = versionInfo.config as unknown as CalibrationParameters;
 *   const computeV2 = createConfidenceV2Engine(calibration);
 *   const result = await computeV2(input, fingerprintId, store);
 *
 * @param calibration - Frozen calibration parameters from engine_versions.config
 * @returns An async function that computes and persists confidence v2 scores
 */
export function createConfidenceV2Engine(
  calibration: CalibrationParameters,
): (input: ConfidenceInput, fingerprintId: string, store: ConfidenceV2Store) => Promise<ConfidenceV2Output> {
  // Validate parameters at factory creation time (fail fast)
  validateCalibrationParameters(calibration);

  // Freeze the calibration parameters to prevent mutation during batch
  const frozenCalibration = Object.freeze(calibration);

  return async function computeConfidenceV2(
    input: ConfidenceInput,
    fingerprintId: string,
    store: ConfidenceV2Store,
  ): Promise<ConfidenceV2Output> {
    const output = computeConfidenceV2FromInput(input, frozenCalibration);

    await store.storeConfidenceV2(output, fingerprintId);

    return output;
  };
}

// =============================================================================
// Helper Functions
// =============================================================================

/**
 * Determine the calibration bucket key for a given probability value.
 * Buckets are 10 uniform ranges: [0.0-0.1), [0.1-0.2), ..., [0.9-1.0]
 *
 * @param probability - The max directional probability [0, 1]
 * @returns Bucket key string (e.g., "0.3-0.4")
 */
function getBucketKey(probability: number): string {
  const bucketIndex = Math.min(Math.floor(probability * 10), 9);
  const lower = (bucketIndex / 10).toFixed(1);
  const upper = ((bucketIndex + 1) / 10).toFixed(1);
  return `${lower}-${upper}`;
}

/**
 * Check whether a calibration bucket has sufficient data (≥30 forecasts).
 * This is determined by checking if the bucket key exists in the bucket_success_rates.
 * The presence of a bucket in the frozen parameters implies the evaluation dataset
 * had ≥30 forecasts for that bucket at calibration time.
 *
 * Note: The MIN_EVALUATED_FORECASTS threshold is enforced at calibration parameter
 * generation time — only buckets meeting the threshold are included in the frozen config.
 *
 * @param calibration - The calibration parameters
 * @param bucketKey - The bucket key to check
 * @returns true if the bucket has sufficient data
 */
function hasSufficientData(calibration: CalibrationParameters, bucketKey: string): boolean {
  return bucketKey in calibration.bucket_success_rates;
}

/**
 * Check whether a regime has sufficient data (≥30 forecasts).
 * Same logic as bucket check — presence in the frozen config implies sufficiency.
 *
 * @param calibration - The calibration parameters
 * @param regimeKey - The regime key to check
 * @returns true if the regime has sufficient data
 */
function hasSufficientRegimeData(calibration: CalibrationParameters, regimeKey: string): boolean {
  return regimeKey in calibration.regime_accuracy;
}

/**
 * Clamp a value to [min, max].
 *
 * @param value - The value to clamp
 * @param min - Minimum bound
 * @param max - Maximum bound
 * @returns Clamped value
 */
function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

/**
 * Round a number to a specified number of decimal places.
 *
 * @param value - The value to round
 * @param places - Number of decimal places
 * @returns Rounded value
 */
function roundToDecimalPlaces(value: number, places: number): number {
  const factor = Math.pow(10, places);
  return Math.round(value * factor) / factor;
}

// =============================================================================
// Engine Metadata
// =============================================================================

/**
 * Get the engine version identifier for confidence engine v2.
 *
 * @returns The version string "2.0.0"
 */
export function getEngineVersion(): string {
  return ENGINE_VERSION;
}

/**
 * Get the minimum number of evaluated forecasts required per grouping.
 *
 * @returns The threshold value (30)
 */
export function getMinEvaluatedForecasts(): number {
  return MIN_EVALUATED_FORECASTS;
}
