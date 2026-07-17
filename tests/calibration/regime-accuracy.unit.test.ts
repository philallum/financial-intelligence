/**
 * Unit tests for Regime Accuracy Breakdown (computeRegimeAccuracy).
 *
 * Validates: Requirements 2.1, 2.2, 2.3, 2.5
 */
import { describe, it, expect } from 'vitest';
import { computeRegimeAccuracy } from '../../src/calibration/regime-accuracy-analyser.js';
import type { EvaluationWithContext, RegimeAccuracyResult } from '../../src/calibration/types.js';

// --- Helper to create EvaluationWithContext ---

function makeEvaluation(overrides?: Partial<EvaluationWithContext>): EvaluationWithContext {
  return {
    evaluation_id: crypto.randomUUID(),
    batch_id: 'batch-001',
    asset: 'EURUSD',
    regime: 'NORMAL_BULLISH',
    direction: 'up',
    direction_accuracy: 1,
    confidence_final: 0.75,
    brier_score: 0.2,
    calibration_bucket: '0.7-0.8',
    has_macro_data: true,
    has_sentiment_data: true,
    created_at: '2024-06-15T08:00:00.000Z',
    ...overrides,
  };
}

/**
 * Creates an array of evaluations for a single group with a specified number correct.
 */
function makeGroupEvaluations(
  count: number,
  correctCount: number,
  groupOverrides?: Partial<EvaluationWithContext>,
): EvaluationWithContext[] {
  const evals: EvaluationWithContext[] = [];
  for (let i = 0; i < count; i++) {
    evals.push(
      makeEvaluation({
        direction_accuracy: i < correctCount ? 1 : 0,
        ...groupOverrides,
      }),
    );
  }
  return evals;
}

describe('computeRegimeAccuracy', () => {
  const RUN_ID = 'run-001';

  it('returns empty results when evaluations is empty', () => {
    const result = computeRegimeAccuracy([], null, RUN_ID);
    expect(result).toEqual([]);
  });

  it('returns is_significant = true when sample count is exactly 30', () => {
    const evaluations = makeGroupEvaluations(30, 15);
    const results = computeRegimeAccuracy(evaluations, null, RUN_ID);

    expect(results).toHaveLength(1);
    expect(results[0].sample_count).toBe(30);
    expect(results[0].is_significant).toBe(true);
  });

  it('returns is_significant = false when sample count is exactly 29', () => {
    const evaluations = makeGroupEvaluations(29, 15);
    const results = computeRegimeAccuracy(evaluations, null, RUN_ID);

    expect(results).toHaveLength(1);
    expect(results[0].sample_count).toBe(29);
    expect(results[0].is_significant).toBe(false);
  });

  it('returns is_underperforming = false when accuracy is exactly 40.00%', () => {
    // 2 correct out of 5 = 40.00%
    const evaluations = makeGroupEvaluations(5, 2);
    const results = computeRegimeAccuracy(evaluations, null, RUN_ID);

    expect(results).toHaveLength(1);
    expect(results[0].accuracy_pct).toBe(40);
    expect(results[0].is_underperforming).toBe(false);
  });

  it('returns is_underperforming = true when accuracy is below 40%', () => {
    // 1 correct out of 3 = 33.33%
    const evaluations = makeGroupEvaluations(3, 1);
    const results = computeRegimeAccuracy(evaluations, null, RUN_ID);

    expect(results).toHaveLength(1);
    expect(results[0].accuracy_pct).toBeLessThan(40);
    expect(results[0].is_underperforming).toBe(true);
  });

  it('returns accuracy_delta = null when no previous run exists', () => {
    const evaluations = makeGroupEvaluations(10, 5);
    const results = computeRegimeAccuracy(evaluations, null, RUN_ID);

    expect(results).toHaveLength(1);
    expect(results[0].accuracy_delta).toBeNull();
  });

  it('computes accuracy_delta correctly when previous results exist', () => {
    // First run: 6 correct out of 10 = 60%
    const evaluations1 = makeGroupEvaluations(10, 6);
    const firstResults = computeRegimeAccuracy(evaluations1, null, 'run-001');

    expect(firstResults).toHaveLength(1);
    expect(firstResults[0].accuracy_pct).toBe(60);

    // Second run: 8 correct out of 10 = 80%
    const evaluations2 = makeGroupEvaluations(10, 8);
    const secondResults = computeRegimeAccuracy(evaluations2, firstResults, 'run-002');

    expect(secondResults).toHaveLength(1);
    expect(secondResults[0].accuracy_pct).toBe(80);
    // delta = 80 - 60 = 20
    expect(secondResults[0].accuracy_delta).toBe(20);
  });
});
