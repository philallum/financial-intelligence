/**
 * Unit Tests for Dashboard Continuous Learning Card
 *
 * Validates: Requirements 14.1, 14.3, 14.4
 */

import { describe, it, expect } from 'vitest';
import {
  renderContinuousLearningCard,
  type DiagRow,
  type DriftAlertRow,
  type LearningPipelineDiagnostics,
} from '../continuous-learning-card.js';

// =============================================================================
// Helpers — Test Data Factories
// =============================================================================

function makeDiagRow(overrides: Partial<DiagRow> & { learningPipeline?: LearningPipelineDiagnostics | null }): DiagRow {
  const { learningPipeline, ...rest } = overrides;
  return {
    asset: 'EURUSD',
    batch_id: 'batch-001',
    updated_at: new Date().toISOString(),
    diagnostics: {
      learning_pipeline: learningPipeline !== undefined ? learningPipeline : {
        calibration_applied: true,
        calibration_model_version: 'cal-v1-2026-07-20',
        raw_probabilities: { up: 0.65, down: 0.20, flat: 0.15 },
        calibrated_probabilities: { up: 0.58, down: 0.24, flat: 0.18 },
        shap_computed: true,
        top_shap_features: [
          { feature: 'sent_aggregate', shap_value: -0.12 },
          { feature: 'macro_proximity', shap_value: 0.08 },
          { feature: 'l1_mean', shap_value: 0.05 },
        ],
        event_context_applied: false,
        event_type: null,
        event_impact: null,
        failure_reason: null,
      },
    },
    ...rest,
  };
}

function makeDriftAlert(overrides: Partial<DriftAlertRow> = {}): DriftAlertRow {
  return {
    id: 'drift-001',
    regime: 'HIGH',
    detected_at: new Date().toISOString(),
    rolling_accuracy: 0.42,
    baseline_accuracy: 0.58,
    sigma: 0.05,
    deviation_sigmas: 3.2,
    retrain_triggered: true,
    retrain_outcome: { status: 'trained', accuracy: 0.61 },
    resolved_at: null,
    ...overrides,
  };
}

// =============================================================================
// Tests: Calibration Warning Indicator (Requirement 14.3)
// =============================================================================

describe('Continuous Learning Card', () => {
  describe('calibration warning indicator', () => {
    it('shows warning when calibration not applied', () => {
      const diagRows: DiagRow[] = [
        makeDiagRow({
          learningPipeline: {
            calibration_applied: false,
            calibration_model_version: null,
            raw_probabilities: null,
            calibrated_probabilities: null,
            shap_computed: true,
            top_shap_features: [{ feature: 'f1', shap_value: 0.1 }],
            event_context_applied: false,
            event_type: null,
            event_impact: null,
            failure_reason: null,
          },
        }),
      ];

      const html = renderContinuousLearningCard(diagRows, []);
      expect(html).toContain('⚠️');
      expect(html).toContain('Not Applied');
    });

    it('does not show calibration warning when calibration is applied', () => {
      const diagRows: DiagRow[] = [
        makeDiagRow({
          learningPipeline: {
            calibration_applied: true,
            calibration_model_version: 'cal-v1',
            raw_probabilities: { up: 0.5, down: 0.3, flat: 0.2 },
            calibrated_probabilities: { up: 0.55, down: 0.28, flat: 0.17 },
            shap_computed: true,
            top_shap_features: null,
            event_context_applied: false,
            event_type: null,
            event_impact: null,
            failure_reason: null,
          },
        }),
      ];

      const html = renderContinuousLearningCard(diagRows, []);
      // Should show "Applied" (not "Not Applied")
      expect(html).toContain('Applied');
      // Should NOT contain the calibration warning alert bar
      expect(html).not.toContain('Calibration was not applied');
    });
  });

  // ===========================================================================
  // Tests: Renders gracefully with missing/null data
  // ===========================================================================

  describe('renders gracefully with missing/null data', () => {
    it('returns no-data message when diagRows is null', () => {
      const html = renderContinuousLearningCard(null, null);
      expect(html).toContain('No learning pipeline data available');
      expect(html).toContain('no-data');
    });

    it('returns no-data message when diagRows is empty array', () => {
      const html = renderContinuousLearningCard([], null);
      expect(html).toContain('No learning pipeline data available');
      expect(html).toContain('no-data');
    });

    it('handles diagRows where learning_pipeline is null gracefully', () => {
      const diagRows: DiagRow[] = [
        makeDiagRow({ learningPipeline: null }),
      ];

      const html = renderContinuousLearningCard(diagRows, []);
      // Should not throw — renders with fallback defaults
      expect(html).toContain('Continuous Learning');
      expect(html).toContain('Calibration');
      // When learning_pipeline is null, calibration defaults to false → shows warning
      expect(html).toContain('Not Applied');
    });

    it('handles null driftRows without errors', () => {
      const diagRows: DiagRow[] = [makeDiagRow({})];
      const html = renderContinuousLearningCard(diagRows, null);
      expect(html).toContain('Continuous Learning');
      expect(html).toContain('Healthy');
    });
  });

  // ===========================================================================
  // Tests: Drift alert section hidden when no recent drift
  // ===========================================================================

  describe('drift alert section hidden when no recent drift', () => {
    it('does not render drift alert bar when driftRows is empty', () => {
      const diagRows: DiagRow[] = [makeDiagRow({})];
      const html = renderContinuousLearningCard(diagRows, []);

      // Should show "Healthy" status, not drift details
      expect(html).toContain('Healthy');
      expect(html).not.toContain('alert-bar');
      expect(html).not.toContain('Drift detected in');
    });

    it('renders drift alert details when drift is present', () => {
      const diagRows: DiagRow[] = [makeDiagRow({})];
      const driftRows: DriftAlertRow[] = [makeDriftAlert()];

      const html = renderContinuousLearningCard(diagRows, driftRows);

      expect(html).toContain('Drift Detected');
      expect(html).toContain('alert-bar');
      expect(html).toContain('HIGH');
      expect(html).toContain('3.2σ');
      expect(html).toContain('triggered');
    });

    it('renders drift alert with retrain not triggered', () => {
      const diagRows: DiagRow[] = [makeDiagRow({})];
      const driftRows: DriftAlertRow[] = [
        makeDriftAlert({ retrain_triggered: false }),
      ];

      const html = renderContinuousLearningCard(diagRows, driftRows);
      expect(html).toContain('not triggered');
    });
  });

  // ===========================================================================
  // Tests: Backward compatibility with old data missing learning_pipeline field
  // ===========================================================================

  describe('backward compatibility with old data', () => {
    it('renders without error when diagnostics has no learning_pipeline field', () => {
      const diagRows: DiagRow[] = [
        {
          asset: 'EURUSD',
          batch_id: 'batch-old-001',
          updated_at: new Date().toISOString(),
          diagnostics: {
            // Old data format: no learning_pipeline field at all
            ml_service: { called: true, response: null, latency_ms: 100 },
            market_context: { available: true, dxy: 104.5, vix: 15.2, spx: 5400 },
          },
        },
      ];

      const html = renderContinuousLearningCard(diagRows, []);

      // Should render the card structure without throwing
      expect(html).toContain('Continuous Learning');
      expect(html).toContain('Calibration');
      expect(html).toContain('SHAP Explainability');
      expect(html).toContain('Event Context');
      expect(html).toContain('Drift Detection');
      // learning_pipeline is undefined → defaults apply → Not Applied shown
      expect(html).toContain('Not Applied');
    });

    it('renders timeline items gracefully when some rows lack learning_pipeline', () => {
      const diagRows: DiagRow[] = [
        makeDiagRow({}), // has learning_pipeline
        {
          // Old format row — no learning_pipeline
          asset: 'GBPUSD',
          batch_id: 'batch-old-002',
          updated_at: new Date(Date.now() - 4 * 60 * 60 * 1000).toISOString(),
          diagnostics: {
            ml_service: { called: true, response: null, latency_ms: 80 },
            market_context: { available: true, dxy: null, vix: null, spx: null },
          },
        },
      ];

      const html = renderContinuousLearningCard(diagRows, []);

      // Both rows rendered in timeline without errors — timeline uses status dots
      expect(html).toContain('Last 2 Batch Cycles');
      expect(html).toContain('title="Calibration"');
      expect(html).toContain('4h ago');
    });

    it('handles diagnostics object being completely empty', () => {
      const diagRows: DiagRow[] = [
        {
          asset: 'USDJPY',
          batch_id: 'batch-empty',
          updated_at: new Date().toISOString(),
          diagnostics: {} as any,
        },
      ];

      const html = renderContinuousLearningCard(diagRows, []);
      expect(html).toContain('Continuous Learning');
      // Should not throw — defaults to "Not Applied" / "Skipped" etc.
      expect(html).toContain('Not Applied');
    });
  });
});
