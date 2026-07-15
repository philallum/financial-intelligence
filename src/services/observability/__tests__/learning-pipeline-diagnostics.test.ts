/**
 * Unit tests for DiagnosticsCollector — learning pipeline extension.
 *
 * Validates:
 * - recordLearningPipeline stores data correctly (Req 13.1)
 * - buildPayload includes learning_pipeline section (Req 13.5)
 * - Default null state when not called
 * - Recording with all fields populated
 * - Recording with partial/failure state
 * - recordLearningPipeline never throws
 */

import { describe, it, expect, vi } from 'vitest';
import { DiagnosticsCollector } from '../diagnostics-collector.js';
import type { LearningPipelineDiagnostics } from '../diagnostics-types.js';

// =============================================================================
// Mock Supabase Client Factory
// =============================================================================

function createMockSupabase() {
  let capturedPayload: any = null;

  const mockClient: any = {
    from: () => ({
      upsert: (row: any, _opts: any) => {
        capturedPayload = row.diagnostics;
        return Promise.resolve({ error: null });
      },
    }),
  };

  return { mockClient, getCapturedPayload: () => capturedPayload };
}

// =============================================================================
// Test Data Fixtures
// =============================================================================

function makeFullLearningPipelineDiagnostics(): LearningPipelineDiagnostics {
  return {
    calibration_applied: true,
    calibration_model_version: 'v2.3.1',
    raw_probabilities: { up: 0.45, down: 0.35, flat: 0.2 },
    calibrated_probabilities: { up: 0.5, down: 0.3, flat: 0.2 },
    shap_computed: true,
    top_shap_features: [
      { feature: 'sentiment_score', shap_value: 0.12 },
      { feature: 'vix_level', shap_value: -0.08 },
      { feature: 'macro_state', shap_value: 0.05 },
    ],
    event_context_applied: true,
    event_type: 'NFP',
    event_impact: {
      median_move_pips: 25.5,
      direction_skew: 0.65,
      vol_expansion_ratio: 1.3,
    },
    failure_reason: null,
  };
}

function makeFailureLearningPipelineDiagnostics(): LearningPipelineDiagnostics {
  return {
    calibration_applied: false,
    calibration_model_version: null,
    raw_probabilities: null,
    calibrated_probabilities: null,
    shap_computed: false,
    top_shap_features: null,
    event_context_applied: false,
    event_type: null,
    event_impact: null,
    failure_reason: 'Calibration model file not found',
  };
}

// =============================================================================
// Tests
// =============================================================================

describe('DiagnosticsCollector — Learning Pipeline Extension', () => {
  const asset = 'EURUSD';
  const batchId = 'batch-2025-01-15-001';

  describe('default null state', () => {
    it('persists learning_pipeline as null when recordLearningPipeline is not called', async () => {
      const { mockClient, getCapturedPayload } = createMockSupabase();
      const collector = new DiagnosticsCollector(asset, batchId, mockClient);

      await collector.persist();

      const payload = getCapturedPayload();
      expect(payload).not.toBeNull();
      expect(payload.learning_pipeline).toBeNull();
    });
  });

  describe('recordLearningPipeline stores data correctly', () => {
    it('persists provided data in the learning_pipeline field', async () => {
      const { mockClient, getCapturedPayload } = createMockSupabase();
      const collector = new DiagnosticsCollector(asset, batchId, mockClient);
      const data = makeFullLearningPipelineDiagnostics();

      collector.recordLearningPipeline(data);
      await collector.persist();

      const payload = getCapturedPayload();
      expect(payload.learning_pipeline).toEqual(data);
    });
  });

  describe('buildPayload includes learning_pipeline section', () => {
    it('payload contains the learning_pipeline key', async () => {
      const { mockClient, getCapturedPayload } = createMockSupabase();
      const collector = new DiagnosticsCollector(asset, batchId, mockClient);

      await collector.persist();

      const payload = getCapturedPayload();
      expect(payload).toHaveProperty('learning_pipeline');
    });
  });

  describe('recording with all fields populated', () => {
    it('correctly stores fully populated LearningPipelineDiagnostics', async () => {
      const { mockClient, getCapturedPayload } = createMockSupabase();
      const collector = new DiagnosticsCollector(asset, batchId, mockClient);
      const data = makeFullLearningPipelineDiagnostics();

      collector.recordLearningPipeline(data);
      await collector.persist();

      const persisted = getCapturedPayload().learning_pipeline;
      expect(persisted.calibration_applied).toBe(true);
      expect(persisted.calibration_model_version).toBe('v2.3.1');
      expect(persisted.raw_probabilities).toEqual({ up: 0.45, down: 0.35, flat: 0.2 });
      expect(persisted.calibrated_probabilities).toEqual({ up: 0.5, down: 0.3, flat: 0.2 });
      expect(persisted.shap_computed).toBe(true);
      expect(persisted.top_shap_features).toHaveLength(3);
      expect(persisted.event_context_applied).toBe(true);
      expect(persisted.event_type).toBe('NFP');
      expect(persisted.event_impact).toEqual({
        median_move_pips: 25.5,
        direction_skew: 0.65,
        vol_expansion_ratio: 1.3,
      });
      expect(persisted.failure_reason).toBeNull();
    });
  });

  describe('recording with partial/failure state', () => {
    it('correctly stores failure-state LearningPipelineDiagnostics', async () => {
      const { mockClient, getCapturedPayload } = createMockSupabase();
      const collector = new DiagnosticsCollector(asset, batchId, mockClient);
      const data = makeFailureLearningPipelineDiagnostics();

      collector.recordLearningPipeline(data);
      await collector.persist();

      const persisted = getCapturedPayload().learning_pipeline;
      expect(persisted.calibration_applied).toBe(false);
      expect(persisted.calibration_model_version).toBeNull();
      expect(persisted.raw_probabilities).toBeNull();
      expect(persisted.calibrated_probabilities).toBeNull();
      expect(persisted.shap_computed).toBe(false);
      expect(persisted.top_shap_features).toBeNull();
      expect(persisted.event_context_applied).toBe(false);
      expect(persisted.event_type).toBeNull();
      expect(persisted.event_impact).toBeNull();
      expect(persisted.failure_reason).toBe('Calibration model file not found');
    });
  });

  describe('recordLearningPipeline never throws', () => {
    it('does not throw when called with valid data', () => {
      const { mockClient } = createMockSupabase();
      const collector = new DiagnosticsCollector(asset, batchId, mockClient);
      const data = makeFullLearningPipelineDiagnostics();

      expect(() => collector.recordLearningPipeline(data)).not.toThrow();
    });

    it('does not throw when called with unexpected input shapes', () => {
      const { mockClient } = createMockSupabase();
      const collector = new DiagnosticsCollector(asset, batchId, mockClient);

      // Pass edge-case inputs — the method should never throw regardless
      expect(() => collector.recordLearningPipeline({} as any)).not.toThrow();
      expect(() => collector.recordLearningPipeline(null as any)).not.toThrow();
      expect(() => collector.recordLearningPipeline(undefined as any)).not.toThrow();
    });
  });
});
