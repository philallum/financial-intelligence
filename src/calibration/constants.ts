/**
 * Calibration Module Constants
 *
 * Defines parameter bounds, regime types, asset identifiers, and layer names
 * used throughout the calibration analysis system.
 *
 * Requirements: 3.2, 3.5, 6.6
 */

// =============================================================================
// Parameter Validation Bounds
// =============================================================================

/**
 * Bounds for all tuneable parameters subject to calibration recommendations.
 * No recommendation may exceed these bounds.
 */
export const PARAMETER_BOUNDS = {
  FLAT_THRESHOLD: { min: 1, max: 5 },
  TOPOLOGY_SIMILARITY_WEIGHT: { min: 0.0, max: 0.30 },
  REGIME_WEIGHT_VALUE: { min: 0.0, max: 1.0 },
  REGIME_WEIGHT_SUM: { target: 1.0, tolerance: 0.001 },
} as const;

export type ParameterBounds = typeof PARAMETER_BOUNDS;

// =============================================================================
// Regime Types
// =============================================================================

/**
 * The 9 combined regime types: VolatilityRegime × TrendRegime.
 * LOW/NORMAL/HIGH × BULLISH/BEARISH/RANGING.
 */
export const CalibrationRegime = {
  LOW_BULLISH: 'LOW_BULLISH',
  LOW_BEARISH: 'LOW_BEARISH',
  LOW_RANGING: 'LOW_RANGING',
  NORMAL_BULLISH: 'NORMAL_BULLISH',
  NORMAL_BEARISH: 'NORMAL_BEARISH',
  NORMAL_RANGING: 'NORMAL_RANGING',
  HIGH_BULLISH: 'HIGH_BULLISH',
  HIGH_BEARISH: 'HIGH_BEARISH',
  HIGH_RANGING: 'HIGH_RANGING',
} as const;

export type CalibrationRegime =
  (typeof CalibrationRegime)[keyof typeof CalibrationRegime];

/**
 * All regime values as an array for iteration.
 */
export const ALL_REGIMES: readonly CalibrationRegime[] = Object.values(CalibrationRegime);

// =============================================================================
// Asset Types
// =============================================================================

/**
 * Supported asset pairs for calibration analysis.
 */
export const CalibrationAsset = {
  EURUSD: 'EURUSD',
  GBPUSD: 'GBPUSD',
} as const;

export type CalibrationAsset =
  (typeof CalibrationAsset)[keyof typeof CalibrationAsset];

/**
 * All asset values as an array for iteration.
 */
export const ALL_ASSETS: readonly CalibrationAsset[] = Object.values(CalibrationAsset);

// =============================================================================
// Layer Names
// =============================================================================

/**
 * The 5 fingerprint state layers used in similarity scoring.
 */
export const LayerName = {
  L1: 'L1',
  L2: 'L2',
  L3: 'L3',
  L4: 'L4',
  L5: 'L5',
} as const;

export type LayerName = (typeof LayerName)[keyof typeof LayerName];

/**
 * Human-readable layer descriptions for reporting.
 */
export const LAYER_DESCRIPTIONS: Record<LayerName, string> = {
  L1: 'market_structure',
  L2: 'volatility',
  L3: 'liquidity',
  L4: 'macro',
  L5: 'sentiment',
} as const;

/**
 * All layer names as an array for iteration.
 */
export const ALL_LAYERS: readonly LayerName[] = Object.values(LayerName);

// =============================================================================
// Direction Types
// =============================================================================

/**
 * Forecast direction values used in accuracy analysis.
 */
export const Direction = {
  UP: 'up',
  DOWN: 'down',
  FLAT: 'flat',
} as const;

export type Direction = (typeof Direction)[keyof typeof Direction];

/**
 * All direction values as an array for iteration.
 */
export const ALL_DIRECTIONS: readonly Direction[] = Object.values(Direction);

// =============================================================================
// Calibration Thresholds
// =============================================================================

/**
 * Threshold for marking contribution results as low-confidence.
 * Fewer than this many evaluations per (asset, regime) marks results as low-confidence.
 */
export const LOW_CONFIDENCE_THRESHOLD = 10;

/**
 * Minimum sample size for statistical significance in regime accuracy.
 */
export const SIGNIFICANCE_THRESHOLD = 30;

/**
 * Accuracy percentage below which a regime-asset combination is underperforming.
 */
export const UNDERPERFORMING_THRESHOLD = 40;

/**
 * Minimum sample size for signal-noise evaluation per grouping.
 */
export const SIGNAL_NOISE_MIN_SAMPLE = 50;

/**
 * Correlation threshold below which a layer is classified as low-signal.
 */
export const LOW_SIGNAL_THRESHOLD = 0.05;

/**
 * Correlation threshold above which a layer is classified as high-signal.
 */
export const HIGH_SIGNAL_THRESHOLD = 0.20;

/**
 * Confidence bucket miscalibration threshold (absolute difference).
 */
export const MISCALIBRATION_THRESHOLD = 0.15;

/**
 * Number of miscalibrated buckets triggering a high-severity alert.
 */
export const HIGH_SEVERITY_BUCKET_COUNT = 3;

/**
 * ECE threshold above which the confidence system requires recalibration.
 */
export const ECE_HIGH_THRESHOLD = 0.10;

/**
 * Number of new evaluations required to trigger a threshold-based calibration run.
 */
export const EVALUATION_TRIGGER_THRESHOLD = 50;

/**
 * Maximum days between calibration runs (schedule-based trigger).
 */
export const MAX_DAYS_BETWEEN_RUNS = 7;

/**
 * Default rolling window for calibration monitoring (days).
 */
export const DEFAULT_CALIBRATION_WINDOW_DAYS = 30;
