/**
 * Calibration Measurement Module — Phase 2: Calibration Analysis
 *
 * Provides calibration analysis over persisted EvaluationRecords in the
 * research_evaluations table. Measures whether stated confidence levels
 * match observed accuracy rates across 10 uniform calibration buckets.
 *
 * Requirements: 8.1, 8.2, 8.3, 8.4, 8.5, 8.6
 */

import type { SupabaseClient } from '@supabase/supabase-js';

/** Minimum number of forecasts required per bucket for statistical validity. */
const MIN_BUCKET_SAMPLE_SIZE = 10;

/** Number of uniform calibration buckets. */
const BUCKET_COUNT = 10;

/**
 * Filter options for calibration queries.
 * All fields are optional — omitting a field means no filtering on that dimension.
 */
export interface CalibrationFilter {
  asset?: string;
  timeframe?: string;
  regime?: string;
  engine_version?: string;
  date_range?: {
    start: string; // ISO-8601 UTC
    end: string;   // ISO-8601 UTC
  };
}

/**
 * Per-bucket calibration result.
 */
export interface CalibrationBucketResult {
  bucket_label: string;
  midpoint: number;
  observed_success_rate: number;
  forecast_count: number;
  calibration_accuracy: number;
  insufficient_sample: boolean;
}

/**
 * Overall calibration report with per-bucket results and aggregate score.
 */
export interface CalibrationReport {
  buckets: CalibrationBucketResult[];
  overall_calibration_score: number | null;
  total_forecasts: number;
  sufficient_buckets_count: number;
}

/**
 * Row shape returned from the joined research_evaluations + research_forecasts query.
 */
interface EvaluationRow {
  calibration_bucket: string;
  forecast_success: boolean;
}

/**
 * Generates the 10 uniform bucket labels and midpoints.
 */
function generateBucketDefinitions(): Array<{ label: string; midpoint: number }> {
  const buckets: Array<{ label: string; midpoint: number }> = [];
  for (let i = 0; i < BUCKET_COUNT; i++) {
    const start = (i / BUCKET_COUNT).toFixed(1);
    const end = ((i + 1) / BUCKET_COUNT).toFixed(1);
    const label = `${start}-${end}`;
    const midpoint = (i + 0.5) / BUCKET_COUNT;
    buckets.push({ label, midpoint });
  }
  return buckets;
}

/**
 * Computes a calibration report from evaluation data in the research_evaluations table.
 *
 * Queries research_evaluations (joined with research_forecasts for filter support),
 * groups by calibration_bucket, and computes per-bucket calibration accuracy and
 * an overall calibration score.
 *
 * @param supabase - Supabase client instance
 * @param filter - Optional filter criteria for narrowing the calibration analysis
 * @returns CalibrationReport with per-bucket results and overall score
 */
export async function computeCalibrationReport(
  supabase: SupabaseClient,
  filter?: CalibrationFilter,
): Promise<CalibrationReport> {
  // Build the query — join research_evaluations with research_forecasts for filtering
  let query = supabase
    .from('research_evaluations')
    .select(`
      calibration_bucket,
      forecast_success,
      research_forecasts!inner (
        asset,
        timeframe,
        regime,
        forecast_timestamp
      )
    `)
    .eq('status', 'evaluated');

  // Apply filters
  if (filter?.asset) {
    query = query.eq('research_forecasts.asset', filter.asset);
  }
  if (filter?.timeframe) {
    query = query.eq('research_forecasts.timeframe', filter.timeframe);
  }
  if (filter?.regime) {
    query = query.eq('research_forecasts.regime->>volatility_regime', filter.regime);
  }
  if (filter?.engine_version) {
    query = query.eq('engine_version', filter.engine_version);
  }
  if (filter?.date_range) {
    query = query.gte('research_forecasts.forecast_timestamp', filter.date_range.start);
    query = query.lte('research_forecasts.forecast_timestamp', filter.date_range.end);
  }

  const { data, error } = await query.returns<EvaluationRow[]>();

  if (error) {
    console.error(
      `[Calibration] Failed to query evaluation data: ${error.message}`,
    );
    return {
      buckets: generateBucketDefinitions().map((b) => ({
        bucket_label: b.label,
        midpoint: b.midpoint,
        observed_success_rate: 0,
        forecast_count: 0,
        calibration_accuracy: 0,
        insufficient_sample: true,
      })),
      overall_calibration_score: null,
      total_forecasts: 0,
      sufficient_buckets_count: 0,
    };
  }

  const rows = data ?? [];

  // Group rows by calibration_bucket
  const bucketGroups = new Map<string, { successCount: number; totalCount: number }>();

  for (const row of rows) {
    const existing = bucketGroups.get(row.calibration_bucket);
    if (existing) {
      existing.totalCount += 1;
      if (row.forecast_success) {
        existing.successCount += 1;
      }
    } else {
      bucketGroups.set(row.calibration_bucket, {
        successCount: row.forecast_success ? 1 : 0,
        totalCount: 1,
      });
    }
  }

  // Compute per-bucket results
  const bucketDefinitions = generateBucketDefinitions();
  const bucketResults: CalibrationBucketResult[] = [];
  let deviationSum = 0;
  let sufficientBucketsCount = 0;

  for (const def of bucketDefinitions) {
    const group = bucketGroups.get(def.label);
    const forecastCount = group?.totalCount ?? 0;
    const insufficientSample = forecastCount < MIN_BUCKET_SAMPLE_SIZE;

    let observedSuccessRate = 0;
    let calibrationAccuracy = 0;

    if (forecastCount > 0) {
      observedSuccessRate = (group?.successCount ?? 0) / forecastCount;
      calibrationAccuracy = Math.abs(def.midpoint - observedSuccessRate);
    }

    if (!insufficientSample) {
      deviationSum += calibrationAccuracy;
      sufficientBucketsCount += 1;
    }

    bucketResults.push({
      bucket_label: def.label,
      midpoint: def.midpoint,
      observed_success_rate: observedSuccessRate,
      forecast_count: forecastCount,
      calibration_accuracy: calibrationAccuracy,
      insufficient_sample: insufficientSample,
    });
  }

  // Compute overall calibration score: mean absolute deviation across sufficient buckets
  const overallCalibrationScore =
    sufficientBucketsCount > 0 ? deviationSum / sufficientBucketsCount : null;

  return {
    buckets: bucketResults,
    overall_calibration_score: overallCalibrationScore,
    total_forecasts: rows.length,
    sufficient_buckets_count: sufficientBucketsCount,
  };
}
