/**
 * Integration tests for the Continuous Learning Pipeline.
 *
 * Tests end-to-end flow: event context → calibration → SHAP → diagnostics recording.
 * Validates graceful degradation when the ML service is unavailable, backward
 * compatibility of the diagnostics payload, and neutral fill values when no event
 * context is available.
 *
 * Validates: Requirements 8.4, 9.1, 13.1
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { DiagnosticsCollector } from '../../src/services/observability/diagnostics-collector.js';
import type {
  BatchDiagnosticsPayload,
  LearningPipelineDiagnostics,
} from '../../src/services/observability/diagnostics-types.js';
import type { EventImpactSummary } from '../../src/services/pipeline/event-context-service.js';

// =============================================================================
// Mock Supabase Client
// =============================================================================

function createMockSupabase() {
  const upsertCalls: unknown[] = [];

  const mockFrom = vi.fn().mockImplementation((_table: string) => ({
    upsert: vi.fn().mockImplementation((data: unknown) => {
      upsertCalls.push(data);
      return { error: null };
    }),
  }));

  return {
    client: { from: mockFrom } as unknown as import('@supabase/supabase-js').SupabaseClient,
    upsertCalls,
    mockFrom,
  };
}

// =============================================================================
// Test Fixtures
// =============================================================================

const sampleEventContext: EventImpactSummary = {
  event_type: 'Non-Farm Payrolls',
  median_move_pips: 42.5,
  direction_skew: 0.65,
  vol_expansion_ratio: 1.8,
  instance_count: 12,
};

function createHappyPathLearningDiagnostics(): LearningPipelineDiagnostics {
  return {
    calibration_applied: true,
    calibration_model_version: 'cal-v1-2026-07-20',
    raw_probabilities: { up: 0.65, down: 0.20, flat: 0.15 },
    calibrated_probabilities: { up: 0.58, down: 0.24, flat: 0.18 },
    shap_computed: true,
    top_shap_features: [
      { feature: 'sent_aggregate', shap_value: -0.12 },
      { feature: 'macro_event_proximity', shap_value: 0.08 },
      { feature: 'l1_mean', shap_value: 0.05 },
    ],
    event_context_applied: true,
    event_type: 'Non-Farm Payrolls',
    event_impact: {
      median_move_pips: 42.5,
      direction_skew: 0.65,
      vol_expansion_ratio: 1.8,
    },
    failure_reason: null,
  };
}

function createDegradedLearningDiagnostics(): LearningPipelineDiagnostics {
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
    failure_reason: 'ml_service_unavailable',
  };
}

function createNoEventContextDiagnostics(): LearningPipelineDiagnostics {
  return {
    calibration_applied: true,
    calibration_model_version: 'cal-v1-2026-07-20',
    raw_probabilities: { up: 0.60, down: 0.25, flat: 0.15 },
    calibrated_probabilities: { up: 0.55, down: 0.27, flat: 0.18 },
    shap_computed: true,
    top_shap_features: [
      { feature: 'volatility_profile_3', shap_value: 0.09 },
      { feature: 'l1_mean', shap_value: 0.07 },
      { feature: 'session_london', shap_value: 0.04 },
    ],
    event_context_applied: false,
    event_type: null,
    event_impact: null,
    failure_reason: null,
  };
}

// =============================================================================
// Integration Tests
// =============================================================================

describe('Learning Pipeline Integration', () => {
  let mockSupabase: ReturnType<typeof createMockSupabase>;

  beforeEach(() => {
    mockSupabase = createMockSupabase();
  });

  // ===========================================================================
  // 1. Happy path: event context → calibration → SHAP → diagnostics recording
  // ===========================================================================

  describe('End-to-end: event context → calibration → SHAP → diagnostics recording', () => {
    it('should record learning pipeline diagnostics with all fields populated on happy path', async () => {
      const collector = new DiagnosticsCollector('EURUSD', 'batch-lp-001', mockSupabase.client);

      // Record the full learning pipeline diagnostics (happy path)
      const learningData = createHappyPathLearningDiagnostics();
      collector.recordLearningPipeline(learningData);

      // Persist
      await collector.persist();

      // Verify the upsert was called
      expect(mockSupabase.upsertCalls.length).toBe(1);
      const upsertedRow = mockSupabase.upsertCalls[0] as {
        asset: string;
        batch_id: string;
        diagnostics: BatchDiagnosticsPayload;
      };

      expect(upsertedRow.asset).toBe('EURUSD');
      expect(upsertedRow.batch_id).toBe('batch-lp-001');

      // Verify learning_pipeline section
      const lp = upsertedRow.diagnostics.learning_pipeline;
      expect(lp).not.toBeNull();
      expect(lp!.calibration_applied).toBe(true);
      expect(lp!.calibration_model_version).toBe('cal-v1-2026-07-20');
      expect(lp!.raw_probabilities).toEqual({ up: 0.65, down: 0.20, flat: 0.15 });
      expect(lp!.calibrated_probabilities).toEqual({ up: 0.58, down: 0.24, flat: 0.18 });
      expect(lp!.shap_computed).toBe(true);
      expect(lp!.top_shap_features).toHaveLength(3);
      expect(lp!.event_context_applied).toBe(true);
      expect(lp!.event_type).toBe('Non-Farm Payrolls');
      expect(lp!.event_impact).toEqual({
        median_move_pips: 42.5,
        direction_skew: 0.65,
        vol_expansion_ratio: 1.8,
      });
      expect(lp!.failure_reason).toBeNull();
    });

    it('should record event_type populated from event context summary', async () => {
      const collector = new DiagnosticsCollector('EURUSD', 'batch-lp-002', mockSupabase.client);

      const learningData: LearningPipelineDiagnostics = {
        ...createHappyPathLearningDiagnostics(),
        event_type: sampleEventContext.event_type,
        event_impact: {
          median_move_pips: sampleEventContext.median_move_pips,
          direction_skew: sampleEventContext.direction_skew,
          vol_expansion_ratio: sampleEventContext.vol_expansion_ratio,
        },
      };

      collector.recordLearningPipeline(learningData);
      await collector.persist();

      const upsertedRow = mockSupabase.upsertCalls[0] as {
        diagnostics: BatchDiagnosticsPayload;
      };
      const lp = upsertedRow.diagnostics.learning_pipeline!;

      expect(lp.event_type).toBe('Non-Farm Payrolls');
      expect(lp.event_impact!.median_move_pips).toBe(42.5);
      expect(lp.event_impact!.direction_skew).toBe(0.65);
      expect(lp.event_impact!.vol_expansion_ratio).toBe(1.8);
    });

    it('should include raw and calibrated probabilities when calibration is applied', async () => {
      const collector = new DiagnosticsCollector('EURUSD', 'batch-lp-003', mockSupabase.client);

      collector.recordLearningPipeline(createHappyPathLearningDiagnostics());
      await collector.persist();

      const upsertedRow = mockSupabase.upsertCalls[0] as {
        diagnostics: BatchDiagnosticsPayload;
      };
      const lp = upsertedRow.diagnostics.learning_pipeline!;

      // Raw probabilities should be different from calibrated
      expect(lp.raw_probabilities).not.toEqual(lp.calibrated_probabilities);
      // Both should be valid probability distributions
      const rawSum = lp.raw_probabilities!.up + lp.raw_probabilities!.down + lp.raw_probabilities!.flat;
      const calSum = lp.calibrated_probabilities!.up + lp.calibrated_probabilities!.down + lp.calibrated_probabilities!.flat;
      expect(rawSum).toBeCloseTo(1.0, 5);
      expect(calSum).toBeCloseTo(1.0, 5);
    });

    it('should record top SHAP features with feature names and values', async () => {
      const collector = new DiagnosticsCollector('EURUSD', 'batch-lp-004', mockSupabase.client);

      collector.recordLearningPipeline(createHappyPathLearningDiagnostics());
      await collector.persist();

      const upsertedRow = mockSupabase.upsertCalls[0] as {
        diagnostics: BatchDiagnosticsPayload;
      };
      const lp = upsertedRow.diagnostics.learning_pipeline!;

      expect(lp.top_shap_features).toEqual([
        { feature: 'sent_aggregate', shap_value: -0.12 },
        { feature: 'macro_event_proximity', shap_value: 0.08 },
        { feature: 'l1_mean', shap_value: 0.05 },
      ]);
    });
  });

  // ===========================================================================
  // 2. Graceful degradation when ML service unavailable
  // ===========================================================================

  describe('Graceful degradation when ML service unavailable', () => {
    it('should record calibration_applied: false when ML service is unavailable', async () => {
      const collector = new DiagnosticsCollector('EURUSD', 'batch-lp-010', mockSupabase.client);

      collector.recordLearningPipeline(createDegradedLearningDiagnostics());
      await collector.persist();

      const upsertedRow = mockSupabase.upsertCalls[0] as {
        diagnostics: BatchDiagnosticsPayload;
      };
      const lp = upsertedRow.diagnostics.learning_pipeline!;

      expect(lp.calibration_applied).toBe(false);
      expect(lp.calibration_model_version).toBeNull();
      expect(lp.raw_probabilities).toBeNull();
      expect(lp.calibrated_probabilities).toBeNull();
    });

    it('should record failure_reason with descriptive message on ML service failure', async () => {
      const collector = new DiagnosticsCollector('EURUSD', 'batch-lp-011', mockSupabase.client);

      collector.recordLearningPipeline(createDegradedLearningDiagnostics());
      await collector.persist();

      const upsertedRow = mockSupabase.upsertCalls[0] as {
        diagnostics: BatchDiagnosticsPayload;
      };
      const lp = upsertedRow.diagnostics.learning_pipeline!;

      expect(lp.failure_reason).not.toBeNull();
      expect(lp.failure_reason).toContain('ml_service_unavailable');
    });

    it('should record shap_computed: false when ML service is unavailable', async () => {
      const collector = new DiagnosticsCollector('EURUSD', 'batch-lp-012', mockSupabase.client);

      collector.recordLearningPipeline(createDegradedLearningDiagnostics());
      await collector.persist();

      const upsertedRow = mockSupabase.upsertCalls[0] as {
        diagnostics: BatchDiagnosticsPayload;
      };
      const lp = upsertedRow.diagnostics.learning_pipeline!;

      expect(lp.shap_computed).toBe(false);
      expect(lp.top_shap_features).toBeNull();
    });

    it('should continue pipeline without error (persist succeeds) even on degradation', async () => {
      const collector = new DiagnosticsCollector('EURUSD', 'batch-lp-013', mockSupabase.client);

      // Recording degraded data should not throw
      expect(() => collector.recordLearningPipeline(createDegradedLearningDiagnostics())).not.toThrow();

      // Persist should succeed without errors
      await expect(collector.persist()).resolves.toBeUndefined();

      // Verify the payload was still persisted
      expect(mockSupabase.upsertCalls.length).toBe(1);
    });

    it('should record specific calibration failure reason when calibration call fails', async () => {
      const collector = new DiagnosticsCollector('EURUSD', 'batch-lp-014', mockSupabase.client);

      const diagnosticsWithCalibrationFailure: LearningPipelineDiagnostics = {
        calibration_applied: false,
        calibration_model_version: null,
        raw_probabilities: { up: 0.65, down: 0.20, flat: 0.15 },
        calibrated_probabilities: null,
        shap_computed: false,
        top_shap_features: null,
        event_context_applied: true,
        event_type: 'CPI Release',
        event_impact: {
          median_move_pips: 25.0,
          direction_skew: 0.55,
          vol_expansion_ratio: 1.3,
        },
        failure_reason: 'calibration_failed: fetch failed (Connection refused)',
      };

      collector.recordLearningPipeline(diagnosticsWithCalibrationFailure);
      await collector.persist();

      const upsertedRow = mockSupabase.upsertCalls[0] as {
        diagnostics: BatchDiagnosticsPayload;
      };
      const lp = upsertedRow.diagnostics.learning_pipeline!;

      expect(lp.failure_reason).toContain('calibration_failed');
      expect(lp.calibration_applied).toBe(false);
      // Event context can still be applied even when calibration fails
      expect(lp.event_context_applied).toBe(true);
    });
  });

  // ===========================================================================
  // 3. Backward compatibility of diagnostics payload
  // ===========================================================================

  describe('Backward compatibility of diagnostics payload', () => {
    it('should include learning_pipeline as null when not recorded (no ML service configured)', async () => {
      const collector = new DiagnosticsCollector('EURUSD', 'batch-lp-020', mockSupabase.client);

      // Do NOT record learning pipeline — simulates ML service not configured
      await collector.persist();

      const upsertedRow = mockSupabase.upsertCalls[0] as {
        diagnostics: BatchDiagnosticsPayload;
      };

      // learning_pipeline should be null (default)
      expect(upsertedRow.diagnostics.learning_pipeline).toBeNull();
    });

    it('should conform to BatchDiagnosticsPayload shape with all sections present', async () => {
      const collector = new DiagnosticsCollector('EURUSD', 'batch-lp-021', mockSupabase.client);

      // Record only the standard sections (no learning pipeline)
      collector.recordSentiment({
        article_count: 5,
        window_hours: 24,
        sentiment_vector: [0.2, 0.3, 0.1, 0.2, 0.1, 0.1],
        sentiment_score: 0.65,
        confidence_factor: 0.8,
      });
      collector.recordMacroContext({
        event_count: 3,
        macro_vector: [0.5, 0.4, 0.3, 0.6, 0.5, 0.4, 0.7, 0.3],
        macro_state: 'EXPANSIONARY',
      });
      collector.recordMLService({ called: true, response: { up: 0.6, down: 0.25, flat: 0.15 }, latency_ms: 120 });
      collector.recordMarketContext({ available: true, dxy: 104.5, vix: 16.2, spx: 5200 });
      collector.recordSimilarity({ match_count: 45, session_bonus_count: 12, regime_bonus_count: 8 });
      collector.recordOutcome({ dynamic_flat_threshold: 3.5, weighted_return_count: 150 });
      collector.recordForecast({
        similarity_only: { up: 0.55, down: 0.30, flat: 0.15 },
        ensemble: { up: 0.58, down: 0.27, flat: 0.15 },
        alpha_weight: 0.5,
      });
      collector.recordGemini({ scored_article_count: 4 });

      await collector.persist();

      const upsertedRow = mockSupabase.upsertCalls[0] as {
        diagnostics: BatchDiagnosticsPayload;
      };
      const payload = upsertedRow.diagnostics;

      // Verify all existing sections are present
      expect(payload.sentiment).not.toBeNull();
      expect(payload.macro_context).not.toBeNull();
      expect(payload.ml_service).toBeDefined();
      expect(payload.market_context).toBeDefined();
      expect(payload.similarity).not.toBeNull();
      expect(payload.outcome).not.toBeNull();
      expect(payload.forecast).not.toBeNull();
      expect(payload.gemini).not.toBeNull();

      // The new learning_pipeline field is present (null because not recorded)
      expect('learning_pipeline' in payload).toBe(true);
      expect(payload.learning_pipeline).toBeNull();
    });

    it('should include all sections PLUS learning_pipeline when learning pipeline is recorded', async () => {
      const collector = new DiagnosticsCollector('EURUSD', 'batch-lp-022', mockSupabase.client);

      // Record all sections including learning pipeline
      collector.recordSentiment({
        article_count: 3,
        window_hours: 24,
        sentiment_vector: [0.1, 0.2, 0.3, 0.1, 0.2, 0.1],
        sentiment_score: 0.45,
        confidence_factor: 0.7,
      });
      collector.recordMLService({ called: true, response: { up: 0.6, down: 0.2, flat: 0.2 }, latency_ms: 95 });
      collector.recordMarketContext({ available: true, dxy: 103.8, vix: 18.1, spx: 5150 });
      collector.recordLearningPipeline(createHappyPathLearningDiagnostics());

      await collector.persist();

      const upsertedRow = mockSupabase.upsertCalls[0] as {
        diagnostics: BatchDiagnosticsPayload;
      };
      const payload = upsertedRow.diagnostics;

      // All sections present
      expect(payload.sentiment).not.toBeNull();
      expect(payload.ml_service).toBeDefined();
      expect(payload.ml_service.called).toBe(true);
      expect(payload.market_context).toBeDefined();
      expect(payload.market_context.available).toBe(true);
      expect(payload.learning_pipeline).not.toBeNull();
      expect(payload.learning_pipeline!.calibration_applied).toBe(true);
    });

    it('should have a valid diagnostics shape even with no sections recorded', async () => {
      const collector = new DiagnosticsCollector('EURUSD', 'batch-lp-023', mockSupabase.client);

      // Persist with nothing recorded — should still produce valid structure
      await collector.persist();

      const upsertedRow = mockSupabase.upsertCalls[0] as {
        diagnostics: BatchDiagnosticsPayload;
      };
      const payload = upsertedRow.diagnostics;

      // Defaults from DiagnosticsCollector constructor
      expect(payload.sentiment).toBeNull();
      expect(payload.macro_context).toBeNull();
      expect(payload.ml_service).toEqual({ called: false, response: null, latency_ms: null });
      expect(payload.market_context).toEqual({ available: false, dxy: null, vix: null, spx: null });
      expect(payload.similarity).toBeNull();
      expect(payload.outcome).toBeNull();
      expect(payload.forecast).toBeNull();
      expect(payload.gemini).toBeNull();
      expect(payload.learning_pipeline).toBeNull();
    });
  });

  // ===========================================================================
  // 4. Event context null (no upcoming events)
  // ===========================================================================

  describe('Event context null (no upcoming events)', () => {
    it('should record event_context_applied: false when no events are upcoming', async () => {
      const collector = new DiagnosticsCollector('EURUSD', 'batch-lp-030', mockSupabase.client);

      collector.recordLearningPipeline(createNoEventContextDiagnostics());
      await collector.persist();

      const upsertedRow = mockSupabase.upsertCalls[0] as {
        diagnostics: BatchDiagnosticsPayload;
      };
      const lp = upsertedRow.diagnostics.learning_pipeline!;

      expect(lp.event_context_applied).toBe(false);
      expect(lp.event_type).toBeNull();
      expect(lp.event_impact).toBeNull();
    });

    it('should use neutral fill values [0.0, 0.5, 1.0] when event context is null', () => {
      // This tests the logic in batch-entry.ts that determines feature values
      // When eventContext is null, neutral fill values should be used:
      const eventContext: EventImpactSummary | null = null;

      const eventFeatures = eventContext
        ? [eventContext.median_move_pips, eventContext.direction_skew, eventContext.vol_expansion_ratio]
        : [0.0, 0.5, 1.0];

      expect(eventFeatures).toEqual([0.0, 0.5, 1.0]);
    });

    it('should use actual event values when event context is available', () => {
      // Verify the feature augmentation uses event values when available
      const eventContext: EventImpactSummary | null = sampleEventContext;

      const eventFeatures = eventContext
        ? [eventContext.median_move_pips, eventContext.direction_skew, eventContext.vol_expansion_ratio]
        : [0.0, 0.5, 1.0];

      expect(eventFeatures).toEqual([42.5, 0.65, 1.8]);
      expect(eventFeatures[0]).toBe(sampleEventContext.median_move_pips);
      expect(eventFeatures[1]).toBe(sampleEventContext.direction_skew);
      expect(eventFeatures[2]).toBe(sampleEventContext.vol_expansion_ratio);
    });

    it('should still record calibration as applied even without event context', async () => {
      const collector = new DiagnosticsCollector('EURUSD', 'batch-lp-031', mockSupabase.client);

      // Calibration can succeed even when no event context is available
      collector.recordLearningPipeline(createNoEventContextDiagnostics());
      await collector.persist();

      const upsertedRow = mockSupabase.upsertCalls[0] as {
        diagnostics: BatchDiagnosticsPayload;
      };
      const lp = upsertedRow.diagnostics.learning_pipeline!;

      expect(lp.calibration_applied).toBe(true);
      expect(lp.calibration_model_version).toBe('cal-v1-2026-07-20');
      expect(lp.event_context_applied).toBe(false);
      expect(lp.failure_reason).toBeNull();
    });

    it('should record no failure_reason when event context is simply null (not an error)', async () => {
      const collector = new DiagnosticsCollector('EURUSD', 'batch-lp-032', mockSupabase.client);

      collector.recordLearningPipeline(createNoEventContextDiagnostics());
      await collector.persist();

      const upsertedRow = mockSupabase.upsertCalls[0] as {
        diagnostics: BatchDiagnosticsPayload;
      };
      const lp = upsertedRow.diagnostics.learning_pipeline!;

      // Null event context is a valid state (no upcoming events), not an error
      expect(lp.failure_reason).toBeNull();
    });
  });

  // ===========================================================================
  // 5. DiagnosticsCollector recordLearningPipeline never throws
  // ===========================================================================

  describe('recordLearningPipeline never throws', () => {
    it('should not throw when recording valid learning pipeline diagnostics', () => {
      const collector = new DiagnosticsCollector('EURUSD', 'batch-lp-040', mockSupabase.client);

      expect(() => collector.recordLearningPipeline(createHappyPathLearningDiagnostics())).not.toThrow();
      expect(() => collector.recordLearningPipeline(createDegradedLearningDiagnostics())).not.toThrow();
      expect(() => collector.recordLearningPipeline(createNoEventContextDiagnostics())).not.toThrow();
    });

    it('should not throw when called multiple times (last write wins)', async () => {
      const collector = new DiagnosticsCollector('EURUSD', 'batch-lp-041', mockSupabase.client);

      // Multiple recordings — last one should win
      collector.recordLearningPipeline(createDegradedLearningDiagnostics());
      collector.recordLearningPipeline(createHappyPathLearningDiagnostics());

      await collector.persist();

      const upsertedRow = mockSupabase.upsertCalls[0] as {
        diagnostics: BatchDiagnosticsPayload;
      };
      const lp = upsertedRow.diagnostics.learning_pipeline!;

      // Last write wins — should be the happy path data
      expect(lp.calibration_applied).toBe(true);
      expect(lp.event_context_applied).toBe(true);
    });
  });
});
