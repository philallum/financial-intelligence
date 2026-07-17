/**
 * Property-Based Tests for Stage Contribution Tracker
 *
 * Feature: continuous-learning-pipeline
 *
 * Validates: Requirements 1.1, 1.2, 1.3, 1.5
 */

import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';
import {
  computeContributions,
  identifyDominantLayer,
  computeMarginalAccuracyDelta,
} from '../../src/calibration/stage-contribution-tracker.js';
import { arbLayerBreakdown, arbRegime, arbAsset } from './helpers/arbitraries.js';
import type { EvaluationWithContext, SimilarityArchiveRecord } from '../../src/calibration/types.js';
import type { CombinedRegime, Asset } from './helpers/arbitraries.js';

// =============================================================================
// Custom Arbitraries for EvaluationWithContext
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

const arbSimilarityArchiveRecord: fc.Arbitrary<SimilarityArchiveRecord> = fc.record({
  fingerprint_id: fc.uuid(),
  match_fingerprint_id: fc.uuid(),
  similarity_score: fc.double({ min: 0, max: 1, noNaN: true, noDefaultInfinity: true }),
  layer_breakdown: arbLayerBreakdown,
  rank: fc.integer({ min: 1, max: 50 }),
  batch_id: fc.uuid(),
  regime: arbRegime as fc.Arbitrary<string>,
  asset: arbAsset as fc.Arbitrary<string>,
  created_at: fc.integer({
    min: new Date('2023-01-01').getTime(),
    max: new Date('2025-06-01').getTime(),
  }).map((ts) => new Date(ts).toISOString()),
});

// =============================================================================
// Pipeline stages constant (must match the source)
// =============================================================================

const PIPELINE_STAGES = ['similarity', 'macro', 'sentiment', 'regime', 'confidence', 'outcome'] as const;

// =============================================================================
// Property 1: Contribution scores are bounded and complete
// =============================================================================

describe('Feature: continuous-learning-pipeline, Property 1: Contribution scores are bounded and complete', () => {
  /**
   * Validates: Requirements 1.1
   *
   * For any set of evaluated forecasts with stage outputs, produce exactly one
   * contribution score per pipeline stage per evaluation, and every contribution
   * score SHALL be in [-1, 1].
   */
  it('produces exactly one contribution per stage per evaluation, all scores in [-1, 1]', () => {
    fc.assert(
      fc.property(
        fc.array(arbEvaluationWithContext, { minLength: 1, maxLength: 20 }),
        fc.array(arbSimilarityArchiveRecord, { minLength: 0, maxLength: 10 }),
        (evaluations, similarityRecords) => {
          const results = computeContributions(evaluations, similarityRecords);

          // Exactly one contribution per stage per evaluation
          expect(results.length).toBe(evaluations.length * PIPELINE_STAGES.length);

          // Each evaluation should have exactly 6 contributions (one per stage)
          for (const ev of evaluations) {
            const evContribs = results.filter((r) => r.evaluation_id === ev.evaluation_id);
            expect(evContribs.length).toBe(PIPELINE_STAGES.length);

            const stageNames = evContribs.map((c) => c.stage_name).sort();
            expect(stageNames).toEqual([...PIPELINE_STAGES].sort());
          }

          // All contribution scores in [-1, 1]
          for (const result of results) {
            expect(result.contribution_score).toBeGreaterThanOrEqual(-1);
            expect(result.contribution_score).toBeLessThanOrEqual(1);
          }
        },
      ),
      { numRuns: 100 },
    );
  });
});

// =============================================================================
// Property 2: Layer dominant identification correctness
// =============================================================================

describe('Feature: continuous-learning-pipeline, Property 2: Layer dominant identification correctness', () => {
  /**
   * Validates: Requirements 1.2
   *
   * For any similarity archive record with a valid layer_breakdown containing all 5
   * layer scores, the identified layer_dominant SHALL be the layer with the maximum
   * breakdown value. In the case of ties, the layer with the lowest index (L1 < L2 < ... < L5) wins.
   */
  it('identifies the layer with the maximum breakdown value, ties broken by lowest index', () => {
    fc.assert(
      fc.property(arbLayerBreakdown, (breakdown) => {
        const result = identifyDominantLayer(breakdown);

        // Map layer names to breakdown keys (ordered L1 -> L5)
        const layerOrder: Array<{ layer: string; key: keyof typeof breakdown }> = [
          { layer: 'L1', key: 'market_structure' },
          { layer: 'L2', key: 'volatility' },
          { layer: 'L3', key: 'liquidity' },
          { layer: 'L4', key: 'macro' },
          { layer: 'L5', key: 'sentiment' },
        ];

        // Find the expected dominant layer: max value, lowest index on tie
        let maxValue = -Infinity;
        let expectedLayer = 'L1';
        for (const { layer, key } of layerOrder) {
          if (breakdown[key] > maxValue) {
            maxValue = breakdown[key];
            expectedLayer = layer;
          }
        }

        expect(result).toBe(expectedLayer);
      }),
      { numRuns: 100 },
    );
  });
});

// =============================================================================
// Property 3: Marginal accuracy delta correctness
// =============================================================================

describe('Feature: continuous-learning-pipeline, Property 3: Marginal accuracy delta correctness', () => {
  /**
   * Validates: Requirements 1.3
   *
   * For any set of evaluated forecasts partitioned into those with macro/sentiment data
   * present and those without, the marginal_accuracy_delta SHALL equal the difference
   * between the mean direction accuracy of the "with" group and the mean direction
   * accuracy of the "without" group.
   */
  it('marginal accuracy delta equals mean(with) - mean(without) for macro data', () => {
    fc.assert(
      fc.property(
        fc.array(arbEvaluationWithContext, { minLength: 2, maxLength: 30 }),
        (evaluations) => {
          const withGroup = evaluations.filter((e) => e.has_macro_data);
          const withoutGroup = evaluations.filter((e) => !e.has_macro_data);

          const result = computeMarginalAccuracyDelta(evaluations, 'has_macro_data');

          if (withGroup.length === 0 || withoutGroup.length === 0) {
            // If either group is empty, result should be undefined
            expect(result).toBeUndefined();
          } else {
            // Compute expected delta manually
            const meanWith = withGroup.reduce((sum, e) => sum + e.direction_accuracy, 0) / withGroup.length;
            const meanWithout = withoutGroup.reduce((sum, e) => sum + e.direction_accuracy, 0) / withoutGroup.length;
            const expectedDelta = meanWith - meanWithout;

            expect(result).toBeCloseTo(expectedDelta, 10);
          }
        },
      ),
      { numRuns: 100 },
    );
  });

  it('marginal accuracy delta equals mean(with) - mean(without) for sentiment data', () => {
    fc.assert(
      fc.property(
        fc.array(arbEvaluationWithContext, { minLength: 2, maxLength: 30 }),
        (evaluations) => {
          const withGroup = evaluations.filter((e) => e.has_sentiment_data);
          const withoutGroup = evaluations.filter((e) => !e.has_sentiment_data);

          const result = computeMarginalAccuracyDelta(evaluations, 'has_sentiment_data');

          if (withGroup.length === 0 || withoutGroup.length === 0) {
            expect(result).toBeUndefined();
          } else {
            const meanWith = withGroup.reduce((sum, e) => sum + e.direction_accuracy, 0) / withGroup.length;
            const meanWithout = withoutGroup.reduce((sum, e) => sum + e.direction_accuracy, 0) / withoutGroup.length;
            const expectedDelta = meanWith - meanWithout;

            expect(result).toBeCloseTo(expectedDelta, 10);
          }
        },
      ),
      { numRuns: 100 },
    );
  });
});

// =============================================================================
// Property 4: Low-confidence marking threshold
// =============================================================================

describe('Feature: continuous-learning-pipeline, Property 4: Low-confidence marking threshold', () => {
  /**
   * Validates: Requirements 1.5
   *
   * For any asset and regime combination, contribution results SHALL have
   * is_low_confidence set to true if and only if the evaluated forecast count
   * for that (asset, regime) pair is fewer than 10.
   */
  it('is_low_confidence is true iff fewer than 10 evaluations exist for (asset, regime) pair', () => {
    fc.assert(
      fc.property(
        fc.array(arbEvaluationWithContext, { minLength: 1, maxLength: 30 }),
        fc.array(arbSimilarityArchiveRecord, { minLength: 0, maxLength: 5 }),
        (evaluations, similarityRecords) => {
          const results = computeContributions(evaluations, similarityRecords);

          // Count evaluations per (asset, regime) pair
          const pairCounts = new Map<string, number>();
          for (const ev of evaluations) {
            const key = `${ev.asset}|${ev.regime}`;
            pairCounts.set(key, (pairCounts.get(key) ?? 0) + 1);
          }

          // Check each contribution result
          for (const contribution of results) {
            const key = `${contribution.asset}|${contribution.regime}`;
            const count = pairCounts.get(key) ?? 0;

            if (count < 10) {
              expect(contribution.is_low_confidence).toBe(true);
            } else {
              expect(contribution.is_low_confidence).toBe(false);
            }
          }
        },
      ),
      { numRuns: 100 },
    );
  });
});
