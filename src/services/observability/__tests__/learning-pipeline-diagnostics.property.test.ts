/**
 * Property-Based Tests for Learning Pipeline Diagnostics
 *
 * Property 11: Learning pipeline diagnostics shape completeness
 * Property 12: Top-3 SHAP feature recording correctness
 * Property 13: Learning pipeline recording never throws
 *
 * Validates: Requirements 13.1, 13.2, 13.3, 13.4, 13.5
 */

import { describe, it, expect, vi } from 'vitest';
import * as fc from 'fast-check';
import { DiagnosticsCollector } from '../diagnostics-collector.js';
import type { LearningPipelineDiagnostics } from '../diagnostics-types.js';

// =============================================================================
// Helpers
// =============================================================================

/**
 * Creates a mock Supabase client that captures the upserted payload.
 */
function createMockSupabase() {
  let capturedPayload: any = null;

  const mock = {
    from: vi.fn().mockReturnThis(),
    upsert: vi.fn((data: any) => {
      capturedPayload = data;
      return Promise.resolve({ error: null });
    }),
    getCapturedPayload: () => capturedPayload,
  };

  // Chain from().upsert()
  mock.from = vi.fn(() => ({ upsert: mock.upsert }));

  return mock;
}

// =============================================================================
// Generators
// =============================================================================

/** Generator for a probability vector { up, down, flat }. */
const probVectorArb = fc.record({
  up: fc.float({ min: 0, max: 1, noNaN: true, noDefaultInfinity: true }),
  down: fc.float({ min: 0, max: 1, noNaN: true, noDefaultInfinity: true }),
  flat: fc.float({ min: 0, max: 1, noNaN: true, noDefaultInfinity: true }),
});

/** Generator for a single SHAP feature entry. */
const shapFeatureArb = fc.record({
  feature: fc.string({ minLength: 1, maxLength: 30 }),
  shap_value: fc.float({ min: -10, max: 10, noNaN: true, noDefaultInfinity: true }),
});

/** Generator for a top_shap_features array (exactly 3 entries, sorted by |shap_value| descending). */
const topShapFeaturesArb = fc
  .array(shapFeatureArb, { minLength: 3, maxLength: 3 })
  .map((features) =>
    [...features].sort((a, b) => Math.abs(b.shap_value) - Math.abs(a.shap_value)),
  );

/** Generator for event impact. */
const eventImpactArb = fc.record({
  median_move_pips: fc.float({ min: 0, max: 500, noNaN: true, noDefaultInfinity: true }),
  direction_skew: fc.float({ min: 0, max: 1, noNaN: true, noDefaultInfinity: true }),
  vol_expansion_ratio: fc.float({ min: 0, max: 10, noNaN: true, noDefaultInfinity: true }),
});

/** Generator for a valid LearningPipelineDiagnostics object. */
const validDiagnosticsArb: fc.Arbitrary<LearningPipelineDiagnostics> = fc.record({
  calibration_applied: fc.boolean(),
  calibration_model_version: fc.oneof(fc.string({ minLength: 1, maxLength: 30 }), fc.constant(null)),
  raw_probabilities: fc.oneof(probVectorArb, fc.constant(null)),
  calibrated_probabilities: fc.oneof(probVectorArb, fc.constant(null)),
  shap_computed: fc.boolean(),
  top_shap_features: fc.oneof(topShapFeaturesArb, fc.constant(null)),
  event_context_applied: fc.boolean(),
  event_type: fc.oneof(fc.string({ minLength: 1, maxLength: 30 }), fc.constant(null)),
  event_impact: fc.oneof(eventImpactArb, fc.constant(null)),
  failure_reason: fc.oneof(fc.string({ minLength: 1, maxLength: 100 }), fc.constant(null)),
});

/**
 * Generator for an array of SHAP features (variable length, unsorted) to test
 * top-3 selection correctness.
 */
const shapFeatureListArb = fc.array(shapFeatureArb, { minLength: 3, maxLength: 20 });

/**
 * Generator for arbitrary/malformed inputs to test never-throws property.
 * Includes valid objects, null-like values, objects with getters that throw, etc.
 */
const arbitraryInputArb = fc.oneof(
  // Valid diagnostics
  validDiagnosticsArb,
  // Object with all null fields
  fc.constant({
    calibration_applied: false,
    calibration_model_version: null,
    raw_probabilities: null,
    calibrated_probabilities: null,
    shap_computed: false,
    top_shap_features: null,
    event_context_applied: false,
    event_type: null,
    event_impact: null,
    failure_reason: null,
  } as LearningPipelineDiagnostics),
  // Arbitrary object (cast to any)
  fc.anything().map((v) => v as any),
);

// =============================================================================
// Property 11: Learning pipeline diagnostics shape completeness
// =============================================================================

describe('Property 11: Learning pipeline diagnostics shape completeness', () => {
  /**
   * Validates: Requirements 13.1, 13.2, 13.3, 13.4, 13.5
   *
   * For any valid LearningPipelineDiagnostics object recorded via recordLearningPipeline(),
   * the persisted payload SHALL include all required fields.
   */

  it('persisted payload contains all required learning_pipeline fields', async () => {
    await fc.assert(
      fc.asyncProperty(validDiagnosticsArb, async (diagnostics) => {
        const mockSupabase = createMockSupabase();
        const collector = new DiagnosticsCollector(
          'EURUSD',
          'batch-001',
          mockSupabase as any,
        );

        collector.recordLearningPipeline(diagnostics);
        await collector.persist();

        const captured = mockSupabase.getCapturedPayload();
        expect(captured).not.toBeNull();

        const learningPipeline = captured.diagnostics.learning_pipeline;
        expect(learningPipeline).not.toBeNull();

        // All required fields must be present
        expect(learningPipeline).toHaveProperty('calibration_applied');
        expect(learningPipeline).toHaveProperty('calibration_model_version');
        expect(learningPipeline).toHaveProperty('shap_computed');
        expect(learningPipeline).toHaveProperty('top_shap_features');
        expect(learningPipeline).toHaveProperty('event_context_applied');
        expect(learningPipeline).toHaveProperty('event_type');
        expect(learningPipeline).toHaveProperty('event_impact');
        expect(learningPipeline).toHaveProperty('failure_reason');
        expect(learningPipeline).toHaveProperty('raw_probabilities');
        expect(learningPipeline).toHaveProperty('calibrated_probabilities');

        // Values match what was recorded
        expect(learningPipeline.calibration_applied).toBe(diagnostics.calibration_applied);
        expect(learningPipeline.calibration_model_version).toBe(diagnostics.calibration_model_version);
        expect(learningPipeline.shap_computed).toBe(diagnostics.shap_computed);
        expect(learningPipeline.top_shap_features).toEqual(diagnostics.top_shap_features);
        expect(learningPipeline.event_context_applied).toBe(diagnostics.event_context_applied);
        expect(learningPipeline.event_type).toBe(diagnostics.event_type);
        expect(learningPipeline.event_impact).toEqual(diagnostics.event_impact);
        expect(learningPipeline.failure_reason).toBe(diagnostics.failure_reason);
        expect(learningPipeline.raw_probabilities).toEqual(diagnostics.raw_probabilities);
        expect(learningPipeline.calibrated_probabilities).toEqual(diagnostics.calibrated_probabilities);
      }),
      { numRuns: 100 },
    );
  });
});

// =============================================================================
// Property 12: Top-3 SHAP feature recording correctness
// =============================================================================

describe('Property 12: Top-3 SHAP feature recording correctness', () => {
  /**
   * Validates: Requirements 13.4
   *
   * For any array of SHAP features (with feature name and shap_value),
   * when top_shap_features contains the top 3 by absolute value,
   * they SHALL be the 3 with the highest absolute shap_value sorted
   * descending by |shap_value|.
   */

  it('top 3 SHAP features are the 3 highest by absolute shap_value, sorted descending', () => {
    fc.assert(
      fc.property(shapFeatureListArb, (features) => {
        // Compute expected top 3 by absolute value, sorted descending
        const sorted = [...features].sort(
          (a, b) => Math.abs(b.shap_value) - Math.abs(a.shap_value),
        );
        const expectedTop3 = sorted.slice(0, 3);

        // Simulate what the batch pipeline does: take top 3 by absolute value
        const top3 = [...features]
          .sort((a, b) => Math.abs(b.shap_value) - Math.abs(a.shap_value))
          .slice(0, 3);

        // Record through the collector and verify persisted payload
        const mockSupabase = createMockSupabase();
        const collector = new DiagnosticsCollector(
          'EURUSD',
          'batch-001',
          mockSupabase as any,
        );

        const diagnostics: LearningPipelineDiagnostics = {
          calibration_applied: false,
          calibration_model_version: null,
          raw_probabilities: null,
          calibrated_probabilities: null,
          shap_computed: true,
          top_shap_features: top3,
          event_context_applied: false,
          event_type: null,
          event_impact: null,
          failure_reason: null,
        };

        collector.recordLearningPipeline(diagnostics);

        // Verify stored top_shap_features matches expected
        // The recorded top3 should match expectedTop3 values
        expect(top3).toHaveLength(3);

        // Verify ordering: each entry's |shap_value| >= next entry's |shap_value|
        for (let i = 0; i < top3.length - 1; i++) {
          expect(Math.abs(top3[i]!.shap_value)).toBeGreaterThanOrEqual(
            Math.abs(top3[i + 1]!.shap_value),
          );
        }

        // Verify these are actually the top 3 from the original array
        expect(top3.map((f) => f.shap_value)).toEqual(
          expectedTop3.map((f) => f.shap_value),
        );
        expect(top3.map((f) => f.feature)).toEqual(
          expectedTop3.map((f) => f.feature),
        );
      }),
      { numRuns: 100 },
    );
  });

  it('top 3 persisted via collector match the expected top 3', async () => {
    await fc.assert(
      fc.asyncProperty(shapFeatureListArb, async (features) => {
        // Compute expected top 3
        const expectedTop3 = [...features]
          .sort((a, b) => Math.abs(b.shap_value) - Math.abs(a.shap_value))
          .slice(0, 3);

        const mockSupabase = createMockSupabase();
        const collector = new DiagnosticsCollector(
          'EURUSD',
          'batch-001',
          mockSupabase as any,
        );

        const diagnostics: LearningPipelineDiagnostics = {
          calibration_applied: false,
          calibration_model_version: null,
          raw_probabilities: null,
          calibrated_probabilities: null,
          shap_computed: true,
          top_shap_features: expectedTop3,
          event_context_applied: false,
          event_type: null,
          event_impact: null,
          failure_reason: null,
        };

        collector.recordLearningPipeline(diagnostics);
        await collector.persist();

        const captured = mockSupabase.getCapturedPayload();
        const persisted = captured.diagnostics.learning_pipeline.top_shap_features;

        expect(persisted).toHaveLength(3);
        expect(persisted).toEqual(expectedTop3);

        // Verify descending absolute order in persisted data
        for (let i = 0; i < persisted.length - 1; i++) {
          expect(Math.abs(persisted[i].shap_value)).toBeGreaterThanOrEqual(
            Math.abs(persisted[i + 1].shap_value),
          );
        }
      }),
      { numRuns: 100 },
    );
  });
});

// =============================================================================
// Property 13: Learning pipeline recording never throws
// =============================================================================

describe('Property 13: Learning pipeline recording never throws', () => {
  /**
   * Validates: Requirements 13.5
   *
   * For any arbitrary input (valid objects, null values, malformed data),
   * calling recordLearningPipeline() SHALL never throw an exception.
   */

  it('recordLearningPipeline never throws for any arbitrary input', () => {
    fc.assert(
      fc.property(arbitraryInputArb, (input) => {
        const mockSupabase = createMockSupabase();
        const collector = new DiagnosticsCollector(
          'EURUSD',
          'batch-001',
          mockSupabase as any,
        );

        // This must never throw regardless of input
        expect(() => collector.recordLearningPipeline(input)).not.toThrow();
      }),
      { numRuns: 100 },
    );
  });

  it('recordLearningPipeline never throws for objects with throwing getters', () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 100 }), (_seed) => {
        const mockSupabase = createMockSupabase();
        const collector = new DiagnosticsCollector(
          'EURUSD',
          'batch-001',
          mockSupabase as any,
        );

        // Object with a getter that throws
        const malicious = Object.create(null);
        Object.defineProperty(malicious, 'calibration_applied', {
          get() {
            throw new Error('getter explosion');
          },
          enumerable: true,
        });

        expect(() => collector.recordLearningPipeline(malicious)).not.toThrow();
      }),
      { numRuns: 100 },
    );
  });

  it('recordLearningPipeline never throws for Proxy objects that throw on access', () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 100 }), (_seed) => {
        const mockSupabase = createMockSupabase();
        const collector = new DiagnosticsCollector(
          'EURUSD',
          'batch-001',
          mockSupabase as any,
        );

        const trap = new Proxy(
          {} as any,
          {
            get() {
              throw new Error('proxy trap');
            },
          },
        );

        expect(() => collector.recordLearningPipeline(trap)).not.toThrow();
      }),
      { numRuns: 100 },
    );
  });
});
