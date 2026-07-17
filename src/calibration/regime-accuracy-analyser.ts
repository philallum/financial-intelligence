/**
 * Regime Accuracy Analyser
 *
 * Computes direction accuracy metrics for each regime-asset-direction combination.
 * Pure function — no side effects, no DB I/O.
 *
 * Requirements: 2.1, 2.2, 2.3, 2.5
 */

import type { EvaluationWithContext, RegimeAccuracyResult } from './types.js';
import { SIGNIFICANCE_THRESHOLD, UNDERPERFORMING_THRESHOLD } from './constants.js';

/**
 * Rounds a number to 2 decimal places using standard rounding.
 */
function roundTo2(value: number): number {
  return Math.round(value * 100) / 100;
}

/**
 * Computes direction accuracy results for all regime-asset-direction groups
 * that have at least one evaluation.
 *
 * For each group:
 * - accuracy_pct = (sum of direction_accuracy / count) × 100, rounded to 2 decimal places
 * - is_significant = sample_count >= SIGNIFICANCE_THRESHOLD (30)
 * - is_underperforming = accuracy_pct < UNDERPERFORMING_THRESHOLD (40)
 * - accuracy_delta = current accuracy - previous accuracy for the same group, or null
 *
 * Requirements: 2.1, 2.2, 2.3, 2.5
 *
 * @param evaluations - Evaluated forecasts with regime, asset, direction context
 * @param previousResults - Results from the previous calibration run (null if first run)
 * @param runId - Unique identifier for this calibration run
 * @returns Array of RegimeAccuracyResult for groups with at least 1 evaluation
 */
export function computeRegimeAccuracy(
  evaluations: EvaluationWithContext[],
  previousResults: RegimeAccuracyResult[] | null,
  runId: string,
): RegimeAccuracyResult[] {
  if (evaluations.length === 0) return [];

  const now = new Date().toISOString();

  // Group evaluations by (regime, asset, direction)
  const groups = new Map<string, EvaluationWithContext[]>();
  for (const ev of evaluations) {
    const key = `${ev.regime}|${ev.asset}|${ev.direction}`;
    const group = groups.get(key);
    if (group) {
      group.push(ev);
    } else {
      groups.set(key, [ev]);
    }
  }

  // Index previous results by (regime, asset, direction) for delta lookup
  const previousMap = new Map<string, RegimeAccuracyResult>();
  if (previousResults) {
    for (const prev of previousResults) {
      const key = `${prev.regime}|${prev.asset}|${prev.direction}`;
      previousMap.set(key, prev);
    }
  }

  // Compute results for each group
  const results: RegimeAccuracyResult[] = [];

  for (const [key, groupEvaluations] of groups) {
    const [regime, asset, direction] = key.split('|');
    const sampleCount = groupEvaluations.length;
    const correctCount = groupEvaluations.reduce((sum, ev) => sum + ev.direction_accuracy, 0);
    const accuracyPct = roundTo2((correctCount / sampleCount) * 100);

    const isSignificant = sampleCount >= SIGNIFICANCE_THRESHOLD;
    const isUnderperforming = accuracyPct < UNDERPERFORMING_THRESHOLD;

    // Compute accuracy delta vs previous run
    const previousResult = previousMap.get(key);
    const accuracyDelta = previousResult != null
      ? roundTo2(accuracyPct - previousResult.accuracy_pct)
      : null;

    results.push({
      run_id: runId,
      regime,
      asset,
      direction: direction as 'up' | 'down' | 'flat',
      accuracy_pct: accuracyPct,
      sample_count: sampleCount,
      is_significant: isSignificant,
      is_underperforming: isUnderperforming,
      accuracy_delta: accuracyDelta,
      created_at: now,
    });
  }

  return results;
}
