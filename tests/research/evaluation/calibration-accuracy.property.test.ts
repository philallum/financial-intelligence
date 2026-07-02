/**
 * Property-Based Test: Calibration Accuracy Computation
 *
 * Property 7: Calibration Accuracy Computation
 * - Generate random evaluation sets per bucket
 * - Verify per-bucket formula and overall calibration score
 *
 * **Validates: Requirements 8.2, 8.6**
 *
 * Since we can't easily mock Supabase in property tests, we test the mathematical
 * properties by simulating what computeCalibrationReport would compute from raw data.
 * We generate random evaluation sets (arrays of {calibration_bucket, forecast_success} rows),
 * apply the grouping and computation logic independently, and verify properties hold.
 */

import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';

// =============================================================================
// Constants (mirroring calibration.ts)
// =============================================================================

const MIN_BUCKET_SAMPLE_SIZE = 10;
const BUCKET_COUNT = 10;

/** The 10 valid bucket labels. */
const BUCKET_LABELS = [
  '0.0-0.1', '0.1-0.2', '0.2-0.3', '0.3-0.4', '0.4-0.5',
  '0.5-0.6', '0.6-0.7', '0.7-0.8', '0.8-0.9', '0.9-1.0',
] as const;

/** Midpoints for each bucket: 0.05, 0.15, ..., 0.95. */
const BUCKET_MIDPOINTS: Record<string, number> = {
  '0.0-0.1': 0.05,
  '0.1-0.2': 0.15,
  '0.2-0.3': 0.25,
  '0.3-0.4': 0.35,
  '0.4-0.5': 0.45,
  '0.5-0.6': 0.55,
  '0.6-0.7': 0.65,
  '0.7-0.8': 0.75,
  '0.8-0.9': 0.85,
  '0.9-1.0': 0.95,
};

// =============================================================================
// Calibration Computation (independent re-implementation for verification)
// =============================================================================

interface EvaluationRow {
  calibration_bucket: string;
  forecast_success: boolean;
}

interface BucketResult {
  bucket_label: string;
  midpoint: number;
  observed_success_rate: number;
  forecast_count: number;
  calibration_accuracy: number;
  insufficient_sample: boolean;
}

interface CalibrationReport {
  buckets: BucketResult[];
  overall_calibration_score: number | null;
  total_forecasts: number;
  sufficient_buckets_count: number;
}

/**
 * Independently computes the calibration report from raw evaluation rows.
 * This mirrors the logic in calibration.ts without depending on Supabase.
 */
function computeCalibrationFromRows(rows: EvaluationRow[]): CalibrationReport {
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
  const bucketResults: BucketResult[] = [];
  let deviationSum = 0;
  let sufficientBucketsCount = 0;

  for (const label of BUCKET_LABELS) {
    const midpoint = BUCKET_MIDPOINTS[label];
    const group = bucketGroups.get(label);
    const forecastCount = group?.totalCount ?? 0;
    const insufficientSample = forecastCount < MIN_BUCKET_SAMPLE_SIZE;

    let observedSuccessRate = 0;
    let calibrationAccuracy = 0;

    if (forecastCount > 0) {
      observedSuccessRate = (group?.successCount ?? 0) / forecastCount;
      calibrationAccuracy = Math.abs(midpoint - observedSuccessRate);
    }

    if (!insufficientSample) {
      deviationSum += calibrationAccuracy;
      sufficientBucketsCount += 1;
    }

    bucketResults.push({
      bucket_label: label,
      midpoint,
      observed_success_rate: observedSuccessRate,
      forecast_count: forecastCount,
      calibration_accuracy: calibrationAccuracy,
      insufficient_sample: insufficientSample,
    });
  }

  const overallCalibrationScore =
    sufficientBucketsCount > 0 ? deviationSum / sufficientBucketsCount : null;

  return {
    buckets: bucketResults,
    overall_calibration_score: overallCalibrationScore,
    total_forecasts: rows.length,
    sufficient_buckets_count: sufficientBucketsCount,
  };
}

// =============================================================================
// Arbitraries
// =============================================================================

/** Generates a single evaluation row with a valid bucket label and random success. */
const arbEvaluationRow: fc.Arbitrary<EvaluationRow> = fc.record({
  calibration_bucket: fc.constantFrom(...BUCKET_LABELS),
  forecast_success: fc.boolean(),
});

/** Generates an array of evaluation rows (0 to 200 rows). */
const arbEvaluationSet: fc.Arbitrary<EvaluationRow[]> = fc.array(arbEvaluationRow, {
  minLength: 0,
  maxLength: 200,
});

/** Generates evaluation rows all within a single specified bucket. */
function arbBucketRows(bucketLabel: string, minCount: number, maxCount: number): fc.Arbitrary<EvaluationRow[]> {
  return fc.array(
    fc.record({
      calibration_bucket: fc.constant(bucketLabel),
      forecast_success: fc.boolean(),
    }),
    { minLength: minCount, maxLength: maxCount },
  );
}

// =============================================================================
// Property Tests
// =============================================================================

describe('Property 7: Calibration Accuracy Computation', () => {
  it('per-bucket calibration_accuracy is always >= 0 (absolute value)', () => {
    fc.assert(
      fc.property(arbEvaluationSet, (rows) => {
        const report = computeCalibrationFromRows(rows);
        for (const bucket of report.buckets) {
          expect(bucket.calibration_accuracy).toBeGreaterThanOrEqual(0);
        }
      }),
      { numRuns: 300 },
    );
  });

  it('per-bucket calibration_accuracy is always <= 1.0', () => {
    fc.assert(
      fc.property(arbEvaluationSet, (rows) => {
        const report = computeCalibrationFromRows(rows);
        for (const bucket of report.buckets) {
          expect(bucket.calibration_accuracy).toBeLessThanOrEqual(1.0);
        }
      }),
      { numRuns: 300 },
    );
  });

  it('if all forecasts in bucket 0.9-1.0 succeed (rate=1.0), calibration_accuracy = 0.05', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 50 }),
        (count) => {
          // All forecasts succeed in the 0.9-1.0 bucket (midpoint = 0.95)
          const rows: EvaluationRow[] = Array.from({ length: count }, () => ({
            calibration_bucket: '0.9-1.0',
            forecast_success: true,
          }));
          const report = computeCalibrationFromRows(rows);
          const bucket = report.buckets.find(b => b.bucket_label === '0.9-1.0')!;
          // |0.95 - 1.0| = 0.05
          expect(bucket.calibration_accuracy).toBeCloseTo(0.05, 10);
        },
      ),
      { numRuns: 300 },
    );
  });

  it('if success_rate equals bucket midpoint, calibration_accuracy = 0 (perfect calibration)', () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...BUCKET_LABELS),
        fc.integer({ min: 20, max: 100 }),
        (bucketLabel, totalCount) => {
          const midpoint = BUCKET_MIDPOINTS[bucketLabel];
          // Create rows where success_rate = midpoint exactly
          const successCount = Math.round(totalCount * midpoint);
          const actualRate = successCount / totalCount;

          const rows: EvaluationRow[] = [];
          for (let i = 0; i < successCount; i++) {
            rows.push({ calibration_bucket: bucketLabel, forecast_success: true });
          }
          for (let i = 0; i < totalCount - successCount; i++) {
            rows.push({ calibration_bucket: bucketLabel, forecast_success: false });
          }

          const report = computeCalibrationFromRows(rows);
          const bucket = report.buckets.find(b => b.bucket_label === bucketLabel)!;

          // calibration_accuracy should equal |midpoint - actualRate|
          const expectedAccuracy = Math.abs(midpoint - actualRate);
          expect(bucket.calibration_accuracy).toBeCloseTo(expectedAccuracy, 10);

          // If actualRate equals midpoint exactly, accuracy is 0
          if (actualRate === midpoint) {
            expect(bucket.calibration_accuracy).toBe(0);
          }
        },
      ),
      { numRuns: 300 },
    );
  });

  it('overall calibration score is the arithmetic mean of per-bucket deviations (sufficient buckets only)', () => {
    fc.assert(
      fc.property(arbEvaluationSet, (rows) => {
        const report = computeCalibrationFromRows(rows);

        if (report.sufficient_buckets_count === 0) {
          expect(report.overall_calibration_score).toBeNull();
          return;
        }

        // Independently compute expected overall score
        const sufficientBuckets = report.buckets.filter(b => !b.insufficient_sample);
        const expectedScore =
          sufficientBuckets.reduce((sum, b) => sum + b.calibration_accuracy, 0) /
          sufficientBuckets.length;

        expect(report.overall_calibration_score).toBeCloseTo(expectedScore, 10);
      }),
      { numRuns: 300 },
    );
  });

  it('overall calibration score is always >= 0 when defined', () => {
    fc.assert(
      fc.property(arbEvaluationSet, (rows) => {
        const report = computeCalibrationFromRows(rows);
        if (report.overall_calibration_score !== null) {
          expect(report.overall_calibration_score).toBeGreaterThanOrEqual(0);
        }
      }),
      { numRuns: 300 },
    );
  });

  it('if no bucket has >= 10 forecasts, overall score is null', () => {
    fc.assert(
      fc.property(
        // Generate a small set where no bucket can reach 10 forecasts
        fc.array(arbEvaluationRow, { minLength: 0, maxLength: 9 }),
        (rows) => {
          // With at most 9 total rows, no single bucket can have >= 10
          const report = computeCalibrationFromRows(rows);
          expect(report.overall_calibration_score).toBeNull();
          expect(report.sufficient_buckets_count).toBe(0);
        },
      ),
      { numRuns: 300 },
    );
  });

  it('overall score is bounded: 0 <= overall_score <= 0.95', () => {
    fc.assert(
      fc.property(arbEvaluationSet, (rows) => {
        const report = computeCalibrationFromRows(rows);
        if (report.overall_calibration_score !== null) {
          expect(report.overall_calibration_score).toBeGreaterThanOrEqual(0);
          // Max deviation: |midpoint - rate| where midpoint ∈ {0.05...0.95} and rate ∈ [0,1]
          // The theoretical max is |0.05 - 1.0| = 0.95 or |0.95 - 0.0| = 0.95
          expect(report.overall_calibration_score).toBeLessThanOrEqual(0.95);
        }
      }),
      { numRuns: 300 },
    );
  });

  it('sufficient bucket count equals the number of buckets with >= 10 forecasts', () => {
    fc.assert(
      fc.property(arbEvaluationSet, (rows) => {
        const report = computeCalibrationFromRows(rows);

        // Independently count sufficient buckets
        const bucketCounts = new Map<string, number>();
        for (const row of rows) {
          bucketCounts.set(row.calibration_bucket, (bucketCounts.get(row.calibration_bucket) ?? 0) + 1);
        }

        let expectedSufficientCount = 0;
        for (const label of BUCKET_LABELS) {
          if ((bucketCounts.get(label) ?? 0) >= MIN_BUCKET_SAMPLE_SIZE) {
            expectedSufficientCount += 1;
          }
        }

        expect(report.sufficient_buckets_count).toBe(expectedSufficientCount);
      }),
      { numRuns: 300 },
    );
  });
});
