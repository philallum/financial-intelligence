/**
 * Stage Contribution Tracker
 *
 * Decomposes evaluated forecasts into per-stage influence scores.
 * Pure function — no side effects, no DB I/O.
 *
 * Requirements: 1.1, 1.2, 1.3, 1.5
 */

import type { EvaluationWithContext, SimilarityArchiveRecord, StageContribution } from './types.js';
import { LOW_CONFIDENCE_THRESHOLD, LAYER_DESCRIPTIONS, ALL_LAYERS } from './constants.js';
import type { LayerName } from './constants.js';

/**
 * The pipeline stages tracked for contribution scoring.
 */
const PIPELINE_STAGES = [
  'similarity',
  'macro',
  'sentiment',
  'regime',
  'confidence',
  'outcome',
] as const;

type PipelineStage = (typeof PIPELINE_STAGES)[number];

/**
 * Reverse mapping from layer_breakdown key to layer name (L1-L5).
 */
const BREAKDOWN_KEY_TO_LAYER: Record<string, LayerName> = Object.fromEntries(
  ALL_LAYERS.map((layer) => [LAYER_DESCRIPTIONS[layer], layer]),
) as Record<string, LayerName>;

/**
 * Clamps a value to the range [-1, 1].
 */
function clamp(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(-1, Math.min(1, value));
}

/**
 * Identifies the dominant layer from a layer breakdown.
 * Returns the layer with the maximum breakdown value.
 * Ties go to the lowest index (L1 < L2 < ... < L5).
 */
export function identifyDominantLayer(breakdown: SimilarityArchiveRecord['layer_breakdown']): LayerName {
  let maxValue = -Infinity;
  let dominant: LayerName = 'L1';

  for (const layer of ALL_LAYERS) {
    const key = LAYER_DESCRIPTIONS[layer];
    const value = breakdown[key as keyof typeof breakdown];
    if (value > maxValue) {
      maxValue = value;
      dominant = layer;
    }
    // On tie, lowest index wins — since we iterate L1→L5, first one stays
  }

  return dominant;
}

/**
 * Computes marginal accuracy delta for a binary stage (macro or sentiment).
 * Returns mean(direction_accuracy of "with" group) - mean(direction_accuracy of "without" group).
 * Returns undefined if either group is empty.
 */
export function computeMarginalAccuracyDelta(
  evaluations: EvaluationWithContext[],
  hasDataField: 'has_macro_data' | 'has_sentiment_data',
): number | undefined {
  const withGroup = evaluations.filter((e) => e[hasDataField]);
  const withoutGroup = evaluations.filter((e) => !e[hasDataField]);

  if (withGroup.length === 0 || withoutGroup.length === 0) {
    return undefined;
  }

  const meanWith = withGroup.reduce((sum, e) => sum + e.direction_accuracy, 0) / withGroup.length;
  const meanWithout = withoutGroup.reduce((sum, e) => sum + e.direction_accuracy, 0) / withoutGroup.length;

  return meanWith - meanWithout;
}

/**
 * Computes the Pearson correlation coefficient between two arrays of numbers.
 * Returns 0 if the arrays have fewer than 2 elements or if either has zero variance.
 */
function pearsonCorrelation(xs: number[], ys: number[]): number {
  const n = xs.length;
  if (n < 2) return 0;

  const meanX = xs.reduce((s, v) => s + v, 0) / n;
  const meanY = ys.reduce((s, v) => s + v, 0) / n;

  let numerator = 0;
  let denomX = 0;
  let denomY = 0;

  for (let i = 0; i < n; i++) {
    const dx = xs[i] - meanX;
    const dy = ys[i] - meanY;
    numerator += dx * dy;
    denomX += dx * dx;
    denomY += dy * dy;
  }

  const denom = Math.sqrt(denomX * denomY);
  if (denom === 0) return 0;

  return numerator / denom;
}

/**
 * Computes a contribution score for a given stage based on evaluation data.
 * - similarity: correlation of composite_similarity with direction_accuracy
 * - macro: point-biserial correlation of has_macro_data with direction_accuracy
 * - sentiment: point-biserial correlation of has_sentiment_data with direction_accuracy
 * - regime/confidence/outcome: correlation of confidence_final with direction_accuracy
 */
function computeStageScore(
  stage: PipelineStage,
  evaluations: EvaluationWithContext[],
  similarityMap: Map<string, SimilarityArchiveRecord[]>,
): number {
  if (evaluations.length < 2) return 0;

  const accuracies = evaluations.map((e) => e.direction_accuracy);

  switch (stage) {
    case 'similarity': {
      // Correlation of composite similarity scores with direction accuracy
      const scores: number[] = [];
      const accs: number[] = [];
      for (const ev of evaluations) {
        const records = similarityMap.get(ev.batch_id);
        if (records && records.length > 0) {
          // Use the mean composite similarity for this evaluation's batch
          const mean = records.reduce((s, r) => s + r.similarity_score, 0) / records.length;
          scores.push(mean);
          accs.push(ev.direction_accuracy);
        }
      }
      return scores.length >= 2 ? pearsonCorrelation(scores, accs) : 0;
    }
    case 'macro': {
      const binaryValues = evaluations.map((e) => (e.has_macro_data ? 1 : 0));
      return pearsonCorrelation(binaryValues, accuracies);
    }
    case 'sentiment': {
      const binaryValues = evaluations.map((e) => (e.has_sentiment_data ? 1 : 0));
      return pearsonCorrelation(binaryValues, accuracies);
    }
    case 'regime':
    case 'confidence':
    case 'outcome': {
      // Use confidence_final as a proxy for these stages
      const confidences = evaluations.map((e) => e.confidence_final);
      return pearsonCorrelation(confidences, accuracies);
    }
  }
}

/**
 * Computes per-stage contribution scores for a set of evaluated forecasts.
 *
 * For each evaluation × stage combination, produces one StageContribution record.
 * - contribution_score is bounded to [-1, 1]
 * - layer_dominant is set only for the 'similarity' stage
 * - marginal_accuracy_delta is set only for 'macro' and 'sentiment' stages
 * - is_low_confidence is true when the (asset, regime) pair has < LOW_CONFIDENCE_THRESHOLD evaluations
 *
 * Requirements: 1.1, 1.2, 1.3, 1.5
 */
export function computeContributions(
  evaluations: EvaluationWithContext[],
  similarityRecords: SimilarityArchiveRecord[],
): StageContribution[] {
  if (evaluations.length === 0) return [];

  const now = new Date().toISOString();

  // Count evaluations per (asset, regime) pair for low-confidence marking
  const pairCounts = new Map<string, number>();
  for (const ev of evaluations) {
    const key = `${ev.asset}|${ev.regime}`;
    pairCounts.set(key, (pairCounts.get(key) ?? 0) + 1);
  }

  // Index similarity records by batch_id for fast lookup
  const similarityByBatch = new Map<string, SimilarityArchiveRecord[]>();
  for (const rec of similarityRecords) {
    const existing = similarityByBatch.get(rec.batch_id);
    if (existing) {
      existing.push(rec);
    } else {
      similarityByBatch.set(rec.batch_id, [rec]);
    }
  }

  // Compute marginal accuracy deltas (shared across all evaluations)
  const macroMarginalDelta = computeMarginalAccuracyDelta(evaluations, 'has_macro_data');
  const sentimentMarginalDelta = computeMarginalAccuracyDelta(evaluations, 'has_sentiment_data');

  // Compute per-stage contribution scores (one score per stage, shared across evals)
  const stageScores = new Map<PipelineStage, number>();
  for (const stage of PIPELINE_STAGES) {
    const rawScore = computeStageScore(stage, evaluations, similarityByBatch);
    stageScores.set(stage, clamp(rawScore));
  }

  // Generate one StageContribution per evaluation × stage
  const results: StageContribution[] = [];

  for (const ev of evaluations) {
    const pairKey = `${ev.asset}|${ev.regime}`;
    const isLowConfidence = (pairCounts.get(pairKey) ?? 0) < LOW_CONFIDENCE_THRESHOLD;

    // Find a similarity record for this evaluation to determine layer_dominant
    const batchRecords = similarityByBatch.get(ev.batch_id);
    let layerDominant: string | undefined;
    if (batchRecords && batchRecords.length > 0) {
      // Use the first record's breakdown for this batch
      layerDominant = identifyDominantLayer(batchRecords[0].layer_breakdown);
    }

    for (const stage of PIPELINE_STAGES) {
      const contribution: StageContribution = {
        evaluation_id: ev.evaluation_id,
        batch_id: ev.batch_id,
        asset: ev.asset,
        regime: ev.regime,
        stage_name: stage,
        contribution_score: stageScores.get(stage)!,
        is_low_confidence: isLowConfidence,
        created_at: now,
      };

      // layer_dominant is only set for the similarity stage
      if (stage === 'similarity') {
        contribution.layer_dominant = layerDominant;
      }

      // marginal_accuracy_delta is only set for macro and sentiment stages
      if (stage === 'macro') {
        contribution.marginal_accuracy_delta = macroMarginalDelta;
      } else if (stage === 'sentiment') {
        contribution.marginal_accuracy_delta = sentimentMarginalDelta;
      }

      results.push(contribution);
    }
  }

  return results;
}
