/**
 * Calibration Module Types
 *
 * Defines all TypeScript interfaces for the Continuous Learning Pipeline calibration system.
 * The calibration namespace analyses evaluated forecasts and generates parameter adjustment
 * recommendations for the deterministic engine parameters.
 *
 * Requirements: 3.2, 3.5, 6.6
 */

// =============================================================================
// Core Calibration Types
// =============================================================================

/**
 * Configuration for a calibration analysis run.
 */
export interface CalibrationRunConfig {
  trigger_reason: 'threshold' | 'schedule';
  evaluation_count: number;
  since_evaluation_id?: string;
}

/**
 * Result of a completed calibration analysis run.
 */
export interface CalibrationRunResult {
  run_id: string;
  started_at: string;
  completed_at: string | null;
  trigger_reason: 'threshold' | 'schedule';
  evaluation_count: number;
  status: 'completed' | 'partial' | 'failed';
  failed_stage?: string;
  error_detail?: string;
  recommendations_generated: number;
}

// =============================================================================
// Stage Contribution Types
// =============================================================================

/**
 * Per-stage contribution score for an evaluated forecast.
 * Contribution scores are bounded to [-1, 1] representing correlation with accuracy.
 */
export interface StageContribution {
  evaluation_id: string;
  batch_id: string;
  asset: string;
  regime: string;
  stage_name: string;
  contribution_score: number;           // [-1, 1] correlation with accuracy
  layer_dominant?: string;              // L1-L5, for similarity stage only
  marginal_accuracy_delta?: number;     // for macro/sentiment stages
  is_low_confidence: boolean;
  created_at: string;
}

// =============================================================================
// Regime Accuracy Types
// =============================================================================

/**
 * Direction accuracy result for a specific regime-asset-direction combination.
 */
export interface RegimeAccuracyResult {
  run_id: string;
  regime: string;
  asset: string;
  direction: 'up' | 'down' | 'flat';
  accuracy_pct: number;
  sample_count: number;
  is_significant: boolean;
  is_underperforming: boolean;
  accuracy_delta: number | null;
  created_at: string;
}

// =============================================================================
// Counterfactual Analysis Types
// =============================================================================

/**
 * Request for a counterfactual "what-if" parameter analysis.
 */
export interface CounterfactualRequest {
  parameter_name: 'FLAT_THRESHOLD' | 'TOPOLOGY_SIMILARITY_WEIGHT' | string;
  baseline_value: number;
  alternative_value: number;
}

/**
 * Result of a counterfactual analysis comparing baseline vs alternative parameter values.
 */
export interface CounterfactualResult {
  run_id: string;
  parameter_name: string;
  baseline_value: number;
  alternative_value: number;
  baseline_accuracy: number;
  alternative_accuracy: number;
  accuracy_delta: number;
  baseline_brier: number;
  alternative_brier: number;
  brier_delta: number;
  baseline_ece: number;
  alternative_ece: number;
  ece_delta: number;
  sample_size: number;
  created_at: string;
}

// =============================================================================
// Layer Signal Types
// =============================================================================

/**
 * Signal-to-noise measurement for a fingerprint layer within a regime-asset grouping.
 */
export interface LayerSignalResult {
  run_id: string;
  layer_name: string;
  regime: string;
  asset: string;
  correlation_coefficient: number;
  sample_size: number;
  classification: 'high-signal' | 'low-signal' | 'neutral';
  created_at: string;
}

// =============================================================================
// Calibration Monitoring Types
// =============================================================================

/**
 * Calibration measurement for a single confidence bucket.
 */
export interface BucketCalibration {
  bucket: string;
  nominal_midpoint: number;
  observed_accuracy: number;
  sample_count: number;
  is_miscalibrated: boolean;
}

/**
 * Calibration drift monitoring result over a rolling time window.
 */
export interface CalibrationDriftResult {
  run_id: string;
  window_start: string;
  window_end: string;
  buckets: BucketCalibration[];
  ece: number;
  miscalibrated_count: number;
  alert_severity: 'none' | 'low' | 'high';
  created_at: string;
}

// =============================================================================
// Recommendation Types
// =============================================================================

/**
 * A concrete, evidence-based parameter adjustment recommendation.
 */
export interface ParameterRecommendation {
  run_id: string;
  parameter_name: string;
  current_value: number;
  recommended_value: number;
  sample_size: number;
  projected_accuracy_improvement: number;
  confidence_level: 'low' | 'medium' | 'high';
  explanation: string;
  status: 'pending' | 'applied' | 'rejected';
  created_at: string;
}

// =============================================================================
// Validation Types
// =============================================================================

/**
 * Result of a validation check (e.g., parameter bounds, regime weight sum).
 */
export interface ValidationResult {
  valid: boolean;
  errors: string[];
}

// =============================================================================
// Supporting Data Types (used by analysis engines)
// =============================================================================

/**
 * An evaluated forecast enriched with regime, asset, and outcome context.
 * Used as input to the Stage Contribution Tracker and Regime Accuracy Analyser.
 */
export interface EvaluationWithContext {
  evaluation_id: string;
  batch_id: string;
  asset: string;
  regime: string;
  direction: 'up' | 'down' | 'flat';
  direction_accuracy: 0 | 1;
  confidence_final: number;
  brier_score: number;
  calibration_bucket: string;
  has_macro_data: boolean;
  has_sentiment_data: boolean;
  created_at: string;
}

/**
 * A similarity archive record with per-layer breakdown for signal analysis.
 * Used as input to the Signal-Noise Evaluator and Threshold Analyser.
 */
export interface SimilarityArchiveRecord {
  fingerprint_id: string;
  match_fingerprint_id: string;
  similarity_score: number;
  layer_breakdown: {
    market_structure: number;
    volatility: number;
    liquidity: number;
    macro: number;
    sentiment: number;
  };
  rank: number;
  batch_id: string;
  regime: string;
  asset: string;
  created_at: string;
}

/**
 * Extends a similarity archive record with the outcome accuracy of the matched forecast.
 * Used by the Threshold Analyser for counterfactual re-evaluation.
 */
export interface SimilarityArchiveWithOutcome extends SimilarityArchiveRecord {
  direction_accuracy: 0 | 1;
  confidence_final: number;
  brier_score: number;
}

/**
 * Basic evaluation record with confidence and direction accuracy.
 * Used by the Calibration Monitor for confidence calibration drift analysis.
 */
export interface EvaluationRecord {
  evaluation_id: string;
  direction_accuracy: 0 | 1;
  confidence_final: number;
  calibration_bucket: string;
  brier_score: number;
  created_at: string;
}
