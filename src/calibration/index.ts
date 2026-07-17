/**
 * Calibration Namespace — Single Public Export Surface
 *
 * The calibration namespace groups all calibration-related functionality:
 * - types: Core interfaces for calibration analysis
 * - constants: Parameter bounds, regime types, asset types, layer names
 *
 * Dependency direction: calibration → research/engines/types (never reverse).
 * External consumers import exclusively from this barrel file.
 */

export type {
  CalibrationRunConfig,
  CalibrationRunResult,
  StageContribution,
  RegimeAccuracyResult,
  CounterfactualRequest,
  CounterfactualResult,
  LayerSignalResult,
  BucketCalibration,
  CalibrationDriftResult,
  ParameterRecommendation,
  ValidationResult,
  EvaluationWithContext,
  SimilarityArchiveRecord,
  SimilarityArchiveWithOutcome,
  EvaluationRecord,
} from './types.js';

export {
  PARAMETER_BOUNDS,
  CalibrationRegime,
  ALL_REGIMES,
  CalibrationAsset,
  ALL_ASSETS,
  LayerName,
  LAYER_DESCRIPTIONS,
  ALL_LAYERS,
  Direction,
  ALL_DIRECTIONS,
  LOW_CONFIDENCE_THRESHOLD,
  SIGNIFICANCE_THRESHOLD,
  UNDERPERFORMING_THRESHOLD,
  SIGNAL_NOISE_MIN_SAMPLE,
  LOW_SIGNAL_THRESHOLD,
  HIGH_SIGNAL_THRESHOLD,
  MISCALIBRATION_THRESHOLD,
  HIGH_SEVERITY_BUCKET_COUNT,
  ECE_HIGH_THRESHOLD,
  EVALUATION_TRIGGER_THRESHOLD,
  MAX_DAYS_BETWEEN_RUNS,
  DEFAULT_CALIBRATION_WINDOW_DAYS,
} from './constants.js';

export type { ParameterBounds } from './constants.js';

export {
  computeContributions,
  identifyDominantLayer,
  computeMarginalAccuracyDelta,
} from './stage-contribution-tracker.js';

export { computeRegimeAccuracy } from './regime-accuracy-analyser.js';
