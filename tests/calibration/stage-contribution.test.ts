/**
 * Unit tests for Stage Contribution Tracker - computeContributions
 *
 * Tests cover:
 * - Contribution score boundedness and completeness (Req 1.1)
 * - Layer dominant identification (Req 1.2)
 * - Marginal accuracy delta computation (Req 1.3)
 * - Low-confidence marking (Req 1.5)
 */
import { describe, it, expect } from 'vitest';
import {
  computeContributions,
  identifyDominantLayer,
  computeMarginalAccuracyDelta,
} from '../../src/calibration/stage-contribution-tracker.js';
import type {
  EvaluationWithContext,
  SimilarityArchiveRecord,
} from '../../src/calibration/types.js';

// --- Helpers ---

function makeEvaluation(overrides: Partial<EvaluationWithContext> = {}): EvaluationWithContext {
  return {
    evaluation_id: 'eval-001',
    batch_id: 'batch-001',
    asset: 'EURUSD',
    regime: 'NORMAL_BULLISH',
    direction: 'up',
    direction_accuracy: 1,
    confidence_final: 0.75,
    brier_score: 0.1,
    calibration_bucket: '0.7-0.8',
    has_macro_data: true,
    has_sentiment_data: true,
    created_at: '2024-06-15T08:00:00.000Z',
    ...overrides,
  };
}

function makeSimilarityRecord(overrides: Partial<SimilarityArchiveRecord> = {}): SimilarityArchiveRecord {
  return {
    fingerprint_id: 'fp-001',
    match_fingerprint_id: 'fp-002',
    similarity_score: 0.72,
    layer_breakdown: {
      market_structure: 0.8,
      volatility: 0.6,
      liquidity: 0.7,
      macro: 0.5,
      sentiment: 0.4,
    },
    rank: 1,
    batch_id: 'batch-001',
    regime: 'NORMAL_BULLISH',
    asset: 'EURUSD',
    created_at: '2024-06-15T08:00:00.000Z',
    ...overrides,
  };
}

// --- Tests ---

describe('computeContributions', () => {
  it('returns empty array for empty evaluations', () => {
    const result = computeContributions([], []);
    expect(result).toEqual([]);
  });

  it('produces exactly one contribution per stage per evaluation', () => {
    const evaluations = [
      makeEvaluation({ evaluation_id: 'e1' }),
      makeEvaluation({ evaluation_id: 'e2', batch_id: 'batch-002' }),
    ];
    const similarity = [makeSimilarityRecord()];

    const results = computeContributions(evaluations, similarity);

    // 2 evaluations × 6 stages = 12 contributions
    expect(results.length).toBe(12);

    // Each evaluation has exactly 6 contributions
    const e1Contributions = results.filter((r) => r.evaluation_id === 'e1');
    const e2Contributions = results.filter((r) => r.evaluation_id === 'e2');
    expect(e1Contributions.length).toBe(6);
    expect(e2Contributions.length).toBe(6);

    // Each stage appears exactly once per evaluation
    const stages = e1Contributions.map((r) => r.stage_name).sort();
    expect(stages).toEqual(['confidence', 'macro', 'outcome', 'regime', 'sentiment', 'similarity']);
  });

  it('clamps all contribution scores to [-1, 1]', () => {
    const evaluations = Array.from({ length: 20 }, (_, i) =>
      makeEvaluation({
        evaluation_id: `e${i}`,
        batch_id: `batch-${i}`,
        direction_accuracy: (i % 2) as 0 | 1,
        confidence_final: i / 20,
        has_macro_data: i % 3 === 0,
        has_sentiment_data: i % 4 === 0,
      }),
    );
    const similarity = evaluations.map((_, i) =>
      makeSimilarityRecord({
        batch_id: `batch-${i}`,
        similarity_score: Math.random(),
      }),
    );

    const results = computeContributions(evaluations, similarity);

    for (const r of results) {
      expect(r.contribution_score).toBeGreaterThanOrEqual(-1);
      expect(r.contribution_score).toBeLessThanOrEqual(1);
    }
  });

  it('marks is_low_confidence when (asset, regime) pair has fewer than 10 evaluations', () => {
    // 5 evaluations for same (asset, regime) — should be low confidence
    const evaluations = Array.from({ length: 5 }, (_, i) =>
      makeEvaluation({
        evaluation_id: `e${i}`,
        batch_id: `batch-${i}`,
        asset: 'EURUSD',
        regime: 'NORMAL_BULLISH',
      }),
    );

    const results = computeContributions(evaluations, []);

    for (const r of results) {
      expect(r.is_low_confidence).toBe(true);
    }
  });

  it('marks is_low_confidence = false when (asset, regime) pair has >= 10 evaluations', () => {
    const evaluations = Array.from({ length: 10 }, (_, i) =>
      makeEvaluation({
        evaluation_id: `e${i}`,
        batch_id: `batch-${i}`,
        asset: 'EURUSD',
        regime: 'NORMAL_BULLISH',
        direction_accuracy: (i % 2) as 0 | 1,
      }),
    );

    const results = computeContributions(evaluations, []);

    for (const r of results) {
      expect(r.is_low_confidence).toBe(false);
    }
  });

  it('produces 6 contributions for a single evaluation (one per stage)', () => {
    const evaluations = [makeEvaluation({ evaluation_id: 'solo' })];
    const similarity = [makeSimilarityRecord({ batch_id: 'batch-001' })];

    const results = computeContributions(evaluations, similarity);

    expect(results.length).toBe(6);

    const stages = results.map((r) => r.stage_name).sort();
    expect(stages).toEqual(['confidence', 'macro', 'outcome', 'regime', 'sentiment', 'similarity']);

    // All belong to the single evaluation
    for (const r of results) {
      expect(r.evaluation_id).toBe('solo');
    }
  });

  it('sets layer_dominant to undefined when no similarity record matches batch_id', () => {
    // Evaluation has batch_id='batch-999' but no similarity record matches that batch
    const evaluations = [makeEvaluation({ evaluation_id: 'e-orphan', batch_id: 'batch-999' })];
    const similarityRecords = [makeSimilarityRecord({ batch_id: 'batch-OTHER' })];

    const results = computeContributions(evaluations, similarityRecords);

    const simResult = results.find((r) => r.stage_name === 'similarity');
    expect(simResult).toBeDefined();
    expect(simResult?.layer_dominant).toBeUndefined();
  });

  it('sets layer_dominant only for similarity stage', () => {
    const evaluations = [makeEvaluation()];
    const similarity = [makeSimilarityRecord()];

    const results = computeContributions(evaluations, similarity);

    const simResult = results.find((r) => r.stage_name === 'similarity');
    expect(simResult?.layer_dominant).toBe('L1'); // market_structure=0.8 is highest

    const otherResults = results.filter((r) => r.stage_name !== 'similarity');
    for (const r of otherResults) {
      expect(r.layer_dominant).toBeUndefined();
    }
  });

  it('sets marginal_accuracy_delta only for macro and sentiment stages', () => {
    const evaluations = [
      makeEvaluation({ evaluation_id: 'e1', has_macro_data: true, direction_accuracy: 1 }),
      makeEvaluation({ evaluation_id: 'e2', has_macro_data: false, direction_accuracy: 0 }),
    ];

    const results = computeContributions(evaluations, []);

    const macroResults = results.filter((r) => r.stage_name === 'macro');
    const sentimentResults = results.filter((r) => r.stage_name === 'sentiment');
    const otherResults = results.filter(
      (r) => r.stage_name !== 'macro' && r.stage_name !== 'sentiment',
    );

    for (const r of macroResults) {
      expect(r.marginal_accuracy_delta).toBeDefined();
    }

    for (const r of otherResults) {
      expect(r.marginal_accuracy_delta).toBeUndefined();
    }
  });

  it('computes correct marginal_accuracy_delta for macro stage', () => {
    // 2 with macro (accuracy=1), 2 without macro (accuracy=0)
    // delta = mean(1,1) - mean(0,0) = 1 - 0 = 1
    const evaluations = [
      makeEvaluation({ evaluation_id: 'e1', has_macro_data: true, direction_accuracy: 1 }),
      makeEvaluation({ evaluation_id: 'e2', has_macro_data: true, direction_accuracy: 1 }),
      makeEvaluation({ evaluation_id: 'e3', has_macro_data: false, direction_accuracy: 0 }),
      makeEvaluation({ evaluation_id: 'e4', has_macro_data: false, direction_accuracy: 0 }),
    ];

    const results = computeContributions(evaluations, []);
    const macroResult = results.find((r) => r.stage_name === 'macro');

    expect(macroResult?.marginal_accuracy_delta).toBe(1);
  });
});

describe('identifyDominantLayer', () => {
  it('returns L1 when market_structure is highest', () => {
    const breakdown = {
      market_structure: 0.9,
      volatility: 0.5,
      liquidity: 0.4,
      macro: 0.3,
      sentiment: 0.2,
    };
    expect(identifyDominantLayer(breakdown)).toBe('L1');
  });

  it('returns L3 when liquidity is highest', () => {
    const breakdown = {
      market_structure: 0.3,
      volatility: 0.5,
      liquidity: 0.95,
      macro: 0.4,
      sentiment: 0.6,
    };
    expect(identifyDominantLayer(breakdown)).toBe('L3');
  });

  it('returns lowest index on tie (L1 wins over L2)', () => {
    const breakdown = {
      market_structure: 0.7,
      volatility: 0.7,
      liquidity: 0.3,
      macro: 0.2,
      sentiment: 0.1,
    };
    expect(identifyDominantLayer(breakdown)).toBe('L1');
  });

  it('returns L2 when L2 and L3 tie', () => {
    const breakdown = {
      market_structure: 0.1,
      volatility: 0.9,
      liquidity: 0.9,
      macro: 0.2,
      sentiment: 0.3,
    };
    expect(identifyDominantLayer(breakdown)).toBe('L2');
  });

  it('returns L1 when L1 and L3 tie at max (lowest index wins)', () => {
    const breakdown = {
      market_structure: 0.9,
      volatility: 0.4,
      liquidity: 0.9,
      macro: 0.3,
      sentiment: 0.2,
    };
    expect(identifyDominantLayer(breakdown)).toBe('L1');
  });

  it('handles all equal values — returns L1', () => {
    const breakdown = {
      market_structure: 0.5,
      volatility: 0.5,
      liquidity: 0.5,
      macro: 0.5,
      sentiment: 0.5,
    };
    expect(identifyDominantLayer(breakdown)).toBe('L1');
  });
});

describe('computeMarginalAccuracyDelta', () => {
  it('returns difference of means for macro data', () => {
    const evaluations: EvaluationWithContext[] = [
      makeEvaluation({ has_macro_data: true, direction_accuracy: 1 }),
      makeEvaluation({ has_macro_data: true, direction_accuracy: 1 }),
      makeEvaluation({ has_macro_data: false, direction_accuracy: 0 }),
      makeEvaluation({ has_macro_data: false, direction_accuracy: 1 }),
    ];
    // with: mean(1,1)=1, without: mean(0,1)=0.5, delta=0.5
    expect(computeMarginalAccuracyDelta(evaluations, 'has_macro_data')).toBe(0.5);
  });

  it('returns undefined when no evaluations have data', () => {
    const evaluations: EvaluationWithContext[] = [
      makeEvaluation({ has_macro_data: false }),
      makeEvaluation({ has_macro_data: false }),
    ];
    expect(computeMarginalAccuracyDelta(evaluations, 'has_macro_data')).toBeUndefined();
  });

  it('returns undefined when all evaluations have data', () => {
    const evaluations: EvaluationWithContext[] = [
      makeEvaluation({ has_macro_data: true }),
      makeEvaluation({ has_macro_data: true }),
    ];
    expect(computeMarginalAccuracyDelta(evaluations, 'has_macro_data')).toBeUndefined();
  });

  it('returns negative delta when "without" group has higher accuracy', () => {
    const evaluations: EvaluationWithContext[] = [
      makeEvaluation({ has_sentiment_data: true, direction_accuracy: 0 }),
      makeEvaluation({ has_sentiment_data: false, direction_accuracy: 1 }),
    ];
    // with: mean(0)=0, without: mean(1)=1, delta = 0-1 = -1
    expect(computeMarginalAccuracyDelta(evaluations, 'has_sentiment_data')).toBe(-1);
  });
});
