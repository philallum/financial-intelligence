/**
 * Research Evaluation Types
 *
 * Defines interfaces for the Evaluation Engine which measures forecast accuracy
 * against realised market outcomes.
 *
 * Requirements: 7.1, 7.4, 7.8, 7.11
 */

import type { ResearchForecastRecord } from '../persistence/types.js';

/**
 * Input to the Evaluation Engine for a single matured forecast.
 */
export interface EvaluationInput {
  forecast: ResearchForecastRecord;
  realised_outcome: {
    net_return_pips: number;
    timestamp_utc: string;
  };
}

/**
 * A persisted, immutable evaluation record measuring forecast accuracy.
 * Contains all metrics needed for calibration analysis and longitudinal research.
 */
export interface EvaluationRecord {
  evaluation_id: string;
  forecast_id: string;
  outcome_id: string;
  batch_id: string;
  engine_version: string;
  direction_accuracy: 0 | 1;
  forecast_success: boolean;
  tradeability_success: boolean;
  expected_move_error: number;
  absolute_error: number;
  rmse_contribution: number;
  brier_score: number;
  confidence_calibration_score: number;
  calibration_bucket: string;
  created_at: string;
}

/**
 * Interface for the Evaluation Engine batch processor.
 */
export interface EvaluationEngine {
  evaluateMaturedForecasts(batchId: string): Promise<EvaluationRecord[]>;
}
