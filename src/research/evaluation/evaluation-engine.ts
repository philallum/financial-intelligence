/**
 * Evaluation Engine — Phase 2: Forecast Accuracy Measurement
 *
 * Evaluates matured forecasts against realised market outcomes, computing
 * direction accuracy, move error, Brier score, calibration metrics, and
 * tradeability success.
 *
 * Deterministic: identical forecast + outcome inputs always produce identical
 * evaluation records.
 *
 * Requirements: 7.1, 7.2, 7.3, 7.4, 7.5, 7.6, 7.7, 7.8, 7.9, 7.10, 7.11
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { FLAT_THRESHOLD } from '../../config/constants.js';
import type { EvaluationRecord, EvaluationEngine } from './types.js';

/** Engine version for this evaluation implementation. */
const ENGINE_VERSION = '1.0.0';

/** Number of batch cycles (each 4h) after which missing outcomes are abandoned. */
const MAX_CYCLES_WITHOUT_OUTCOME = 2;

/** Hours per batch cycle. */
const HOURS_PER_CYCLE = 4;

/** Maximum hours to wait for an outcome before marking unavailable. */
const OUTCOME_TIMEOUT_HOURS = MAX_CYCLES_WITHOUT_OUTCOME * HOURS_PER_CYCLE; // 8h

export type Direction = 'up' | 'down' | 'flat';

/**
 * Derive realised direction from net_return_pips using FLAT_THRESHOLD.
 * > FLAT_THRESHOLD → 'up', < -FLAT_THRESHOLD → 'down', otherwise 'flat'.
 */
export function deriveRealisedDirection(netReturnPips: number): Direction {
  if (netReturnPips > FLAT_THRESHOLD) return 'up';
  if (netReturnPips < -FLAT_THRESHOLD) return 'down';
  return 'flat';
}

/**
 * Determine predicted direction from direction_probabilities.
 * Returns the direction with the highest probability.
 * Ties broken deterministically: up > down > flat.
 */
export function derivePredictedDirection(probs: { up: number; down: number; flat: number }): Direction {
  if (probs.up >= probs.down && probs.up >= probs.flat) return 'up';
  if (probs.down >= probs.flat) return 'down';
  return 'flat';
}

/**
 * Compute Brier score: mean squared error between predicted probability vector
 * and one-hot realised direction vector.
 */
export function computeBrierScore(
  probs: { up: number; down: number; flat: number },
  realisedDirection: Direction,
): number {
  const oneHot = { up: 0, down: 0, flat: 0 };
  oneHot[realisedDirection] = 1;

  const squaredErrors =
    (probs.up - oneHot.up) ** 2 +
    (probs.down - oneHot.down) ** 2 +
    (probs.flat - oneHot.flat) ** 2;

  // Mean across 3 categories
  return squaredErrors / 3;
}

/**
 * Compute calibration bucket from confidence_final.
 * Uses floor(confidence_final * 10) / 10 to determine bucket start.
 * Returns string like "0.0-0.1", "0.1-0.2", ... "0.9-1.0".
 */
export function computeCalibrationBucket(confidenceFinal: number): string {
  const bucketStart = Math.floor(confidenceFinal * 10) / 10;
  const bucketEnd = Math.round((bucketStart + 0.1) * 10) / 10;
  return `${bucketStart.toFixed(1)}-${bucketEnd.toFixed(1)}`;
}

/**
 * Row shape returned from the research_forecasts + market_outcomes query.
 */
interface ForecastWithOutcome {
  id: string;
  batch_id: string;
  fingerprint_id: string;
  forecast_expiry: string;
  direction_probabilities: { up: number; down: number; flat: number };
  expected_move_pips: number;
  confidence_final: number;
  market_outcomes: {
    outcome_id: string;
    net_return_pips: number;
    timestamp_utc: string;
  } | null;
}

/**
 * Creates an EvaluationEngine backed by a Supabase client.
 *
 * The engine queries matured forecasts (forecast_expiry < NOW()) that have not
 * yet been evaluated, joins against market_outcomes for the realised return,
 * computes all accuracy metrics deterministically, and persists EvaluationRecords
 * to the research_evaluations table.
 */
export function createEvaluationEngine(supabase: SupabaseClient): EvaluationEngine {
  return {
    async evaluateMaturedForecasts(batchId: string): Promise<EvaluationRecord[]> {
      // 1. Query matured forecasts that haven't been evaluated yet
      // Deterministic ordering by fingerprint_id ensures reproducible evaluation order (Req 2.6)
      const { data: maturedForecasts, error: queryError } = await supabase
        .from('research_forecasts')
        .select(`
          id,
          batch_id,
          fingerprint_id,
          forecast_expiry,
          direction_probabilities,
          expected_move_pips,
          confidence_final,
          market_outcomes!inner (
            outcome_id,
            net_return_pips,
            timestamp_utc
          )
        `)
        .lt('forecast_expiry', new Date().toISOString())
        .not('id', 'in', supabase
          .from('research_evaluations')
          .select('forecast_id'))
        .order('fingerprint_id', { ascending: true })
        .returns<ForecastWithOutcome[]>();

      // Also query forecasts without outcomes (for timeout marking)
      // Deterministic ordering by fingerprint_id (Req 2.6)
      const { data: forecastsWithoutOutcome, error: noOutcomeError } = await supabase
        .from('research_forecasts')
        .select(`
          id,
          batch_id,
          fingerprint_id,
          forecast_expiry,
          direction_probabilities,
          expected_move_pips,
          confidence_final
        `)
        .lt('forecast_expiry', new Date().toISOString())
        .not('id', 'in', supabase
          .from('research_evaluations')
          .select('forecast_id'))
        .order('fingerprint_id', { ascending: true });

      if (queryError) {
        console.error(
          `[EvaluationEngine] Failed to query matured forecasts: ${queryError.message}`,
        );
        return [];
      }

      const evaluationRecords: EvaluationRecord[] = [];

      // 2. Process forecasts that have matched outcomes
      if (maturedForecasts && maturedForecasts.length > 0) {
        for (const forecast of maturedForecasts) {
          if (!forecast.market_outcomes) continue;

          const outcome = forecast.market_outcomes;
          const netReturnPips = outcome.net_return_pips;

          // Compute metrics
          const realisedDirection = deriveRealisedDirection(netReturnPips);
          const predictedDirection = derivePredictedDirection(forecast.direction_probabilities);

          const directionAccuracy: 0 | 1 = predictedDirection === realisedDirection ? 1 : 0;
          const expectedMoveError = forecast.expected_move_pips - netReturnPips;
          const absoluteError = Math.abs(expectedMoveError);
          const rmseContribution = expectedMoveError ** 2;
          const brierScore = computeBrierScore(forecast.direction_probabilities, realisedDirection);
          const confidenceCalibrationScore = forecast.confidence_final - directionAccuracy;
          const forecastSuccess = predictedDirection === realisedDirection;
          const tradeabilitySuccess =
            forecastSuccess && absoluteError <= 0.5 * Math.abs(netReturnPips);
          const calibrationBucket = computeCalibrationBucket(forecast.confidence_final);

          const record: EvaluationRecord = {
            evaluation_id: crypto.randomUUID(),
            forecast_id: forecast.id,
            outcome_id: outcome.outcome_id,
            batch_id: batchId,
            engine_version: ENGINE_VERSION,
            direction_accuracy: directionAccuracy,
            forecast_success: forecastSuccess,
            tradeability_success: tradeabilitySuccess,
            expected_move_error: Math.round(expectedMoveError * 100) / 100,
            absolute_error: Math.round(absoluteError * 100) / 100,
            rmse_contribution: Math.round(rmseContribution * 10000) / 10000,
            brier_score: Math.round(brierScore * 1000000) / 1000000,
            confidence_calibration_score:
              Math.round(confidenceCalibrationScore * 1000000) / 1000000,
            calibration_bucket: calibrationBucket,
            created_at: new Date().toISOString(),
          };

          evaluationRecords.push(record);
        }
      }

      // 3. Handle forecasts that have timed out (no outcome after 8h)
      if (!noOutcomeError && forecastsWithoutOutcome) {
        const now = new Date();

        for (const forecast of forecastsWithoutOutcome) {
          // Skip forecasts already handled with outcomes above
          if (maturedForecasts?.some((f) => f.id === forecast.id)) continue;

          const expiryDate = new Date(forecast.forecast_expiry);
          const hoursSinceExpiry =
            (now.getTime() - expiryDate.getTime()) / (1000 * 60 * 60);

          if (hoursSinceExpiry >= OUTCOME_TIMEOUT_HOURS) {
            // Mark as outcome_unavailable — persist a minimal record with status
            const { error: markError } = await supabase
              .from('research_evaluations')
              .insert({
                forecast_id: forecast.id,
                outcome_id: null,
                batch_id: batchId,
                engine_version: ENGINE_VERSION,
                direction_accuracy: 0,
                forecast_success: false,
                tradeability_success: false,
                expected_move_error: 0,
                absolute_error: 0,
                rmse_contribution: 0,
                brier_score: 0,
                confidence_calibration_score: 0,
                calibration_bucket: computeCalibrationBucket(forecast.confidence_final),
                status: 'outcome_unavailable',
                created_at: new Date().toISOString(),
              });

            if (markError) {
              console.warn(
                `[EvaluationEngine] Failed to mark forecast as outcome_unavailable — forecast_id=${forecast.id}: ${markError.message}`,
              );
            }
          }
        }
      }

      // 4. Persist evaluation records
      if (evaluationRecords.length > 0) {
        const rows = evaluationRecords.map((r) => ({
          forecast_id: r.forecast_id,
          outcome_id: r.outcome_id,
          batch_id: r.batch_id,
          engine_version: r.engine_version,
          direction_accuracy: r.direction_accuracy,
          forecast_success: r.forecast_success,
          tradeability_success: r.tradeability_success,
          expected_move_error: r.expected_move_error,
          absolute_error: r.absolute_error,
          rmse_contribution: r.rmse_contribution,
          brier_score: r.brier_score,
          confidence_calibration_score: r.confidence_calibration_score,
          calibration_bucket: r.calibration_bucket,
          status: 'evaluated',
          created_at: r.created_at,
        }));

        const { error: insertError } = await supabase
          .from('research_evaluations')
          .insert(rows);

        if (insertError) {
          // Handle duplicate key conflicts gracefully
          if (insertError.code === '23505') {
            console.warn(
              `[EvaluationEngine] Some evaluation records already exist (duplicate key) — batch_id=${batchId}`,
            );
          } else {
            console.error(
              `[EvaluationEngine] Failed to persist evaluation records — batch_id=${batchId}: ${insertError.message}`,
            );
          }
        }
      }

      console.log(
        `[EvaluationEngine] Evaluated ${evaluationRecords.length} matured forecasts — batch_id=${batchId}`,
      );

      return evaluationRecords;
    },
  };
}
