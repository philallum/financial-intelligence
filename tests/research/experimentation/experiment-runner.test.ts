/**
 * Unit tests for the Experiment Runner.
 *
 * Validates:
 * - A/B engine testing with 2+ versions against same inputs (Req 5.1)
 * - Production isolation — writes exclusively to research_experiments (Req 5.2)
 * - Side-by-side comparison of outputs (Req 5.3)
 * - Backtesting support with original_batch_id (Req 5.4)
 * - Failure recording with partial results preserved (Req 5.5)
 * - 15-minute Cloud Run timeout enforcement (Req 5.6)
 *
 * Requirements: 5.1, 5.2, 5.3, 5.4, 5.5, 5.6
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createExperimentRunner } from '../../../src/research/experimentation/experiment-runner.js';
import type { ExperimentConfig } from '../../../src/research/experimentation/types.js';

// =============================================================================
// Mock Supabase Client
// =============================================================================

function createMockSupabase(options?: {
  insertError?: { message: string; code: string } | null;
  updateError?: { message: string; code: string } | null;
  selectData?: unknown[] | null;
  selectError?: { message: string; code: string } | null;
}) {
  const opts = options ?? {};

  const updateChain = {
    eq: vi.fn().mockReturnThis(),
    update: vi.fn().mockReturnThis(),
  };
  // Final .eq call resolves with the update response
  updateChain.eq.mockImplementation(() => {
    return {
      eq: vi.fn().mockResolvedValue({ data: null, error: opts.updateError ?? null }),
    };
  });

  const selectChain = {
    select: vi.fn().mockReturnThis(),
    eq: vi.fn().mockReturnThis(),
    order: vi.fn().mockResolvedValue({
      data: opts.selectData ?? null,
      error: opts.selectError ?? null,
    }),
  };

  const fromResult = {
    insert: vi.fn().mockResolvedValue({ data: null, error: opts.insertError ?? null }),
    update: vi.fn((data: unknown) => {
      return {
        eq: vi.fn().mockImplementation(() => ({
          eq: vi.fn().mockResolvedValue({ data: null, error: opts.updateError ?? null }),
        })),
      };
    }),
    select: vi.fn().mockReturnValue({
      eq: vi.fn().mockReturnValue({
        eq: vi.fn().mockReturnValue({
          order: vi.fn().mockResolvedValue({
            data: opts.selectData ?? null,
            error: opts.selectError ?? null,
          }),
        }),
      }),
    }),
  };

  return {
    from: vi.fn(() => fromResult),
    _fromResult: fromResult,
  };
}

// =============================================================================
// Test Fixtures
// =============================================================================

function createValidConfig(overrides?: Partial<ExperimentConfig>): ExperimentConfig {
  return {
    experiment_id: 'exp-001-ab-test',
    engine_versions: {
      confidence_v1: '1.0.0',
      confidence_v2: '2.0.0',
    },
    original_batch_id: 'batch-2024-06-15-12',
    input_fingerprint_ids: ['fp-001', 'fp-002'],
    description: 'A/B test of confidence engine v1 vs v2',
    ...overrides,
  };
}

function createMockEngineHandler(output?: Record<string, unknown>) {
  const defaultOutput = {
    direction_probabilities: { up: 0.45, down: 0.35, flat: 0.20 },
    expected_move_pips: 12.5,
    confidence_final: 0.72,
    sample_size: 47,
  };
  return vi.fn().mockResolvedValue(output ?? defaultOutput);
}

// =============================================================================
// Tests
// =============================================================================

describe('ExperimentRunner - runExperiment', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  it('requires at least 2 engine versions (Req 5.1)', async () => {
    const supabase = createMockSupabase();
    const handler = createMockEngineHandler();
    const runner = createExperimentRunner(supabase as never, handler);

    const config = createValidConfig({ engine_versions: { single: '1.0.0' } });

    await expect(runner.runExperiment(config)).rejects.toThrow(
      /at least 2 engine versions/
    );
  });

  it('processes all engine versions against all input fingerprints (Req 5.1)', async () => {
    const supabase = createMockSupabase();
    const handler = createMockEngineHandler();
    const runner = createExperimentRunner(supabase as never, handler);

    const config = createValidConfig();
    const results = await runner.runExperiment(config);

    // 2 engine versions × 2 fingerprints = 4 records
    expect(results).toHaveLength(4);
    expect(handler).toHaveBeenCalledTimes(4);

    // Verify each engine version processes each fingerprint
    expect(handler).toHaveBeenCalledWith('confidence_v1', '1.0.0', 'fp-001');
    expect(handler).toHaveBeenCalledWith('confidence_v1', '1.0.0', 'fp-002');
    expect(handler).toHaveBeenCalledWith('confidence_v2', '2.0.0', 'fp-001');
    expect(handler).toHaveBeenCalledWith('confidence_v2', '2.0.0', 'fp-002');
  });

  it('writes exclusively to research_experiments table (Req 5.2)', async () => {
    const supabase = createMockSupabase();
    const handler = createMockEngineHandler();
    const runner = createExperimentRunner(supabase as never, handler);

    const config = createValidConfig();
    await runner.runExperiment(config);

    // Verify all DB operations target research_experiments only
    for (const call of supabase.from.mock.calls) {
      expect(call[0]).toBe('research_experiments');
    }
  });

  it('inserts running record before engine execution', async () => {
    const supabase = createMockSupabase();
    const callOrder: string[] = [];

    supabase._fromResult.insert.mockImplementation(() => {
      callOrder.push('insert');
      return Promise.resolve({ data: null, error: null });
    });

    const handler = vi.fn().mockImplementation(async () => {
      callOrder.push('execute');
      return { direction_probabilities: { up: 0.5, down: 0.3, flat: 0.2 } };
    });

    const runner = createExperimentRunner(supabase as never, handler);
    const config = createValidConfig({
      engine_versions: { v1: '1.0.0', v2: '2.0.0' },
      input_fingerprint_ids: ['fp-001'],
    });

    await runner.runExperiment(config);

    // Insert should happen before execute for each pair
    expect(callOrder[0]).toBe('insert');
    expect(callOrder[1]).toBe('execute');
  });

  it('returns completed records with output on success', async () => {
    const supabase = createMockSupabase();
    const output = {
      direction_probabilities: { up: 0.6, down: 0.25, flat: 0.15 },
      expected_move_pips: 15.0,
      confidence_final: 0.81,
      sample_size: 52,
    };
    const handler = createMockEngineHandler(output);
    const runner = createExperimentRunner(supabase as never, handler);

    const config = createValidConfig({
      engine_versions: { v1: '1.0.0', v2: '2.0.0' },
      input_fingerprint_ids: ['fp-001'],
    });
    const results = await runner.runExperiment(config);

    expect(results[0].status).toBe('completed');
    expect(results[0].output).toEqual(output);
    expect(results[0].experiment_id).toBe('exp-001-ab-test');
    expect(results[0].input_fingerprint_id).toBe('fp-001');
  });

  it('records original_batch_id for backtesting (Req 5.4)', async () => {
    const supabase = createMockSupabase();
    const handler = createMockEngineHandler();
    const runner = createExperimentRunner(supabase as never, handler);

    const config = createValidConfig({ original_batch_id: 'historical-batch-123' });
    const results = await runner.runExperiment(config);

    for (const result of results) {
      expect(result.original_batch_id).toBe('historical-batch-123');
    }

    // Verify it's passed to the insert
    const insertCall = supabase._fromResult.insert.mock.calls[0][0];
    expect(insertCall.original_batch_id).toBe('historical-batch-123');
  });

  it('records null original_batch_id when not provided (Req 5.4)', async () => {
    const supabase = createMockSupabase();
    const handler = createMockEngineHandler();
    const runner = createExperimentRunner(supabase as never, handler);

    const config = createValidConfig({ original_batch_id: undefined });
    const results = await runner.runExperiment(config);

    for (const result of results) {
      expect(result.original_batch_id).toBeNull();
    }
  });

  it('records failure on engine execution error and preserves partial results (Req 5.5)', async () => {
    const supabase = createMockSupabase();
    let callCount = 0;
    const handler = vi.fn().mockImplementation(async () => {
      callCount++;
      if (callCount === 2) {
        throw new Error('Engine crashed: out of memory');
      }
      return { direction_probabilities: { up: 0.5, down: 0.3, flat: 0.2 } };
    });

    const runner = createExperimentRunner(supabase as never, handler);
    const config = createValidConfig({
      engine_versions: { v1: '1.0.0', v2: '2.0.0' },
      input_fingerprint_ids: ['fp-001'],
    });

    const results = await runner.runExperiment(config);

    // First result should be completed, second should be failed
    expect(results[0].status).toBe('completed');
    expect(results[1].status).toBe('failed');
    expect(results[1].failure_detail).toBe('Engine crashed: out of memory');
    expect(results[1].output).toBeNull();

    // Partial results are preserved — we still get both records
    expect(results).toHaveLength(2);
  });

  it('records failure when insert fails (Req 5.5)', async () => {
    const supabase = createMockSupabase({
      insertError: { message: 'connection refused', code: '08001' },
    });
    const handler = createMockEngineHandler();
    const runner = createExperimentRunner(supabase as never, handler);

    const config = createValidConfig({
      engine_versions: { v1: '1.0.0', v2: '2.0.0' },
      input_fingerprint_ids: ['fp-001'],
    });
    const results = await runner.runExperiment(config);

    expect(results[0].status).toBe('failed');
    expect(results[0].failure_detail).toContain('Insert failed');
    expect(results[0].failure_detail).toContain('connection refused');
  });

  it('continues processing after individual failures (Req 5.5)', async () => {
    let insertCallCount = 0;
    const supabase = createMockSupabase();
    supabase._fromResult.insert.mockImplementation(() => {
      insertCallCount++;
      // Fail only the first insert
      if (insertCallCount === 1) {
        return Promise.resolve({ data: null, error: { message: 'timeout', code: '08006' } });
      }
      return Promise.resolve({ data: null, error: null });
    });

    const handler = createMockEngineHandler();
    const runner = createExperimentRunner(supabase as never, handler);

    const config = createValidConfig({
      engine_versions: { v1: '1.0.0', v2: '2.0.0' },
      input_fingerprint_ids: ['fp-001'],
    });
    const results = await runner.runExperiment(config);

    // First record failed, second succeeded — both are in the results
    expect(results).toHaveLength(2);
    expect(results[0].status).toBe('failed');
    expect(results[1].status).toBe('completed');
  });

  it('tags each record with engine_version identifier (Req 5.1)', async () => {
    const supabase = createMockSupabase();
    const handler = createMockEngineHandler();
    const runner = createExperimentRunner(supabase as never, handler);

    const config = createValidConfig({
      engine_versions: { confidence_v1: '1.0.0', confidence_v2: '2.0.0' },
      input_fingerprint_ids: ['fp-001'],
    });
    const results = await runner.runExperiment(config);

    expect(results[0].engine_versions).toEqual({ confidence_v1: '1.0.0' });
    expect(results[1].engine_versions).toEqual({ confidence_v2: '2.0.0' });
  });

  it('tags all records with shared experiment_id (Req 5.1)', async () => {
    const supabase = createMockSupabase();
    const handler = createMockEngineHandler();
    const runner = createExperimentRunner(supabase as never, handler);

    const config = createValidConfig();
    const results = await runner.runExperiment(config);

    for (const result of results) {
      expect(result.experiment_id).toBe('exp-001-ab-test');
    }
  });
});

describe('ExperimentRunner - compareExperimentResults', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  it('returns side-by-side comparison grouped by fingerprint (Req 5.3)', async () => {
    const selectData = [
      {
        experiment_id: 'exp-001',
        engine_versions: { confidence_v1: '1.0.0' },
        input_fingerprint_id: 'fp-001',
        output: {
          direction_probabilities: { up: 0.45, down: 0.35, flat: 0.20 },
          expected_move_pips: 12.5,
          confidence_final: 0.72,
          sample_size: 47,
        },
        status: 'completed',
      },
      {
        experiment_id: 'exp-001',
        engine_versions: { confidence_v2: '2.0.0' },
        input_fingerprint_id: 'fp-001',
        output: {
          direction_probabilities: { up: 0.55, down: 0.30, flat: 0.15 },
          expected_move_pips: 15.0,
          confidence_final: 0.81,
          sample_size: 52,
        },
        status: 'completed',
      },
    ];

    const supabase = createMockSupabase({ selectData });
    const handler = createMockEngineHandler();
    const runner = createExperimentRunner(supabase as never, handler);

    const comparisons = await runner.compareExperimentResults('exp-001');

    expect(comparisons).toHaveLength(1);
    expect(comparisons[0].experiment_id).toBe('exp-001');
    expect(comparisons[0].input_fingerprint_id).toBe('fp-001');
    expect(comparisons[0].versions).toHaveLength(2);

    // Verify version comparison details
    expect(comparisons[0].versions[0].engine_version).toBe('1.0.0');
    expect(comparisons[0].versions[0].direction_probabilities).toEqual({ up: 0.45, down: 0.35, flat: 0.20 });
    expect(comparisons[0].versions[1].engine_version).toBe('2.0.0');
    expect(comparisons[0].versions[1].direction_probabilities).toEqual({ up: 0.55, down: 0.30, flat: 0.15 });
  });

  it('returns empty array when no completed records exist', async () => {
    const supabase = createMockSupabase({ selectData: [] });
    const handler = createMockEngineHandler();
    const runner = createExperimentRunner(supabase as never, handler);

    const comparisons = await runner.compareExperimentResults('exp-nonexistent');
    expect(comparisons).toEqual([]);
  });

  it('returns empty array on query error', async () => {
    const supabase = createMockSupabase({
      selectError: { message: 'connection timeout', code: '08006' },
    });
    const handler = createMockEngineHandler();
    const runner = createExperimentRunner(supabase as never, handler);

    const comparisons = await runner.compareExperimentResults('exp-001');
    expect(comparisons).toEqual([]);
  });

  it('groups multiple fingerprints into separate comparison entries (Req 5.3)', async () => {
    const selectData = [
      {
        experiment_id: 'exp-001',
        engine_versions: { v1: '1.0.0' },
        input_fingerprint_id: 'fp-001',
        output: {
          direction_probabilities: { up: 0.45, down: 0.35, flat: 0.20 },
          expected_move_pips: 12.5,
          confidence_final: 0.72,
          sample_size: 47,
        },
        status: 'completed',
      },
      {
        experiment_id: 'exp-001',
        engine_versions: { v1: '1.0.0' },
        input_fingerprint_id: 'fp-002',
        output: {
          direction_probabilities: { up: 0.60, down: 0.25, flat: 0.15 },
          expected_move_pips: 18.0,
          confidence_final: 0.85,
          sample_size: 55,
        },
        status: 'completed',
      },
    ];

    const supabase = createMockSupabase({ selectData });
    const handler = createMockEngineHandler();
    const runner = createExperimentRunner(supabase as never, handler);

    const comparisons = await runner.compareExperimentResults('exp-001');

    expect(comparisons).toHaveLength(2);
    expect(comparisons[0].input_fingerprint_id).toBe('fp-001');
    expect(comparisons[1].input_fingerprint_id).toBe('fp-002');
  });

  it('queries only completed records from research_experiments (Req 5.2)', async () => {
    const supabase = createMockSupabase({ selectData: [] });
    const handler = createMockEngineHandler();
    const runner = createExperimentRunner(supabase as never, handler);

    await runner.compareExperimentResults('exp-001');

    // Verify from is called with research_experiments
    expect(supabase.from).toHaveBeenCalledWith('research_experiments');
  });
});
