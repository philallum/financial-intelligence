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
 * Row shape for a matured forecast from research_forecasts.
 */
interface MaturedForecast {
  id: string;
  batch_id: string;
  fingerprint_id: string;
  forecast_expiry: string;
  direction_probabilities: { up: number; down: number; flat: number };
  expected_move_pips: number;
  confidence_final: number;
}

/**
 * Row shape returned from market_outcomes lookup.
 */
interface OutcomeRow {
  outcome_id: string;
  fingerprint_id: string;
  net_return_pips: number;
  timestamp_utc: string;
}

/**
 * Combined forecast + outcome for processing.
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
 * yet been evaluated, then separately queries market_outcomes for matching
 * fingerprint_ids, joins them in application code, computes all accuracy metrics
 * deterministically, and persists EvaluationRecords to the research_evaluations table.
 */
export function createEvaluationEngine(supabase: SupabaseClient): EvaluationEngine {
  return {
    async evaluateMaturedForecasts(batchId: string): Promise<EvaluationRecord[]> {
      // 1. First, get all already-evaluated forecast IDs to exclude them
      const { data: evaluatedRows, error: evalLookupError } = await supabase
        .from('research_evaluations')
        .select('forecast_id');

      if (evalLookupError) {
        console.error(
          `[EvaluationEngine] Failed to query existing evaluations: ${evalLookupError.message}`,
        );
        return [];
      }

      const evaluatedIds = new Set((evaluatedRows ?? []).map((r: { forecast_id: string }) => r.forecast_id));

      // 2. Query all matured forecasts
      // Deterministic ordering by fingerprint_id ensures reproducible evaluation order (Req 2.6)
      let forecastQuery = supabase
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
        .order('fingerprint_id', { ascending: true });

      // If there are already-evaluated IDs, exclude them
      if (evaluatedIds.size > 0) {
        const idArray = [...evaluatedIds];
        forecastQuery = forecastQuery.not('id', 'in', `(${idArray.join(',')})`);
      }

      const { data: allMaturedForecasts, error: queryError } = await forecastQuery
        .returns<MaturedForecast[]>();

      if (queryError) {
        console.error(
          `[EvaluationEngine] Failed to query matured forecasts: ${queryError.message}`,
        );
        return [];
      }

      if (!allMaturedForecasts || allMaturedForecasts.length === 0) {
        console.log(`[EvaluationEngine] No matured forecasts to evaluate — batch_id=${batchId}`);
        return [];
      }

      // 2. Query matching outcomes from market_outcomes using fingerprint_ids
      const fingerprintIds = [...new Set(allMaturedForecasts.map(f => f.fingerprint_id))];
      const { data: outcomes, error: outcomeError } = await supabase
        .from('market_outcomes')
        .select('outcome_id, fingerprint_id, net_return_pips, timestamp_utc')
        .in('fingerprint_id', fingerprintIds)
        .returns<OutcomeRow[]>();

      if (outcomeError) {
        console.warn(
          `[EvaluationEngine] Failed to query market_outcomes: ${outcomeError.message}`,
        );
      }

      // 3. Build a lookup map: fingerprint_id → outcome
      const outcomeMap = new Map<string, OutcomeRow>();
      if (outcomes) {
        for (const outcome of outcomes) {
          outcomeMap.set(outcome.fingerprint_id, outcome);
        }
      }

      // 4. Separate forecasts into those with outcomes and those without
      const forecastsWithOutcome: ForecastWithOutcome[] = [];
      const forecastsWithoutOutcome: MaturedForecast[] = [];

      for (const forecast of allMaturedForecasts) {
        const outcome = outcomeMap.get(forecast.fingerprint_id);
        if (outcome) {
          forecastsWithOutcome.push({
            ...forecast,
            market_outcomes: {
              outcome_id: outcome.outcome_id,
              net_return_pips: outcome.net_return_pips,
              timestamp_utc: outcome.timestamp_utc,
            },
          });
        } else {
          forecastsWithoutOutcome.push(forecast);
        }
      }

      const evaluationRecords: EvaluationRecord[] = [];

      // 5. Process forecasts that have matched outcomes
      if (forecastsWithOutcome.length > 0) {
        for (const forecast of forecastsWithOutcome) {
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

      // 6. Handle forecasts that have timed out (no outcome after 8h)
      if (forecastsWithoutOutcome.length > 0) {
        const now = new Date();

        for (const forecast of forecastsWithoutOutcome) {

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

      // 7. Persist evaluation records
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
