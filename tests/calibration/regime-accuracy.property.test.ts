/**
 * Property-Based Tests for Regime Accuracy Analyser
 *
 * Feature: continuous-learning-pipeline
 *
 * Validates: Requirements 2.1, 2.2, 2.3, 2.5
 */

import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';
import { computeRegimeAccuracy } from '../../src/calibration/regime-accuracy-analyser.js';
import type { EvaluationWithContext, RegimeAccuracyResult } from '../../src/calibration/types.js';
import { arbRegime, arbAsset, arbDirection } from './helpers/arbitraries.js';
import type { CombinedRegime, Asset, Direction } from './helpers/arbitraries.js';

// =============================================================================
// Custom Arbitraries
// =============================================================================

const arbDirectionAccuracy: fc.Arbitrary<0 | 1> = fc.constantFrom(0 as const, 1 as const);

const arbCalibrationBucket: fc.Arbitrary<string> = fc.constantFrom(
  '0.0-0.1', '0.1-0.2', '0.2-0.3', '0.3-0.4', '0.4-0.5',
  '0.5-0.6', '0.6-0.7', '0.7-0.8', '0.8-0.9', '0.9-1.0',
);

const arbEvaluationWithContext: fc.Arbitrary<EvaluationWithContext> = fc.record({
  evaluation_id: fc.uuid(),
  batch_id: fc.uuid(),
  asset: arbAsset as fc.Arbitrary<string>,
  regime: arbRegime as fc.Arbitrary<string>,
  direction: fc.constantFrom('up' as const, 'down' as const, 'flat' as const),
  direction_accuracy: arbDirectionAccuracy,
  confidence_final: fc.double({ min: 0, max: 1, noNaN: true, noDefaultInfinity: true }),
  brier_score: fc.double({ min: 0, max: 1, noNaN: true, noDefaultInfinity: true }),
  calibration_bucket: arbCalibrationBucket,
  has_macro_data: fc.boolean(),
  has_sentiment_data: fc.boolean(),
  created_at: fc.integer({
    min: new Date('2023-01-01').getTime(),
    max: new Date('2025-06-01').getTime(),
  }).map((ts) => new Date(ts).toISOString()),
});

/**
 * Generates evaluations that all share the same (regime, asset, direction) to form a single group.
 */
function arbEvaluationGroup(minLength = 1, maxLength = 30): fc.Arbitrary<{
  evaluations: EvaluationWithContext[];
  regime: string;
  asset: string;
  direction: 'up' | 'down' | 'flat';
}> {
  return fc.record({
    regime: arbRegime as fc.Arbitrary<string>,
    asset: arbAsset as fc.Arbitrary<string>,
    direction: fc.constantFrom('up' as const, 'down' as const, 'flat' as const),
  }).chain(({ regime, asset, direction }) =>
    fc.array(arbEvaluationWithContext, { minLength, maxLength }).map((evals) => ({
      evaluations: evals.map((ev) => ({ ...ev, regime, asset, direction })),
      regime,
      asset,
      direction,
    })),
  );
}

/**
 * Generates a RegimeAccuracyResult for use as a previous result.
 */
const arbRegimeAccuracyResult: fc.Arbitrary<RegimeAccuracyResult> = fc.record({
  run_id: fc.uuid(),
  regime: arbRegime as fc.Arbitrary<string>,
  asset: arbAsset as fc.Arbitrary<string>,
  direction: fc.constantFrom('up' as const, 'down' as const, 'flat' as const),
  accuracy_pct: fc.double({ min: 0, max: 100, noNaN: true, noDefaultInfinity: true }),
  sample_count: fc.integer({ min: 1, max: 200 }),
  is_significant: fc.boolean(),
  is_underperforming: fc.boolean(),
  accuracy_delta: fc.oneof(fc.constant(null), fc.double({ min: -100, max: 100, noNaN: true, noDefaultInfinity: true })),
  created_at: fc.integer({
    min: new Date('2023-01-01').getTime(),
    max: new Date('2025-06-01').getTime(),
  }).map((ts) => new Date(ts).toISOString()),
});

// =============================================================================
// Helper
// =============================================================================

function roundTo2(value: number): number {
  return Math.round(value * 100) / 100;
}

// =============================================================================
// Property 5: Direction accuracy computation
// =============================================================================

describe('Feature: continuous-learning-pipeline, Property 5: Direction accuracy computation', () => {
  /**
   * Validates: Requirements 2.1
   *
   * For any non-empty group of evaluations sharing the same (regime, asset, direction)
   * combination, the computed accuracy_pct SHALL equal (count of direction_accuracy === 1) /
   * (total count) × 100, rounded to 2 decimal places.
   */
  it('accuracy_pct equals (correct / total) × 100 rounded to 2dp for each group', () => {
    fc.assert(
      fc.property(
        arbEvaluationGroup(1, 50),
        fc.uuid(),
        ({ evaluations, regime, asset, direction }, runId) => {
          const results = computeRegimeAccuracy(evaluations, null, runId);

          // Find the result matching our group
          const result = results.find(
            (r) => r.regime === regime && r.asset === asset && r.direction === direction,
          );

          expect(result).toBeDefined();

          // Compute expected accuracy
          const correctCount = evaluations.filter((ev) => ev.direction_accuracy === 1).length;
          const expectedAccuracy = roundTo2((correctCount / evaluations.length) * 100);

          expect(result!.accuracy_pct).toBe(expectedAccuracy);
          expect(result!.sample_count).toBe(evaluations.length);
        },
      ),
      { numRuns: 100 },
    );
  });
});

// =============================================================================
// Property 6: Statistical significance classification
// =============================================================================

describe('Feature: continuous-learning-pipeline, Property 6: Statistical significance classification', () => {
  /**
   * Validates: Requirements 2.2
   *
   * For any regime-asset accuracy result, is_significant SHALL be true if and only if
   * sample_count >= 30.
   */
  it('is_significant is true iff sample_count >= 30', () => {
    fc.assert(
      fc.property(
        arbEvaluationGroup(1, 50),
        fc.uuid(),
        ({ evaluations, regime, asset, direction }, runId) => {
          const results = computeRegimeAccuracy(evaluations, null, runId);

          const result = results.find(
            (r) => r.regime === regime && r.asset === asset && r.direction === direction,
          );

          expect(result).toBeDefined();

          if (evaluations.length >= 30) {
            expect(result!.is_significant).toBe(true);
          } else {
            expect(result!.is_significant).toBe(false);
          }
        },
      ),
      { numRuns: 100 },
    );
  });
});

// =============================================================================
// Property 7: Underperforming classification
// =============================================================================

describe('Feature: continuous-learning-pipeline, Property 7: Underperforming classification', () => {
  /**
   * Validates: Requirements 2.3
   *
   * For any regime-asset accuracy result, is_underperforming SHALL be true if and only if
   * accuracy_pct < 40.
   */
  it('is_underperforming is true iff accuracy_pct < 40', () => {
    fc.assert(
      fc.property(
        arbEvaluationGroup(1, 50),
        fc.uuid(),
        ({ evaluations, regime, asset, direction }, runId) => {
          const results = computeRegimeAccuracy(evaluations, null, runId);

          const result = results.find(
            (r) => r.regime === regime && r.asset === asset && r.direction === direction,
          );

          expect(result).toBeDefined();

          const correctCount = evaluations.filter((ev) => ev.direction_accuracy === 1).length;
          const expectedAccuracy = roundTo2((correctCount / evaluations.length) * 100);

          if (expectedAccuracy < 40) {
            expect(result!.is_underperforming).toBe(true);
          } else {
            expect(result!.is_underperforming).toBe(false);
          }
        },
      ),
      { numRuns: 100 },
    );
  });
});

// =============================================================================
// Property 8: Accuracy delta computation
// =============================================================================

describe('Feature: continuous-learning-pipeline, Property 8: Accuracy delta computation', () => {
  /**
   * Validates: Requirements 2.5
   *
   * For any regime-asset combination present in both the current run and the previous run,
   * accuracy_delta SHALL equal current_accuracy_pct minus previous_accuracy_pct.
   * If the combination is absent from the previous run, accuracy_delta SHALL be null.
   */
  it('accuracy_delta equals current - previous when previous exists, null otherwise', () => {
    fc.assert(
      fc.property(
        arbEvaluationGroup(1, 30),
        arbRegimeAccuracyResult,
        fc.uuid(),
        fc.boolean(),
        ({ evaluations, regime, asset, direction }, prevResult, runId, hasPrevious) => {
          // Build a previous result that matches the same (regime, asset, direction)
          const matchingPrev: RegimeAccuracyResult = {
            ...prevResult,
            regime,
            asset,
            direction,
          };

          const previousResults = hasPrevious ? [matchingPrev] : [];
          const results = computeRegimeAccuracy(evaluations, previousResults, runId);

          const result = results.find(
            (r) => r.regime === regime && r.asset === asset && r.direction === direction,
          );

          expect(result).toBeDefined();

          if (hasPrevious) {
            const expectedDelta = roundTo2(result!.accuracy_pct - matchingPrev.accuracy_pct);
            expect(result!.accuracy_delta).toBe(expectedDelta);
          } else {
            expect(result!.accuracy_delta).toBeNull();
          }
        },
      ),
      { numRuns: 100 },
    );
  });
});
