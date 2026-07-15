/**
 * Property-Based Tests for Dashboard Continuous Learning Card
 *
 * Property 14: Dashboard renders all learning pipeline component statuses
 * Property 15: Dashboard drift alert detail rendering
 *
 * Validates: Requirements 14.1, 14.4, 14.5
 */

import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';
import {
  renderContinuousLearningCard,
  type LearningPipelineDiagnostics,
  type DiagRow,
  type DriftAlertRow,
} from '../continuous-learning-card.js';

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
  feature: fc.string({ minLength: 1, maxLength: 20 }),
  shap_value: fc.float({ min: -10, max: 10, noNaN: true, noDefaultInfinity: true }),
});

/** Generator for event impact. */
const eventImpactArb = fc.record({
  median_move_pips: fc.float({ min: 0, max: 500, noNaN: true, noDefaultInfinity: true }),
  direction_skew: fc.float({ min: 0, max: 1, noNaN: true, noDefaultInfinity: true }),
  vol_expansion_ratio: fc.float({ min: 0, max: 10, noNaN: true, noDefaultInfinity: true }),
});

/** Generator for a valid LearningPipelineDiagnostics object. */
const validDiagnosticsArb: fc.Arbitrary<LearningPipelineDiagnostics> = fc.record({
  calibration_applied: fc.boolean(),
  calibration_model_version: fc.oneof(
    fc.string({ minLength: 1, maxLength: 30 }),
    fc.constant(null),
  ),
  raw_probabilities: fc.oneof(probVectorArb, fc.constant(null)),
  calibrated_probabilities: fc.oneof(probVectorArb, fc.constant(null)),
  shap_computed: fc.boolean(),
  top_shap_features: fc.oneof(
    fc.array(shapFeatureArb, { minLength: 1, maxLength: 3 }),
    fc.constant(null),
  ),
  event_context_applied: fc.boolean(),
  event_type: fc.oneof(fc.string({ minLength: 1, maxLength: 30 }), fc.constant(null)),
  event_impact: fc.oneof(eventImpactArb, fc.constant(null)),
  failure_reason: fc.oneof(fc.string({ minLength: 1, maxLength: 50 }), fc.constant(null)),
});

/** Generator for a recent ISO date (within last 24 hours). */
const recentDateArb = fc.integer({ min: 1, max: 24 * 60 * 60 * 1000 }).map((msAgo) => {
  return new Date(Date.now() - msAgo).toISOString();
});

/** Generator for a DiagRow containing learning_pipeline diagnostics. */
const diagRowArb: fc.Arbitrary<DiagRow> = fc.record({
  asset: fc.constantFrom('EURUSD', 'GBPUSD', 'USDJPY'),
  batch_id: fc.uuid(),
  updated_at: recentDateArb,
  diagnostics: validDiagnosticsArb.map((lp) => ({
    learning_pipeline: lp,
  })),
});

/** Generator for an array of 5 DiagRows (for timeline tests). */
const fiveDiagRowsArb: fc.Arbitrary<DiagRow[]> = fc.array(diagRowArb, {
  minLength: 5,
  maxLength: 5,
});

/** Generator for a valid DriftAlertRow detected within last 7 days. */
const driftAlertRowArb: fc.Arbitrary<DriftAlertRow> = fc.record({
  id: fc.uuid(),
  regime: fc.constantFrom('HIGH', 'LOW', 'NORMAL', 'VOLATILE'),
  detected_at: fc.integer({ min: 1, max: 7 * 24 * 60 * 60 * 1000 }).map((msAgo) => {
    return new Date(Date.now() - msAgo).toISOString();
  }),
  rolling_accuracy: fc.float({ min: 0, max: 1, noNaN: true, noDefaultInfinity: true }),
  baseline_accuracy: fc.float({ min: 0, max: 1, noNaN: true, noDefaultInfinity: true }),
  sigma: fc.float({ min: Math.fround(0.01), max: Math.fround(0.5), noNaN: true, noDefaultInfinity: true }),
  deviation_sigmas: fc.float({ min: Math.fround(2), max: Math.fround(10), noNaN: true, noDefaultInfinity: true }),
  retrain_triggered: fc.boolean(),
  retrain_outcome: fc.oneof(
    fc.record({
      status: fc.constantFrom('trained', 'failed'),
      accuracy: fc.float({ min: 0, max: 1, noNaN: true, noDefaultInfinity: true }),
    }),
    fc.constant(null),
  ),
  resolved_at: fc.oneof(recentDateArb, fc.constant(null)),
});

// =============================================================================
// Property 14: Dashboard renders all learning pipeline component statuses
// =============================================================================

describe('Property 14: Dashboard renders all learning pipeline component statuses', () => {
  /**
   * Validates: Requirements 14.1, 14.5
   *
   * For any valid LearningPipelineDiagnostics object, the rendered HTML SHALL
   * contain status indicators for ALL four components: calibration, SHAP, event
   * context, and drift. Verify that:
   * - The HTML contains calibration status text (Applied/Not Applied)
   * - The HTML contains SHAP status text (Computed/Skipped)
   * - The HTML contains event context status text (Applied/Not Applied)
   * - The HTML contains drift status text (Healthy/Detected)
   * - When calibration_applied is false, a warning indicator (⚠️) is present
   */
  it('rendered HTML contains status indicators for all four components', () => {
    fc.assert(
      fc.property(validDiagnosticsArb, (diagnostics) => {
        const diagRow: DiagRow = {
          asset: 'EURUSD',
          batch_id: 'test-batch-001',
          updated_at: new Date().toISOString(),
          diagnostics: { learning_pipeline: diagnostics },
        };

        const html = renderContinuousLearningCard([diagRow], []);

        // Calibration status must be present
        if (diagnostics.calibration_applied) {
          expect(html).toContain('Applied');
        } else {
          expect(html).toContain('Not Applied');
        }

        // SHAP status must be present
        if (diagnostics.shap_computed) {
          expect(html).toContain('Computed');
        } else {
          expect(html).toContain('Skipped');
        }

        // Event context status must be present
        if (diagnostics.event_context_applied) {
          // "Applied" is in the HTML for event context
          expect(html).toContain('Event Context');
          expect(html).toContain('Applied');
        } else {
          expect(html).toContain('Event Context');
          expect(html).toContain('Not Applied');
        }

        // Drift status (no drift rows = Healthy)
        expect(html).toContain('Drift Detection');
        expect(html).toContain('Healthy');

        // Calibration warning when not applied
        if (!diagnostics.calibration_applied) {
          expect(html).toContain('⚠️');
        }
      }),
      { numRuns: 100 },
    );
  });

  it('timeline renders exactly 5 entries when provided 5 batch diagnostics rows', () => {
    fc.assert(
      fc.property(fiveDiagRowsArb, (diagRows) => {
        const html = renderContinuousLearningCard(diagRows, []);

        // The timeline section should contain "Last 5 Cycles"
        expect(html).toContain('Last 5 Batch Cycles');

        // Count timeline entries by the Calibration status-dot titles
        const calibrationDots = html.match(/title="Calibration"/g);
        expect(calibrationDots).not.toBeNull();
        expect(calibrationDots!.length).toBe(5);

        // Each entry has SHAP, Event Context, and No Failures dots
        const shapDots = html.match(/title="SHAP"/g);
        expect(shapDots).not.toBeNull();
        expect(shapDots!.length).toBe(5);

        const eventDots = html.match(/title="Event Context"/g);
        expect(eventDots).not.toBeNull();
        expect(eventDots!.length).toBe(5);

        const statusDots = html.match(/title="No Failures"/g);
        expect(statusDots).not.toBeNull();
        expect(statusDots!.length).toBe(5);
      }),
      { numRuns: 100 },
    );
  });
});

// =============================================================================
// Property 15: Dashboard drift alert detail rendering
// =============================================================================

describe('Property 15: Dashboard drift alert detail rendering', () => {
  /**
   * Validates: Requirements 14.4
   *
   * For any valid drift alert row with drift detected within 7 days, the
   * rendered HTML SHALL contain:
   * - The regime name from the drift alert
   * - The deviation_sigmas value
   * - The retrain status (triggered or not)
   */
  it('rendered HTML contains drift alert details: regime, deviation, and retrain status', () => {
    fc.assert(
      fc.property(diagRowArb, driftAlertRowArb, (diagRow, driftAlert) => {
        const html = renderContinuousLearningCard([diagRow], [driftAlert]);

        // HTML must contain the regime name
        expect(html).toContain(driftAlert.regime);

        // HTML must contain the deviation_sigmas value (formatted to 1dp + σ)
        const expectedDeviation = driftAlert.deviation_sigmas.toFixed(1) + 'σ';
        expect(html).toContain(expectedDeviation);

        // HTML must contain retrain status
        if (driftAlert.retrain_triggered) {
          // When retrain is triggered, the alert bar shows "Retraining triggered"
          expect(html).toContain('Retraining triggered');
        } else {
          expect(html).toContain('not triggered');
        }

        // Drift Detection should show "Drift Detected"
        expect(html).toContain('Drift Detected');
      }),
      { numRuns: 100 },
    );
  });
});
