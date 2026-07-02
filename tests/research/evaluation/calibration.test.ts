/**
 * Unit tests for the Calibration Measurement module.
 *
 * Validates:
 * - 10 uniform bucket definitions with correct labels and midpoints
 * - Per-bucket calibration accuracy: |midpoint - observed_success_rate|
 * - Overall calibration score: mean absolute deviation across sufficient buckets
 * - Buckets with <10 forecasts flagged as insufficient sample
 * - Filter support: asset, timeframe, regime, engine_version, date_range
 * - Error handling when Supabase query fails
 *
 * Requirements: 8.1, 8.2, 8.3, 8.4, 8.5, 8.6
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { computeCalibrationReport } from '../../../src/research/evaluation/calibration.js';
import type { CalibrationFilter } from '../../../src/research/evaluation/calibration.js';

// =============================================================================
// Mock Supabase Client
// =============================================================================

function createMockSupabase(options: {
  data?: Array<{ calibration_bucket: string; forecast_success: boolean }>;
  error?: { message: string } | null;
}) {
  const chainMethods = {
    select: vi.fn().mockReturnThis(),
    eq: vi.fn().mockReturnThis(),
    gte: vi.fn().mockReturnThis(),
    lte: vi.fn().mockReturnThis(),
    returns: vi.fn().mockResolvedValue({
      data: options.data ?? [],
      error: options.error ?? null,
    }),
  };

  return {
    from: vi.fn(() => chainMethods),
    _chain: chainMethods,
  };
}

// =============================================================================
// Helper: Generate evaluation rows for a bucket
// =============================================================================

function generateBucketRows(
  bucketLabel: string,
  count: number,
  successRate: number,
): Array<{ calibration_bucket: string; forecast_success: boolean }> {
  const successCount = Math.round(count * successRate);
  const rows: Array<{ calibration_bucket: string; forecast_success: boolean }> = [];

  for (let i = 0; i < successCount; i++) {
    rows.push({ calibration_bucket: bucketLabel, forecast_success: true });
  }
  for (let i = 0; i < count - successCount; i++) {
    rows.push({ calibration_bucket: bucketLabel, forecast_success: false });
  }

  return rows;
}

// =============================================================================
// Tests
// =============================================================================

describe('computeCalibrationReport', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  describe('bucket definitions (Requirement 8.1, 8.4)', () => {
    it('returns exactly 10 buckets', async () => {
      const supabase = createMockSupabase({ data: [] });
      const report = await computeCalibrationReport(supabase as never);

      expect(report.buckets).toHaveLength(10);
    });

    it('has correct bucket labels for all 10 buckets', async () => {
      const supabase = createMockSupabase({ data: [] });
      const report = await computeCalibrationReport(supabase as never);

      const expectedLabels = [
        '0.0-0.1', '0.1-0.2', '0.2-0.3', '0.3-0.4', '0.4-0.5',
        '0.5-0.6', '0.6-0.7', '0.7-0.8', '0.8-0.9', '0.9-1.0',
      ];
      const actualLabels = report.buckets.map((b) => b.bucket_label);
      expect(actualLabels).toEqual(expectedLabels);
    });

    it('has correct midpoints: 0.05, 0.15, ..., 0.95', async () => {
      const supabase = createMockSupabase({ data: [] });
      const report = await computeCalibrationReport(supabase as never);

      const expectedMidpoints = [0.05, 0.15, 0.25, 0.35, 0.45, 0.55, 0.65, 0.75, 0.85, 0.95];
      const actualMidpoints = report.buckets.map((b) => b.midpoint);
      expect(actualMidpoints).toEqual(expectedMidpoints);
    });
  });

  describe('per-bucket calibration accuracy (Requirement 8.2)', () => {
    it('computes calibration_accuracy as |midpoint - observed_success_rate|', async () => {
      // Bucket 0.7-0.8 has midpoint 0.75, observed success rate 0.6
      // calibration_accuracy = |0.75 - 0.6| = 0.15
      const rows = generateBucketRows('0.7-0.8', 20, 0.6);
      const supabase = createMockSupabase({ data: rows });
      const report = await computeCalibrationReport(supabase as never);

      const bucket = report.buckets.find((b) => b.bucket_label === '0.7-0.8')!;
      expect(bucket.observed_success_rate).toBe(0.6);
      expect(bucket.calibration_accuracy).toBeCloseTo(0.15, 10);
    });

    it('perfect calibration yields accuracy = 0', async () => {
      // Bucket 0.5-0.6 has midpoint 0.55, observed success rate = 0.55
      // 11 successes out of 20 = 0.55
      const rows: Array<{ calibration_bucket: string; forecast_success: boolean }> = [];
      for (let i = 0; i < 11; i++) {
        rows.push({ calibration_bucket: '0.5-0.6', forecast_success: true });
      }
      for (let i = 0; i < 9; i++) {
        rows.push({ calibration_bucket: '0.5-0.6', forecast_success: false });
      }
      const supabase = createMockSupabase({ data: rows });
      const report = await computeCalibrationReport(supabase as never);

      const bucket = report.buckets.find((b) => b.bucket_label === '0.5-0.6')!;
      expect(bucket.observed_success_rate).toBe(0.55);
      expect(bucket.calibration_accuracy).toBeCloseTo(0.0, 10);
    });
  });

  describe('overall calibration score (Requirement 8.6)', () => {
    it('computes mean absolute deviation across sufficient buckets', async () => {
      // Two buckets with sufficient data:
      // Bucket 0.7-0.8: midpoint 0.75, success_rate 0.6 → deviation = 0.15
      // Bucket 0.3-0.4: midpoint 0.35, success_rate 0.5 → deviation = 0.15
      // Overall = (0.15 + 0.15) / 2 = 0.15
      const rows = [
        ...generateBucketRows('0.7-0.8', 20, 0.6),
        ...generateBucketRows('0.3-0.4', 20, 0.5),
      ];
      const supabase = createMockSupabase({ data: rows });
      const report = await computeCalibrationReport(supabase as never);

      expect(report.overall_calibration_score).toBeCloseTo(0.15, 10);
      expect(report.sufficient_buckets_count).toBe(2);
    });

    it('returns null when no buckets have sufficient samples', async () => {
      // Only 5 forecasts in one bucket (below threshold of 10)
      const rows = generateBucketRows('0.5-0.6', 5, 0.5);
      const supabase = createMockSupabase({ data: rows });
      const report = await computeCalibrationReport(supabase as never);

      expect(report.overall_calibration_score).toBeNull();
      expect(report.sufficient_buckets_count).toBe(0);
    });

    it('excludes insufficient buckets from overall score', async () => {
      // Bucket 0.7-0.8: 20 forecasts, success_rate 0.8 → deviation = |0.75 - 0.8| = 0.05
      // Bucket 0.2-0.3: 5 forecasts (insufficient) → excluded
      const rows = [
        ...generateBucketRows('0.7-0.8', 20, 0.8),
        ...generateBucketRows('0.2-0.3', 5, 0.2),
      ];
      const supabase = createMockSupabase({ data: rows });
      const report = await computeCalibrationReport(supabase as never);

      expect(report.overall_calibration_score).toBeCloseTo(0.05, 10);
      expect(report.sufficient_buckets_count).toBe(1);
    });
  });

  describe('insufficient sample flagging (Requirement 8.5)', () => {
    it('flags buckets with fewer than 10 forecasts', async () => {
      const rows = generateBucketRows('0.5-0.6', 9, 0.5);
      const supabase = createMockSupabase({ data: rows });
      const report = await computeCalibrationReport(supabase as never);

      const bucket = report.buckets.find((b) => b.bucket_label === '0.5-0.6')!;
      expect(bucket.insufficient_sample).toBe(true);
      expect(bucket.forecast_count).toBe(9);
    });

    it('does not flag buckets with exactly 10 forecasts', async () => {
      const rows = generateBucketRows('0.5-0.6', 10, 0.5);
      const supabase = createMockSupabase({ data: rows });
      const report = await computeCalibrationReport(supabase as never);

      const bucket = report.buckets.find((b) => b.bucket_label === '0.5-0.6')!;
      expect(bucket.insufficient_sample).toBe(false);
      expect(bucket.forecast_count).toBe(10);
    });

    it('flags empty buckets as insufficient', async () => {
      const supabase = createMockSupabase({ data: [] });
      const report = await computeCalibrationReport(supabase as never);

      for (const bucket of report.buckets) {
        expect(bucket.insufficient_sample).toBe(true);
        expect(bucket.forecast_count).toBe(0);
      }
    });
  });

  describe('filter support (Requirement 8.3)', () => {
    it('passes asset filter to query', async () => {
      const supabase = createMockSupabase({ data: [] });
      const filter: CalibrationFilter = { asset: 'EURUSD' };
      await computeCalibrationReport(supabase as never, filter);

      expect(supabase._chain.eq).toHaveBeenCalledWith('research_forecasts.asset', 'EURUSD');
    });

    it('passes timeframe filter to query', async () => {
      const supabase = createMockSupabase({ data: [] });
      const filter: CalibrationFilter = { timeframe: '4H' };
      await computeCalibrationReport(supabase as never, filter);

      expect(supabase._chain.eq).toHaveBeenCalledWith('research_forecasts.timeframe', '4H');
    });

    it('passes regime filter to query', async () => {
      const supabase = createMockSupabase({ data: [] });
      const filter: CalibrationFilter = { regime: 'high_volatility' };
      await computeCalibrationReport(supabase as never, filter);

      expect(supabase._chain.eq).toHaveBeenCalledWith(
        'research_forecasts.regime->>volatility_regime',
        'high_volatility',
      );
    });

    it('passes engine_version filter to query', async () => {
      const supabase = createMockSupabase({ data: [] });
      const filter: CalibrationFilter = { engine_version: '1.0.0' };
      await computeCalibrationReport(supabase as never, filter);

      expect(supabase._chain.eq).toHaveBeenCalledWith('engine_version', '1.0.0');
    });

    it('passes date_range filter to query', async () => {
      const supabase = createMockSupabase({ data: [] });
      const filter: CalibrationFilter = {
        date_range: {
          start: '2024-01-01T00:00:00Z',
          end: '2024-06-30T23:59:59Z',
        },
      };
      await computeCalibrationReport(supabase as never, filter);

      expect(supabase._chain.gte).toHaveBeenCalledWith(
        'research_forecasts.forecast_timestamp',
        '2024-01-01T00:00:00Z',
      );
      expect(supabase._chain.lte).toHaveBeenCalledWith(
        'research_forecasts.forecast_timestamp',
        '2024-06-30T23:59:59Z',
      );
    });

    it('applies no extra filters when filter is undefined', async () => {
      const supabase = createMockSupabase({ data: [] });
      await computeCalibrationReport(supabase as never);

      // Only the status eq('status', 'evaluated') should be called
      expect(supabase._chain.eq).toHaveBeenCalledTimes(1);
      expect(supabase._chain.eq).toHaveBeenCalledWith('status', 'evaluated');
    });
  });

  describe('error handling', () => {
    it('returns empty report with null score when query fails', async () => {
      const supabase = createMockSupabase({
        error: { message: 'Connection failed' },
      });
      const report = await computeCalibrationReport(supabase as never);

      expect(report.overall_calibration_score).toBeNull();
      expect(report.total_forecasts).toBe(0);
      expect(report.buckets).toHaveLength(10);
      for (const bucket of report.buckets) {
        expect(bucket.insufficient_sample).toBe(true);
      }
    });
  });

  describe('total_forecasts and report structure', () => {
    it('reports correct total_forecasts count', async () => {
      const rows = [
        ...generateBucketRows('0.5-0.6', 15, 0.5),
        ...generateBucketRows('0.7-0.8', 10, 0.7),
      ];
      const supabase = createMockSupabase({ data: rows });
      const report = await computeCalibrationReport(supabase as never);

      expect(report.total_forecasts).toBe(25);
    });
  });
});
