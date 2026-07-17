/**
 * Test data factory functions for the Continuous Learning Pipeline calibration tests.
 * Each factory returns a valid default object that can be partially overridden.
 */
import type {
  LayerBreakdown,
  CombinedRegime,
  Asset,
  Direction,
  EvaluationRecord,
  RegimeWeightVector,
} from './arbitraries.js';

// --- Additional interfaces for factory output types ---

export interface StageContribution {
  evaluation_id: string;
  batch_id: string;
  asset: Asset;
  regime: CombinedRegime;
  stage_name: string;
  contribution_score: number;
  layer_dominant?: string;
  marginal_accuracy_delta?: number;
  is_low_confidence: boolean;
  created_at: string;
}

export interface SimilarityArchiveRecord {
  id: string;
  fingerprint_id: string;
  asset: Asset;
  regime: CombinedRegime;
  layer_breakdown: LayerBreakdown;
  composite_similarity: number;
  direction_actual: Direction;
  direction_accuracy: 0 | 1;
  created_at: string;
}

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

export interface LayerSignalResult {
  run_id: string;
  layer_name: string;
  regime: CombinedRegime;
  asset: Asset;
  correlation_coefficient: number;
  sample_size: number;
  classification: 'high-signal' | 'low-signal' | 'neutral';
  created_at: string;
}

export interface BucketCalibration {
  bucket: string;
  nominal_midpoint: number;
  observed_accuracy: number;
  sample_count: number;
  is_miscalibrated: boolean;
}

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

// --- Factory Functions ---

/**
 * Creates a default EvaluationRecord with optional overrides.
 */
export function createEvaluation(overrides?: Partial<EvaluationRecord>): EvaluationRecord {
  const predicted = overrides?.direction_predicted ?? 'up';
  const actual = overrides?.direction_actual ?? 'up';
  return {
    id: '00000000-0000-4000-a000-000000000001',
    asset: 'EURUSD',
    regime: 'NORMAL_BULLISH',
    direction_predicted: predicted,
    direction_actual: actual,
    direction_accuracy: (predicted === actual ? 1 : 0) as 0 | 1,
    confidence: 0.75,
    created_at: '2024-06-15T08:00:00.000Z',
    ...overrides,
  };
}

/**
 * Creates a default StageContribution with optional overrides.
 */
export function createStageContribution(overrides?: Partial<StageContribution>): StageContribution {
  return {
    evaluation_id: '00000000-0000-4000-a000-000000000001',
    batch_id: '00000000-0000-4000-b000-000000000001',
    asset: 'EURUSD',
    regime: 'NORMAL_BULLISH',
    stage_name: 'similarity',
    contribution_score: 0.5,
    is_low_confidence: false,
    created_at: '2024-06-15T08:00:00.000Z',
    ...overrides,
  };
}

/**
 * Creates a default SimilarityArchiveRecord with a complete layer_breakdown.
 */
export function createSimilarityArchiveRecord(
  overrides?: Partial<SimilarityArchiveRecord>,
): SimilarityArchiveRecord {
  return {
    id: '00000000-0000-4000-c000-000000000001',
    fingerprint_id: '00000000-0000-4000-d000-000000000001',
    asset: 'EURUSD',
    regime: 'NORMAL_BULLISH',
    layer_breakdown: {
      market_structure: 0.8,
      volatility: 0.6,
      liquidity: 0.7,
      macro: 0.5,
      sentiment: 0.4,
    },
    composite_similarity: 0.72,
    direction_actual: 'up',
    direction_accuracy: 1,
    created_at: '2024-06-15T08:00:00.000Z',
    ...overrides,
  };
}

/**
 * Creates a default CalibrationRunResult with optional overrides.
 */
export function createCalibrationRunResult(
  overrides?: Partial<CalibrationRunResult>,
): CalibrationRunResult {
  return {
    run_id: '00000000-0000-4000-e000-000000000001',
    started_at: '2024-06-15T03:00:00.000Z',
    completed_at: '2024-06-15T03:05:00.000Z',
    trigger_reason: 'schedule',
    evaluation_count: 75,
    status: 'completed',
    recommendations_generated: 3,
    ...overrides,
  };
}

/**
 * Creates a default CounterfactualResult with optional overrides.
 */
export function createCounterfactualResult(
  overrides?: Partial<CounterfactualResult>,
): CounterfactualResult {
  return {
    run_id: '00000000-0000-4000-e000-000000000001',
    parameter_name: 'FLAT_THRESHOLD',
    baseline_value: 2.5,
    alternative_value: 3.0,
    baseline_accuracy: 62.5,
    alternative_accuracy: 65.0,
    accuracy_delta: 2.5,
    baseline_brier: 0.25,
    alternative_brier: 0.22,
    brier_delta: -0.03,
    baseline_ece: 0.08,
    alternative_ece: 0.06,
    ece_delta: -0.02,
    sample_size: 120,
    created_at: '2024-06-15T03:02:00.000Z',
    ...overrides,
  };
}

/**
 * Creates a default LayerSignalResult with optional overrides.
 */
export function createLayerSignalResult(
  overrides?: Partial<LayerSignalResult>,
): LayerSignalResult {
  return {
    run_id: '00000000-0000-4000-e000-000000000001',
    layer_name: 'L1',
    regime: 'NORMAL_BULLISH',
    asset: 'EURUSD',
    correlation_coefficient: 0.35,
    sample_size: 80,
    classification: 'high-signal',
    created_at: '2024-06-15T03:03:00.000Z',
    ...overrides,
  };
}

/**
 * Creates a default BucketCalibration with optional overrides.
 */
export function createBucketCalibration(
  overrides?: Partial<BucketCalibration>,
): BucketCalibration {
  return {
    bucket: '0.7-0.8',
    nominal_midpoint: 0.75,
    observed_accuracy: 0.72,
    sample_count: 45,
    is_miscalibrated: false,
    ...overrides,
  };
}

/**
 * Creates a default ParameterRecommendation with optional overrides.
 */
export function createParameterRecommendation(
  overrides?: Partial<ParameterRecommendation>,
): ParameterRecommendation {
  return {
    run_id: '00000000-0000-4000-e000-000000000001',
    parameter_name: 'FLAT_THRESHOLD',
    current_value: 2.5,
    recommended_value: 3.0,
    sample_size: 120,
    projected_accuracy_improvement: 2.5,
    confidence_level: 'high',
    explanation: 'Increasing FLAT_THRESHOLD from 2.5 to 3.0 showed +2.5pp accuracy improvement across 120 samples in counterfactual analysis.',
    status: 'pending',
    created_at: '2024-06-15T03:05:00.000Z',
    ...overrides,
  };
}
