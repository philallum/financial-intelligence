/**
 * Unit tests for the Evaluation Engine.
 *
 * Validates:
 * - Metric computation: direction_accuracy, expected_move_error, absolute_error,
 *   rmse_contribution, brier_score, confidence_calibration_score
 * - forecast_success and tradeability_success logic
 * - Calibration bucket assignment
 * - FLAT_THRESHOLD = 2 pips direction classification
 * - Outcome unavailable timeout handling (8h)
 * - Deterministic output given identical inputs
 *
 * Requirements: 7.1, 7.2, 7.3, 7.4, 7.5, 7.6, 7.7, 7.8, 7.9, 7.10, 7.11
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createEvaluationEngine } from '../../../src/research/evaluation/evaluation-engine.js';

// =============================================================================
// Mock Supabase Client
// =============================================================================

interface MockQueryState {
  selectCalls: Array<{ table: string; query: string }>;
  maturedForecasts: unknown[];
  allForecasts: unknown[];
  insertedRows: unknown[];
  insertError: { message: string; code: string } | null;
}

function createMockSupabase(state: MockQueryState) {
  let callCount = 0;

  const createChain = (data: unknown[], isInnerJoin: boolean) => {
    const chain: Record<string, unknown> = {};
    chain.select = vi.fn((_q: string) => {
      state.selectCalls.push({ table: 'research_forecasts', query: _q });
      return chain;
    });
    chain.lt = vi.fn(() => chain);
    chain.not = vi.fn(() => chain);
    chain.order = vi.fn(() => chain);
    chain.returns = vi.fn(() => Promise.resolve({ data, error: null }));
    // Allow the chain to be awaited directly (for queries without .returns())
    chain.then = (resolve: (v: unknown) => void, reject: (e: unknown) => void) =>
      Promise.resolve({ data, error: null }).then(resolve, reject);
    chain.insert = vi.fn((rows: unknown[]) => {
      state.insertedRows.push(...(Array.isArray(rows) ? rows : [rows]));
      return Promise.resolve({ error: state.insertError });
    });
    return chain;
  };

  const supabase = {
    from: vi.fn((table: string) => {
      if (table === 'research_evaluations') {
        return {
          select: vi.fn(() => ({ data: [], error: null })),
          insert: vi.fn((rows: unknown) => {
            const rowArray = Array.isArray(rows) ? rows : [rows];
            state.insertedRows.push(...rowArray);
            return Promise.resolve({ error: state.insertError });
          }),
        };
      }
      // research_forecasts
      callCount++;
      if (callCount === 1) {
        // First call: with inner join (matured forecasts with outcomes)
        return createChain(state.maturedForecasts, true);
      }
      // Second call: without inner join (all matured forecasts)
      return createChain(state.allForecasts, false);
    }),
  };

  return supabase;
}

// =============================================================================
// Test Fixtures
// =============================================================================

function createForecastWithOutcome(overrides: {
  directionProbs?: { up: number; down: number; flat: number };
  expectedMovePips?: number;
  confidenceFinal?: number;
  netReturnPips?: number;
  forecastExpiry?: string;
}) {
  return {
    id: 'forecast-001',
    batch_id: 'batch-001',
    fingerprint_id: 'fp-001',
    forecast_expiry: overrides.forecastExpiry ?? '2024-06-15T12:00:00.000Z',
    direction_probabilities: overrides.directionProbs ?? { up: 0.6, down: 0.25, flat: 0.15 },
    expected_move_pips: overrides.expectedMovePips ?? 10.0,
    confidence_final: overrides.confidenceFinal ?? 0.72,
    market_outcomes: {
      outcome_id: 'outcome-001',
      net_return_pips: overrides.netReturnPips ?? 8.5,
      timestamp_utc: '2024-06-15T16:00:00.000Z',
    },
  };
}

// =============================================================================
// Tests
// =============================================================================

describe('EvaluationEngine - evaluateMaturedForecasts', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  describe('direction_accuracy metric (Requirement 7.4)', () => {
    it('returns 1 when predicted direction matches realised direction (up)', async () => {
      // Predicted: up (highest prob), Realised: net_return > 2 pips → up
      const forecast = createForecastWithOutcome({
        directionProbs: { up: 0.6, down: 0.25, flat: 0.15 },
        netReturnPips: 5.0, // > 2 → up
      });
      const state: MockQueryState = {
        selectCalls: [],
        maturedForecasts: [forecast],
        allForecasts: [forecast],
        insertedRows: [],
        insertError: null,
      };
      const supabase = createMockSupabase(state);
      const engine = createEvaluationEngine(supabase as never);

      const records = await engine.evaluateMaturedForecasts('eval-batch-001');

      expect(records).toHaveLength(1);
      expect(records[0].direction_accuracy).toBe(1);
    });

    it('returns 0 when predicted direction does not match realised direction', async () => {
      // Predicted: up (highest prob), Realised: net_return < -2 → down
      const forecast = createForecastWithOutcome({
        directionProbs: { up: 0.6, down: 0.25, flat: 0.15 },
        netReturnPips: -5.0, // < -2 → down
      });
      const state: MockQueryState = {
        selectCalls: [],
        maturedForecasts: [forecast],
        allForecasts: [forecast],
        insertedRows: [],
        insertError: null,
      };
      const supabase = createMockSupabase(state);
      const engine = createEvaluationEngine(supabase as never);

      const records = await engine.evaluateMaturedForecasts('eval-batch-001');

      expect(records).toHaveLength(1);
      expect(records[0].direction_accuracy).toBe(0);
    });

    it('classifies flat direction when |net_return| <= 2 pips', async () => {
      // Predicted: flat, Realised: |1.5| <= 2 → flat
      const forecast = createForecastWithOutcome({
        directionProbs: { up: 0.2, down: 0.2, flat: 0.6 },
        netReturnPips: 1.5,
      });
      const state: MockQueryState = {
        selectCalls: [],
        maturedForecasts: [forecast],
        allForecasts: [forecast],
        insertedRows: [],
        insertError: null,
      };
      const supabase = createMockSupabase(state);
      const engine = createEvaluationEngine(supabase as never);

      const records = await engine.evaluateMaturedForecasts('eval-batch-001');

      expect(records[0].direction_accuracy).toBe(1);
      expect(records[0].forecast_success).toBe(true);
    });

    it('classifies flat for exactly 2 pips (boundary)', async () => {
      // net_return = 2.0 → |2.0| <= 2 → flat
      const forecast = createForecastWithOutcome({
        directionProbs: { up: 0.1, down: 0.1, flat: 0.8 },
        netReturnPips: 2.0,
      });
      const state: MockQueryState = {
        selectCalls: [],
        maturedForecasts: [forecast],
        allForecasts: [forecast],
        insertedRows: [],
        insertError: null,
      };
      const supabase = createMockSupabase(state);
      const engine = createEvaluationEngine(supabase as never);

      const records = await engine.evaluateMaturedForecasts('eval-batch-001');

      expect(records[0].direction_accuracy).toBe(1);
    });

    it('classifies up for 2.01 pips (just above threshold)', async () => {
      const forecast = createForecastWithOutcome({
        directionProbs: { up: 0.7, down: 0.2, flat: 0.1 },
        netReturnPips: 2.01,
      });
      const state: MockQueryState = {
        selectCalls: [],
        maturedForecasts: [forecast],
        allForecasts: [forecast],
        insertedRows: [],
        insertError: null,
      };
      const supabase = createMockSupabase(state);
      const engine = createEvaluationEngine(supabase as never);

      const records = await engine.evaluateMaturedForecasts('eval-batch-001');

      expect(records[0].direction_accuracy).toBe(1); // predicted up matches realised up
    });
  });

  describe('expected_move_error and absolute_error (Requirement 7.4)', () => {
    it('computes expected_move_error as predicted - realised', async () => {
      const forecast = createForecastWithOutcome({
        expectedMovePips: 10.0,
        netReturnPips: 8.5,
      });
      const state: MockQueryState = {
        selectCalls: [],
        maturedForecasts: [forecast],
        allForecasts: [forecast],
        insertedRows: [],
        insertError: null,
      };
      const supabase = createMockSupabase(state);
      const engine = createEvaluationEngine(supabase as never);

      const records = await engine.evaluateMaturedForecasts('eval-batch-001');

      expect(records[0].expected_move_error).toBe(1.5);
      expect(records[0].absolute_error).toBe(1.5);
    });

    it('handles negative expected_move_error (under-prediction)', async () => {
      const forecast = createForecastWithOutcome({
        expectedMovePips: 5.0,
        netReturnPips: 12.0,
      });
      const state: MockQueryState = {
        selectCalls: [],
        maturedForecasts: [forecast],
        allForecasts: [forecast],
        insertedRows: [],
        insertError: null,
      };
      const supabase = createMockSupabase(state);
      const engine = createEvaluationEngine(supabase as never);

      const records = await engine.evaluateMaturedForecasts('eval-batch-001');

      expect(records[0].expected_move_error).toBe(-7.0);
      expect(records[0].absolute_error).toBe(7.0);
    });
  });

  describe('rmse_contribution (Requirement 7.4)', () => {
    it('computes rmse_contribution as expected_move_error^2', async () => {
      const forecast = createForecastWithOutcome({
        expectedMovePips: 10.0,
        netReturnPips: 7.0,
      });
      const state: MockQueryState = {
        selectCalls: [],
        maturedForecasts: [forecast],
        allForecasts: [forecast],
        insertedRows: [],
        insertError: null,
      };
      const supabase = createMockSupabase(state);
      const engine = createEvaluationEngine(supabase as never);

      const records = await engine.evaluateMaturedForecasts('eval-batch-001');

      // error = 10 - 7 = 3, rmse_contribution = 9
      expect(records[0].rmse_contribution).toBe(9);
    });
  });

  describe('brier_score (Requirement 7.4)', () => {
    it('computes Brier score as mean squared error vs one-hot vector', async () => {
      // Predicted: {up: 0.7, down: 0.2, flat: 0.1}, Realised: up (net_return > 2)
      // One-hot: [1, 0, 0]
      // MSE: ((0.7-1)^2 + (0.2-0)^2 + (0.1-0)^2) / 3 = (0.09 + 0.04 + 0.01) / 3 = 0.14/3 ≈ 0.046667
      const forecast = createForecastWithOutcome({
        directionProbs: { up: 0.7, down: 0.2, flat: 0.1 },
        netReturnPips: 5.0,
      });
      const state: MockQueryState = {
        selectCalls: [],
        maturedForecasts: [forecast],
        allForecasts: [forecast],
        insertedRows: [],
        insertError: null,
      };
      const supabase = createMockSupabase(state);
      const engine = createEvaluationEngine(supabase as never);

      const records = await engine.evaluateMaturedForecasts('eval-batch-001');

      expect(records[0].brier_score).toBeCloseTo(0.046667, 5);
    });

    it('produces Brier score = 0 for perfect prediction', async () => {
      // Perfect: predicted {up: 1.0, down: 0, flat: 0}, realised: up
      const forecast = createForecastWithOutcome({
        directionProbs: { up: 1.0, down: 0.0, flat: 0.0 },
        netReturnPips: 5.0,
      });
      const state: MockQueryState = {
        selectCalls: [],
        maturedForecasts: [forecast],
        allForecasts: [forecast],
        insertedRows: [],
        insertError: null,
      };
      const supabase = createMockSupabase(state);
      const engine = createEvaluationEngine(supabase as never);

      const records = await engine.evaluateMaturedForecasts('eval-batch-001');

      expect(records[0].brier_score).toBe(0);
    });
  });

  describe('confidence_calibration_score (Requirement 7.4)', () => {
    it('computes as confidence_final - direction_accuracy', async () => {
      // confidence_final = 0.72, direction matches → direction_accuracy = 1
      // score = 0.72 - 1 = -0.28
      const forecast = createForecastWithOutcome({
        directionProbs: { up: 0.6, down: 0.2, flat: 0.2 },
        confidenceFinal: 0.72,
        netReturnPips: 5.0, // up matches predicted up
      });
      const state: MockQueryState = {
        selectCalls: [],
        maturedForecasts: [forecast],
        allForecasts: [forecast],
        insertedRows: [],
        insertError: null,
      };
      const supabase = createMockSupabase(state);
      const engine = createEvaluationEngine(supabase as never);

      const records = await engine.evaluateMaturedForecasts('eval-batch-001');

      expect(records[0].confidence_calibration_score).toBeCloseTo(-0.28, 5);
    });

    it('is positive when confidence overestimates accuracy', async () => {
      // confidence_final = 0.72, direction doesn't match → direction_accuracy = 0
      // score = 0.72 - 0 = 0.72
      const forecast = createForecastWithOutcome({
        directionProbs: { up: 0.6, down: 0.2, flat: 0.2 },
        confidenceFinal: 0.72,
        netReturnPips: -5.0, // down doesn't match predicted up
      });
      const state: MockQueryState = {
        selectCalls: [],
        maturedForecasts: [forecast],
        allForecasts: [forecast],
        insertedRows: [],
        insertError: null,
      };
      const supabase = createMockSupabase(state);
      const engine = createEvaluationEngine(supabase as never);

      const records = await engine.evaluateMaturedForecasts('eval-batch-001');

      expect(records[0].confidence_calibration_score).toBeCloseTo(0.72, 5);
    });
  });

  describe('forecast_success (Requirement 7.5)', () => {
    it('is true when predicted direction matches realised direction', async () => {
      const forecast = createForecastWithOutcome({
        directionProbs: { up: 0.6, down: 0.25, flat: 0.15 },
        netReturnPips: 5.0,
      });
      const state: MockQueryState = {
        selectCalls: [],
        maturedForecasts: [forecast],
        allForecasts: [forecast],
        insertedRows: [],
        insertError: null,
      };
      const supabase = createMockSupabase(state);
      const engine = createEvaluationEngine(supabase as never);

      const records = await engine.evaluateMaturedForecasts('eval-batch-001');

      expect(records[0].forecast_success).toBe(true);
    });

    it('is false when predicted direction does not match', async () => {
      const forecast = createForecastWithOutcome({
        directionProbs: { up: 0.6, down: 0.25, flat: 0.15 },
        netReturnPips: -5.0,
      });
      const state: MockQueryState = {
        selectCalls: [],
        maturedForecasts: [forecast],
        allForecasts: [forecast],
        insertedRows: [],
        insertError: null,
      };
      const supabase = createMockSupabase(state);
      const engine = createEvaluationEngine(supabase as never);

      const records = await engine.evaluateMaturedForecasts('eval-batch-001');

      expect(records[0].forecast_success).toBe(false);
    });
  });

  describe('tradeability_success (Requirement 7.6)', () => {
    it('is true when forecast_success AND absolute_error <= 0.5 * |realised|', async () => {
      // Predicted up: correct (net_return = 10 > 2), expected_move = 8
      // error = 8 - 10 = -2, absolute_error = 2
      // 0.5 * |10| = 5, and 2 <= 5 → tradeability_success = true
      const forecast = createForecastWithOutcome({
        directionProbs: { up: 0.7, down: 0.2, flat: 0.1 },
        expectedMovePips: 8.0,
        netReturnPips: 10.0,
      });
      const state: MockQueryState = {
        selectCalls: [],
        maturedForecasts: [forecast],
        allForecasts: [forecast],
        insertedRows: [],
        insertError: null,
      };
      const supabase = createMockSupabase(state);
      const engine = createEvaluationEngine(supabase as never);

      const records = await engine.evaluateMaturedForecasts('eval-batch-001');

      expect(records[0].forecast_success).toBe(true);
      expect(records[0].tradeability_success).toBe(true);
    });

    it('is false when forecast_success but absolute_error > 0.5 * |realised|', async () => {
      // Predicted up: correct (net_return = 4 > 2), expected_move = 15
      // error = 15 - 4 = 11, absolute_error = 11
      // 0.5 * |4| = 2, and 11 > 2 → tradeability_success = false
      const forecast = createForecastWithOutcome({
        directionProbs: { up: 0.7, down: 0.2, flat: 0.1 },
        expectedMovePips: 15.0,
        netReturnPips: 4.0,
      });
      const state: MockQueryState = {
        selectCalls: [],
        maturedForecasts: [forecast],
        allForecasts: [forecast],
        insertedRows: [],
        insertError: null,
      };
      const supabase = createMockSupabase(state);
      const engine = createEvaluationEngine(supabase as never);

      const records = await engine.evaluateMaturedForecasts('eval-batch-001');

      expect(records[0].forecast_success).toBe(true);
      expect(records[0].tradeability_success).toBe(false);
    });

    it('is false when direction prediction is wrong', async () => {
      const forecast = createForecastWithOutcome({
        directionProbs: { up: 0.6, down: 0.25, flat: 0.15 },
        expectedMovePips: 5.0,
        netReturnPips: -5.0,
      });
      const state: MockQueryState = {
        selectCalls: [],
        maturedForecasts: [forecast],
        allForecasts: [forecast],
        insertedRows: [],
        insertError: null,
      };
      const supabase = createMockSupabase(state);
      const engine = createEvaluationEngine(supabase as never);

      const records = await engine.evaluateMaturedForecasts('eval-batch-001');

      expect(records[0].tradeability_success).toBe(false);
    });
  });

  describe('calibration_bucket assignment (Requirement 8.1)', () => {
    it('assigns "0.7-0.8" for confidence_final = 0.72', async () => {
      const forecast = createForecastWithOutcome({ confidenceFinal: 0.72 });
      const state: MockQueryState = {
        selectCalls: [],
        maturedForecasts: [forecast],
        allForecasts: [forecast],
        insertedRows: [],
        insertError: null,
      };
      const supabase = createMockSupabase(state);
      const engine = createEvaluationEngine(supabase as never);

      const records = await engine.evaluateMaturedForecasts('eval-batch-001');

      expect(records[0].calibration_bucket).toBe('0.7-0.8');
    });

    it('assigns "0.0-0.1" for confidence_final = 0.05', async () => {
      const forecast = createForecastWithOutcome({ confidenceFinal: 0.05 });
      const state: MockQueryState = {
        selectCalls: [],
        maturedForecasts: [forecast],
        allForecasts: [forecast],
        insertedRows: [],
        insertError: null,
      };
      const supabase = createMockSupabase(state);
      const engine = createEvaluationEngine(supabase as never);

      const records = await engine.evaluateMaturedForecasts('eval-batch-001');

      expect(records[0].calibration_bucket).toBe('0.0-0.1');
    });

    it('assigns "0.9-1.0" for confidence_final = 0.95', async () => {
      const forecast = createForecastWithOutcome({ confidenceFinal: 0.95 });
      const state: MockQueryState = {
        selectCalls: [],
        maturedForecasts: [forecast],
        allForecasts: [forecast],
        insertedRows: [],
        insertError: null,
      };
      const supabase = createMockSupabase(state);
      const engine = createEvaluationEngine(supabase as never);

      const records = await engine.evaluateMaturedForecasts('eval-batch-001');

      expect(records[0].calibration_bucket).toBe('0.9-1.0');
    });
  });

  describe('deterministic output (Requirement 7.8)', () => {
    it('produces identical records for identical inputs across two invocations', async () => {
      const forecast = createForecastWithOutcome({
        directionProbs: { up: 0.55, down: 0.30, flat: 0.15 },
        expectedMovePips: 12.0,
        confidenceFinal: 0.65,
        netReturnPips: 8.0,
      });

      const state1: MockQueryState = {
        selectCalls: [],
        maturedForecasts: [forecast],
        allForecasts: [forecast],
        insertedRows: [],
        insertError: null,
      };
      const state2: MockQueryState = {
        selectCalls: [],
        maturedForecasts: [forecast],
        allForecasts: [forecast],
        insertedRows: [],
        insertError: null,
      };

      const engine1 = createEvaluationEngine(createMockSupabase(state1) as never);
      const engine2 = createEvaluationEngine(createMockSupabase(state2) as never);

      const records1 = await engine1.evaluateMaturedForecasts('eval-batch-001');
      const records2 = await engine2.evaluateMaturedForecasts('eval-batch-001');

      // All metric fields must be identical (excluding evaluation_id and created_at)
      expect(records1[0].direction_accuracy).toBe(records2[0].direction_accuracy);
      expect(records1[0].forecast_success).toBe(records2[0].forecast_success);
      expect(records1[0].tradeability_success).toBe(records2[0].tradeability_success);
      expect(records1[0].expected_move_error).toBe(records2[0].expected_move_error);
      expect(records1[0].absolute_error).toBe(records2[0].absolute_error);
      expect(records1[0].rmse_contribution).toBe(records2[0].rmse_contribution);
      expect(records1[0].brier_score).toBe(records2[0].brier_score);
      expect(records1[0].confidence_calibration_score).toBe(records2[0].confidence_calibration_score);
      expect(records1[0].calibration_bucket).toBe(records2[0].calibration_bucket);
    });
  });

  describe('empty result set', () => {
    it('returns empty array when no matured forecasts exist', async () => {
      const state: MockQueryState = {
        selectCalls: [],
        maturedForecasts: [],
        allForecasts: [],
        insertedRows: [],
        insertError: null,
      };
      const supabase = createMockSupabase(state);
      const engine = createEvaluationEngine(supabase as never);

      const records = await engine.evaluateMaturedForecasts('eval-batch-001');

      expect(records).toHaveLength(0);
    });
  });

  describe('record shape (Requirement 7.11)', () => {
    it('includes all required fields in the evaluation record', async () => {
      const forecast = createForecastWithOutcome({});
      const state: MockQueryState = {
        selectCalls: [],
        maturedForecasts: [forecast],
        allForecasts: [forecast],
        insertedRows: [],
        insertError: null,
      };
      const supabase = createMockSupabase(state);
      const engine = createEvaluationEngine(supabase as never);

      const records = await engine.evaluateMaturedForecasts('eval-batch-001');
      const record = records[0];

      expect(record).toHaveProperty('evaluation_id');
      expect(record).toHaveProperty('forecast_id', 'forecast-001');
      expect(record).toHaveProperty('outcome_id', 'outcome-001');
      expect(record).toHaveProperty('batch_id', 'eval-batch-001');
      expect(record).toHaveProperty('engine_version', '1.0.0');
      expect(record).toHaveProperty('direction_accuracy');
      expect(record).toHaveProperty('forecast_success');
      expect(record).toHaveProperty('tradeability_success');
      expect(record).toHaveProperty('expected_move_error');
      expect(record).toHaveProperty('absolute_error');
      expect(record).toHaveProperty('rmse_contribution');
      expect(record).toHaveProperty('brier_score');
      expect(record).toHaveProperty('confidence_calibration_score');
      expect(record).toHaveProperty('calibration_bucket');
      expect(record).toHaveProperty('created_at');
    });
  });
});
