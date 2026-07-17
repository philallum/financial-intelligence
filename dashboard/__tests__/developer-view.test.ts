/**
 * Unit Tests for Developer View Asset-Scoped Queries
 *
 * Validates: Requirements 6.1, 6.2, 6.3, 6.4, 6.5
 *
 * These example-based tests complement the property-based tests in
 * query-parameterization.property.test.ts by verifying concrete known
 * outputs for specific assets (EURUSD, GBPUSD).
 */

import { describe, it, expect } from 'vitest';
import {
  type AssetConfig,
  ACTIVE_ASSETS,
  buildBatchRunsParams,
  buildExecutionTracesParams,
  buildBatchDiagnosticsParams,
  buildDriftAlertsParams,
  buildSimilarityArchiveParams,
} from '../query-parameterization.js';

// =============================================================================
// Helpers
// =============================================================================

const EURUSD: AssetConfig = ACTIVE_ASSETS[0];
const GBPUSD: AssetConfig = ACTIVE_ASSETS[1];

// =============================================================================
// Tests: Query parameterization for Developer View queries
// =============================================================================

describe('Developer View: asset-scoped query parameterization', () => {
  describe('buildBatchRunsParams (Requirement 6.1)', () => {
    it('returns empty string for EURUSD (batch_runs has no asset column)', () => {
      const params = buildBatchRunsParams(EURUSD);
      expect(params).toBe('');
    });

    it('returns empty string for GBPUSD (batch_runs has no asset column)', () => {
      const params = buildBatchRunsParams(GBPUSD);
      expect(params).toBe('');
    });

    it('does not contain asset filter (table has no asset column)', () => {
      const params = buildBatchRunsParams(EURUSD);
      expect(params).not.toContain('asset=eq.');
    });
  });

  describe('buildExecutionTracesParams (Requirement 6.2)', () => {
    it('returns empty string for EURUSD (execution_traces has no asset column)', () => {
      const params = buildExecutionTracesParams(EURUSD);
      expect(params).toBe('');
    });

    it('returns empty string for GBPUSD (execution_traces has no asset column)', () => {
      const params = buildExecutionTracesParams(GBPUSD);
      expect(params).toBe('');
    });

    it('does not contain asset filter (table has no asset column)', () => {
      const params = buildExecutionTracesParams(GBPUSD);
      expect(params).not.toContain('asset=eq.');
    });
  });

  describe('buildBatchDiagnosticsParams (Requirement 6.3)', () => {
    it('returns asset=eq.EURUSD for the EURUSD asset', () => {
      const params = buildBatchDiagnosticsParams(EURUSD);
      expect(params).toBe('asset=eq.EURUSD');
    });

    it('returns asset=eq.GBPUSD for the GBPUSD asset', () => {
      const params = buildBatchDiagnosticsParams(GBPUSD);
      expect(params).toBe('asset=eq.GBPUSD');
    });

    it('includes the asset filter pattern asset=eq.{symbol}', () => {
      const params = buildBatchDiagnosticsParams(EURUSD);
      expect(params).toMatch(/^asset=eq\.[A-Z]{6}$/);
    });
  });

  describe('buildDriftAlertsParams (Requirement 6.4)', () => {
    it('returns empty string for EURUSD (drift_alerts has no asset column)', () => {
      const params = buildDriftAlertsParams(EURUSD);
      expect(params).toBe('');
    });

    it('returns empty string for GBPUSD (drift_alerts has no asset column)', () => {
      const params = buildDriftAlertsParams(GBPUSD);
      expect(params).toBe('');
    });

    it('does not contain asset filter (table has no asset column)', () => {
      const params = buildDriftAlertsParams(GBPUSD);
      expect(params).not.toContain('asset=eq.');
    });
  });

  describe('buildSimilarityArchiveParams (Requirement 6.4)', () => {
    it('returns empty string for EURUSD (similarity_archive has no asset column)', () => {
      const params = buildSimilarityArchiveParams(EURUSD);
      expect(params).toBe('');
    });

    it('returns empty string for GBPUSD (similarity_archive has no asset column)', () => {
      const params = buildSimilarityArchiveParams(GBPUSD);
      expect(params).toBe('');
    });

    it('does not contain asset filter (table has no asset column)', () => {
      const params = buildSimilarityArchiveParams(EURUSD);
      expect(params).not.toContain('asset=eq.');
    });
  });
});

// =============================================================================
// Tests: Empty-state behavior for Developer View (Requirement 6.5)
// =============================================================================

describe('Developer View: empty-state messages', () => {
  describe('loadDeveloperView empty-state rendering', () => {
    /**
     * The dashboard's loadDeveloperView function (in index.html) renders
     * empty-state messages when Supabase returns no data for the selected
     * asset. Since the dashboard is a vanilla HTML script and not directly
     * importable, we verify the expected behavior by documenting the
     * contract and testing the query parameterization that drives it.
     *
     * Expected empty-state messages in the dashboard HTML:
     * - "No batch runs available for {asset}" when batchRuns.length === 0
     * - "No execution traces available for {asset}" when traces.length === 0
     * - "No learning pipeline data available" via renderContinuousLearningCard([], null)
     * - Empty similarity rendered by renderSimilarityCard([])
     */

    it('batch_runs query returns empty string (table has no asset column)', () => {
      // batch_runs has no asset column; query fetches all rows regardless of asset
      const params = buildBatchRunsParams(EURUSD);
      expect(params).toBe('');
    });

    it('execution_traces query returns empty string (table has no asset column)', () => {
      // execution_traces has no asset column; query fetches all rows regardless of asset
      const params = buildExecutionTracesParams(EURUSD);
      expect(params).toBe('');
    });

    it('buildBatchDiagnosticsParams returns distinct asset filters for different assets', () => {
      // Only buildBatchDiagnosticsParams has a valid asset column and returns distinct values
      const eurusdParams = buildBatchDiagnosticsParams(EURUSD);
      const gbpusdParams = buildBatchDiagnosticsParams(GBPUSD);
      expect(eurusdParams).not.toBe(gbpusdParams);
      expect(eurusdParams).toContain('EURUSD');
      expect(gbpusdParams).toContain('GBPUSD');
    });

    it('builders for tables without asset column return empty strings for all assets', () => {
      // These four builders return empty strings regardless of asset (no asset column)
      const noAssetBuilders = [
        buildBatchRunsParams,
        buildExecutionTracesParams,
        buildDriftAlertsParams,
        buildSimilarityArchiveParams,
      ];

      for (const builder of noAssetBuilders) {
        const eurusdParams = builder(EURUSD);
        const gbpusdParams = builder(GBPUSD);
        expect(eurusdParams).toBe('');
        expect(gbpusdParams).toBe('');
      }
    });
  });

  describe('continuous learning card empty-state', () => {
    // The renderContinuousLearningCard function is directly importable
    // and already tested in continuous-learning-card.test.ts.
    // Here we confirm the contract that empty/null inputs produce a no-data message.

    it('renderContinuousLearningCard with empty diagRows shows no-data message', async () => {
      const { renderContinuousLearningCard } = await import('../continuous-learning-card.js');
      const html = renderContinuousLearningCard([], null);
      expect(html).toContain('No learning pipeline data available');
    });

    it('renderContinuousLearningCard with null diagRows shows no-data message', async () => {
      const { renderContinuousLearningCard } = await import('../continuous-learning-card.js');
      const html = renderContinuousLearningCard(null, null);
      expect(html).toContain('No learning pipeline data available');
    });
  });
});
