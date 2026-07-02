/**
 * Integration tests for the end-to-end batch pipeline.
 *
 * Tests the full pipeline flow: ingestion → fingerprint → similarity → outcome → forecast → confidence → cache_write
 * Verifies cross-component interactions including:
 * - Batch status transitions and engine version snapshot
 * - Execution traces emitted for each stage
 * - Cache writes occurring only after full batch completion
 * - Pipeline failure and halt behaviour
 *
 * Validates: Requirements 14.1, 14.2, 14.5, 16.2
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  BatchOrchestrator,
  PIPELINE_STAGES,
  type StageHandlers,
  type BatchTriggerInput,
  type CacheWriteInput,
} from '../../src/services/pipeline/batch-orchestrator.js';
import { BatchStatus } from '../../src/types/enums.js';
import type {
  IngestionOutput,
  Fingerprint,
  SimilarityOutput,
  OutcomeDistribution,
  Forecast,
  ConfidenceOutput,
} from '../../src/types/index.js';

// =============================================================================
// Test Fixtures
// =============================================================================

const sampleIngestionOutput: IngestionOutput = {
  asset: 'EURUSD',
  timestamp_utc: '2024-01-15T08:00:00.000Z',
  ohlc: { open: 1.085, high: 1.09, low: 1.083, close: 1.088 },
  volume: 1000,
  ingestion_time: '2024-01-15T08:02:00.000Z',
};

const sampleFingerprint: Fingerprint = {
  fingerprint_id: 'fp-int-001',
  asset: 'EURUSD',
  timeframe: '4H',
  timestamp_utc: '2024-01-15T08:00:00.000Z',
  market_state_version: '1.0.0',
  ohlc: { open: 1.085, high: 1.09, low: 1.083, close: 1.088 },
  return_profile: { net_return_pips: 30, range_pips: 70 },
  regime: { volatility_regime: 'NORMAL', trend_regime: 'BULLISH', session: 'LONDON' },
  state_layers: {
    market_structure: Array(16).fill(0.5),
    volatility_profile: Array(12).fill(0.5),
    liquidity_field: Array(20).fill(0.5),
    macro_context: Array(8).fill(0.5),
    sentiment_pressure: Array(6).fill(0.5),
  },
  normalisation: { quantile_table_version: 'v1_0', scaling_method: 'fixed' },
};

const sampleSimilarityOutput: SimilarityOutput = {
  matches: [
    {
      fingerprint_id: 'fp-int-001',
      match_fingerprint_id: 'fp-hist-100',
      similarity_score: 0.94,
      rank: 1,
      layer_breakdown: { market_structure: 0.92, volatility: 0.88, liquidity: 0.9, macro: 0.91, sentiment: 0.85 },
      match_explanation: { matched_layers: ['market_structure', 'macro'], mismatched_layers: [], primary_match_reason: 'strong_alignment' },
      batch_id: 'batch-int-1',
    },
    {
      fingerprint_id: 'fp-int-001',
      match_fingerprint_id: 'fp-hist-101',
      similarity_score: 0.89,
      rank: 2,
      layer_breakdown: { market_structure: 0.87, volatility: 0.84, liquidity: 0.86, macro: 0.88, sentiment: 0.82 },
      match_explanation: { matched_layers: ['volatility'], mismatched_layers: ['sentiment'], primary_match_reason: 'volatility_match' },
      batch_id: 'batch-int-1',
    },
  ],
  match_count: 2,
  regime_weights_used: { market_structure: 0.25, volatility: 0.2, liquidity: 0.15, macro: 0.25, sentiment: 0.15 },
};

const sampleOutcome: OutcomeDistribution = {
  fingerprint_id: 'fp-int-001',
  sample_size: 45,
  mean_return: 15.0,
  median_return: 12.0,
  direction_probability: { up: 0.62, down: 0.23, flat: 0.15 },
  volatility_profile: { std_dev: 0.28, max_absolute_return: 55 },
  risk_range: { p10: -18, p50: 12, p90: 45 },
  confidence_inputs: { regime_consistency: 0.75, distribution_sharpness: 0.65 },
  batch_id: 'batch-int-1',
  engine_version: '1.0.0',
};

const sampleForecast: Forecast = {
  fingerprint_id: 'fp-int-001',
  direction_probabilities: { up: 0.62, down: 0.23, flat: 0.15 },
  expected_move_pips: 15.0,
  confidence_raw: 0.72,
  confidence_final: 0.61,
  engine_version: '1.0.0',
  batch_id: 'batch-int-1',
};

const sampleConfidence: ConfidenceOutput = {
  confidence_raw: 0.72,
  sample_weight: 1.0,
  regime_stability: 0.85,
  confidence_final: 0.612,
};

const defaultInput: BatchTriggerInput = {
  asset: 'EURUSD',
  timeframe: '4H',
  candle_boundary: '2024-01-15T08:00:00.000Z',
};

// =============================================================================
// Mock Supabase Client Factory
// =============================================================================

interface MockSupabaseOverrides {
  batchRunsSelect?: { data: unknown; error: unknown };
  engineVersionsSelect?: { data: unknown; error: unknown };
  batchRunsInsert?: { error: unknown };
  batchRunsUpdate?: { error: unknown };
}

function createMockSupabase(overrides: MockSupabaseOverrides = {}) {
  const insertCalls: unknown[] = [];
  const updateCalls: { data: unknown; batchId: string }[] = [];

  const mockFrom = vi.fn().mockImplementation((table: string) => {
    if (table === 'batch_runs') {
      return {
        select: vi.fn().mockReturnValue({
          eq: vi.fn().mockReturnValue({
            limit: vi.fn().mockReturnValue({
              maybeSingle: vi.fn().mockResolvedValue(
                overrides.batchRunsSelect ?? { data: null, error: null }
              ),
            }),
          }),
        }),
        insert: vi.fn().mockImplementation((data: unknown) => {
          insertCalls.push(data);
          return overrides.batchRunsInsert ?? { error: null };
        }),
        update: vi.fn().mockImplementation((data: unknown) => ({
          eq: vi.fn().mockImplementation((_col: string, batchId: string) => {
            updateCalls.push({ data, batchId });
            return overrides.batchRunsUpdate ?? { error: null };
          }),
        })),
      };
    }
    if (table === 'engine_versions') {
      return {
        select: vi.fn().mockReturnValue({
          eq: vi.fn().mockReturnValue({
            order: vi.fn().mockResolvedValue(
              overrides.engineVersionsSelect ?? {
                data: [
                  { engine_name: 'fingerprint', engine_version: '2.1.0' },
                  { engine_name: 'similarity', engine_version: '1.3.0' },
                  { engine_name: 'outcome', engine_version: '1.2.0' },
                  { engine_name: 'forecast', engine_version: '1.1.0' },
                  { engine_name: 'confidence', engine_version: '1.0.0' },
                ],
                error: null,
              }
            ),
          }),
        }),
      };
    }
    return {};
  });

  return {
    client: { from: mockFrom } as unknown as import('@supabase/supabase-js').SupabaseClient,
    insertCalls,
    updateCalls,
    mockFrom,
  };
}

// =============================================================================
// Stage Handler Factories
// =============================================================================

function createSuccessHandlers(): StageHandlers {
  return {
    ingestion: vi.fn().mockResolvedValue(sampleIngestionOutput),
    fingerprint: vi.fn().mockResolvedValue(sampleFingerprint),
    similarity: vi.fn().mockResolvedValue(sampleSimilarityOutput),
    outcome: vi.fn().mockResolvedValue(sampleOutcome),
    forecast: vi.fn().mockResolvedValue(sampleForecast),
    confidence: vi.fn().mockResolvedValue(sampleConfidence),
    cache_write: vi.fn().mockResolvedValue(undefined),
  };
}

/** Handlers that track execution order and timing for trace verification. */
function createTrackedHandlers() {
  const executionLog: { stage: string; timestamp: number }[] = [];

  const handlers: StageHandlers = {
    ingestion: vi.fn().mockImplementation(async () => {
      executionLog.push({ stage: 'ingestion', timestamp: Date.now() });
      return sampleIngestionOutput;
    }),
    fingerprint: vi.fn().mockImplementation(async () => {
      executionLog.push({ stage: 'fingerprint', timestamp: Date.now() });
      return sampleFingerprint;
    }),
    similarity: vi.fn().mockImplementation(async () => {
      executionLog.push({ stage: 'similarity', timestamp: Date.now() });
      return sampleSimilarityOutput;
    }),
    outcome: vi.fn().mockImplementation(async () => {
      executionLog.push({ stage: 'outcome', timestamp: Date.now() });
      return sampleOutcome;
    }),
    forecast: vi.fn().mockImplementation(async () => {
      executionLog.push({ stage: 'forecast', timestamp: Date.now() });
      return sampleForecast;
    }),
    confidence: vi.fn().mockImplementation(async () => {
      executionLog.push({ stage: 'confidence', timestamp: Date.now() });
      return sampleConfidence;
    }),
    cache_write: vi.fn().mockImplementation(async () => {
      executionLog.push({ stage: 'cache_write', timestamp: Date.now() });
    }),
  };

  return { handlers, executionLog };
}

// =============================================================================
// Integration Tests
// =============================================================================

describe('Batch Pipeline Integration', () => {
  let mockSupabase: ReturnType<typeof createMockSupabase>;
  let handlers: StageHandlers;
  let orchestrator: BatchOrchestrator;

  beforeEach(() => {
    mockSupabase = createMockSupabase();
    handlers = createSuccessHandlers();
    orchestrator = new BatchOrchestrator({
      supabaseClient: mockSupabase.client,
      stageHandlers: handlers,
      timeoutMs: 10000,
    });
  });

  // ===========================================================================
  // 1. Full pipeline happy path (Req 14.1, 14.5)
  // ===========================================================================

  describe('Full pipeline happy path', () => {
    it('should execute all 7 stages end-to-end and transition batch status RUNNING → COMPLETED', async () => {
      const result = await orchestrator.execute(defaultInput);

      // Verify final status
      expect(result.status).toBe(BatchStatus.COMPLETED);
      expect(result.completed_stages).toEqual(PIPELINE_STAGES);
      expect(result.batch_id).toBeDefined();
      expect(result.total_duration_ms).toBeGreaterThanOrEqual(0);

      // Verify every handler was invoked exactly once
      expect(handlers.ingestion).toHaveBeenCalledTimes(1);
      expect(handlers.fingerprint).toHaveBeenCalledTimes(1);
      expect(handlers.similarity).toHaveBeenCalledTimes(1);
      expect(handlers.outcome).toHaveBeenCalledTimes(1);
      expect(handlers.forecast).toHaveBeenCalledTimes(1);
      expect(handlers.confidence).toHaveBeenCalledTimes(1);
      expect(handlers.cache_write).toHaveBeenCalledTimes(1);
    });

    it('should record engine version snapshot at batch start', async () => {
      const result = await orchestrator.execute(defaultInput);

      // The batch record inserted should contain the engine version snapshot
      expect(mockSupabase.insertCalls.length).toBeGreaterThanOrEqual(1);
      const batchRecord = mockSupabase.insertCalls[0] as Record<string, unknown>;
      expect(batchRecord.engine_versions).toEqual({
        fingerprint: '2.1.0',
        similarity: '1.3.0',
        outcome: '1.2.0',
        forecast: '1.1.0',
        confidence: '1.0.0',
      });
      expect(batchRecord.status).toBe(BatchStatus.RUNNING);
      expect(batchRecord.batch_id).toBe(result.batch_id);
    });

    it('should update batch record to COMPLETED with duration after all stages succeed', async () => {
      const result = await orchestrator.execute(defaultInput);

      expect(mockSupabase.updateCalls.length).toBeGreaterThanOrEqual(1);
      const lastUpdate = mockSupabase.updateCalls[mockSupabase.updateCalls.length - 1];
      const updateData = lastUpdate.data as Record<string, unknown>;
      expect(updateData.status).toBe(BatchStatus.COMPLETED);
      expect(updateData.total_duration_ms).toBeGreaterThanOrEqual(0);
      expect(updateData.completed_at).toBeDefined();
      expect(lastUpdate.batchId).toBe(result.batch_id);
    });

    it('should pass data through the pipeline chain correctly (predecessor → successor)', async () => {
      await orchestrator.execute(defaultInput);

      // Ingestion receives the trigger input
      expect(handlers.ingestion).toHaveBeenCalledWith(
        expect.objectContaining({
          asset: 'EURUSD',
          timeframe: '4H',
          candle_boundary: '2024-01-15T08:00:00.000Z',
        }),
      );

      // Fingerprint receives ingestion output data
      expect(handlers.fingerprint).toHaveBeenCalledWith(
        expect.objectContaining({
          asset: 'EURUSD',
          timestamp_utc: '2024-01-15T08:00:00.000Z',
          ohlc: sampleIngestionOutput.ohlc,
        }),
      );

      // Similarity receives query fingerprint
      expect(handlers.similarity).toHaveBeenCalledWith(
        expect.objectContaining({
          query_fingerprint: sampleFingerprint,
          top_n: 50,
        }),
        expect.any(String),
      );

      // Outcome receives matched fingerprint IDs from similarity
      expect(handlers.outcome).toHaveBeenCalledWith(
        expect.objectContaining({
          fingerprint_ids: ['fp-hist-100', 'fp-hist-101'],
        }),
        'fp-int-001',
        expect.any(String),
      );
    });
  });

  // ===========================================================================
  // 2. Execution traces emitted for each stage (Req 16.2)
  // ===========================================================================

  describe('Execution traces per stage', () => {
    it('should execute all stages in sequential order with each stage completing before the next begins', async () => {
      const { handlers: tracked, executionLog } = createTrackedHandlers();
      const trackedOrchestrator = new BatchOrchestrator({
        supabaseClient: mockSupabase.client,
        stageHandlers: tracked,
        timeoutMs: 10000,
      });

      const result = await trackedOrchestrator.execute(defaultInput);

      expect(result.status).toBe(BatchStatus.COMPLETED);
      expect(executionLog).toHaveLength(7);

      // Verify strict sequential ordering
      const stageOrder = executionLog.map((entry) => entry.stage);
      expect(stageOrder).toEqual([
        'ingestion',
        'fingerprint',
        'similarity',
        'outcome',
        'forecast',
        'confidence',
        'cache_write',
      ]);

      // Verify timestamps are monotonically non-decreasing
      for (let i = 1; i < executionLog.length; i++) {
        expect(executionLog[i].timestamp).toBeGreaterThanOrEqual(executionLog[i - 1].timestamp);
      }
    });

    it('should record batch_id consistently across all stage invocations', async () => {
      const result = await orchestrator.execute(defaultInput);
      const batchId = result.batch_id;

      // Similarity and outcome receive batch_id as a parameter
      expect(handlers.similarity).toHaveBeenCalledWith(expect.anything(), batchId);
      expect(handlers.outcome).toHaveBeenCalledWith(expect.anything(), expect.anything(), batchId);

      // Cache write receives batch_id in the data structure
      const cacheWriteArg = (handlers.cache_write as ReturnType<typeof vi.fn>).mock.calls[0][0] as CacheWriteInput;
      expect(cacheWriteArg.batch_id).toBe(batchId);
    });
  });

  // ===========================================================================
  // 3. Cache writing happens only after full completion (Req 14.5)
  // ===========================================================================

  describe('Cache write after full batch completion', () => {
    it('should invoke cache_write handler only after all preceding 6 stages complete', async () => {
      const callOrder: string[] = [];

      (handlers.ingestion as ReturnType<typeof vi.fn>).mockImplementation(async () => {
        callOrder.push('ingestion');
        return sampleIngestionOutput;
      });
      (handlers.fingerprint as ReturnType<typeof vi.fn>).mockImplementation(async () => {
        callOrder.push('fingerprint');
        return sampleFingerprint;
      });
      (handlers.similarity as ReturnType<typeof vi.fn>).mockImplementation(async () => {
        callOrder.push('similarity');
        return sampleSimilarityOutput;
      });
      (handlers.outcome as ReturnType<typeof vi.fn>).mockImplementation(async () => {
        callOrder.push('outcome');
        return sampleOutcome;
      });
      (handlers.forecast as ReturnType<typeof vi.fn>).mockImplementation(async () => {
        callOrder.push('forecast');
        return sampleForecast;
      });
      (handlers.confidence as ReturnType<typeof vi.fn>).mockImplementation(async () => {
        callOrder.push('confidence');
        return sampleConfidence;
      });
      (handlers.cache_write as ReturnType<typeof vi.fn>).mockImplementation(async () => {
        callOrder.push('cache_write');
        // At the time cache_write is called, all 6 preceding stages must have completed
        expect(callOrder.slice(0, 6)).toEqual([
          'ingestion', 'fingerprint', 'similarity', 'outcome', 'forecast', 'confidence',
        ]);
      });

      const result = await orchestrator.execute(defaultInput);
      expect(result.status).toBe(BatchStatus.COMPLETED);
      expect(callOrder).toHaveLength(7);
    });

    it('should pass complete aggregated data from all stages to cache_write handler', async () => {
      await orchestrator.execute(defaultInput);

      const cacheWriteArg = (handlers.cache_write as ReturnType<typeof vi.fn>).mock.calls[0][0] as CacheWriteInput;

      // Verify the cache write receives the complete output from all preceding stages
      expect(cacheWriteArg.fingerprint).toEqual(sampleFingerprint);
      expect(cacheWriteArg.similarity).toEqual(sampleSimilarityOutput);
      expect(cacheWriteArg.outcome).toEqual(sampleOutcome);
      expect(cacheWriteArg.forecast).toEqual(sampleForecast);
      expect(cacheWriteArg.confidence).toEqual(sampleConfidence);
      expect(cacheWriteArg.batch_id).toBeDefined();
    });

    it('should NOT invoke cache_write when an earlier stage fails', async () => {
      (handlers.forecast as ReturnType<typeof vi.fn>).mockRejectedValue(
        new Error('Forecast computation failed'),
      );

      const result = await orchestrator.execute(defaultInput);

      expect(result.status).toBe(BatchStatus.FAILED);
      expect(handlers.cache_write).not.toHaveBeenCalled();
    });
  });

  // ===========================================================================
  // 4. Pipeline failure and halt behaviour (Req 14.2)
  // ===========================================================================

  describe('Pipeline failure halts downstream stages', () => {
    it('should halt all downstream when stage 2 (fingerprint) fails — stages 3-7 not called', async () => {
      (handlers.fingerprint as ReturnType<typeof vi.fn>).mockRejectedValue(
        new Error('Fingerprint computation error'),
      );

      const result = await orchestrator.execute(defaultInput);

      expect(result.status).toBe(BatchStatus.FAILED);
      expect(result.failed_stage).toBe('fingerprint');
      expect(result.failure_detail).toContain('fingerprint');
      expect(result.failure_detail).toContain('Fingerprint computation error');
      expect(result.completed_stages).toEqual(['ingestion']);

      // Stages 3-7 should not have been invoked
      expect(handlers.similarity).not.toHaveBeenCalled();
      expect(handlers.outcome).not.toHaveBeenCalled();
      expect(handlers.forecast).not.toHaveBeenCalled();
      expect(handlers.confidence).not.toHaveBeenCalled();
      expect(handlers.cache_write).not.toHaveBeenCalled();
    });

    it('should halt all downstream when stage 4 (outcome) fails — stages 5-7 not called', async () => {
      (handlers.outcome as ReturnType<typeof vi.fn>).mockRejectedValue(
        new Error('No forward returns available'),
      );

      const result = await orchestrator.execute(defaultInput);

      expect(result.status).toBe(BatchStatus.FAILED);
      expect(result.failed_stage).toBe('outcome');
      expect(result.completed_stages).toEqual(['ingestion', 'fingerprint', 'similarity']);

      expect(handlers.forecast).not.toHaveBeenCalled();
      expect(handlers.confidence).not.toHaveBeenCalled();
      expect(handlers.cache_write).not.toHaveBeenCalled();
    });

    it('should update batch record to FAILED with failure detail identifying the failed stage', async () => {
      (handlers.similarity as ReturnType<typeof vi.fn>).mockRejectedValue(
        new Error('HNSW index corrupt'),
      );

      const result = await orchestrator.execute(defaultInput);

      expect(result.status).toBe(BatchStatus.FAILED);

      // Verify the batch_runs update was called with FAILED status
      expect(mockSupabase.updateCalls.length).toBeGreaterThanOrEqual(1);
      const lastUpdate = mockSupabase.updateCalls[mockSupabase.updateCalls.length - 1];
      const updateData = lastUpdate.data as Record<string, unknown>;
      expect(updateData.status).toBe(BatchStatus.FAILED);
      expect(updateData.failure_detail).toContain('similarity');
      expect(updateData.failure_detail).toContain('HNSW index corrupt');
      expect(lastUpdate.batchId).toBe(result.batch_id);
    });

    it('should handle null ingestion output as failure and halt all downstream', async () => {
      (handlers.ingestion as ReturnType<typeof vi.fn>).mockResolvedValue(null);

      const result = await orchestrator.execute(defaultInput);

      expect(result.status).toBe(BatchStatus.FAILED);
      expect(result.failed_stage).toBe('ingestion');
      expect(result.failure_detail).toContain('Ingestion returned null');
      expect(result.completed_stages).toEqual([]);
      expect(handlers.fingerprint).not.toHaveBeenCalled();
      expect(handlers.similarity).not.toHaveBeenCalled();
    });

    it('should correctly report completed_stages for partial pipeline execution', async () => {
      (handlers.confidence as ReturnType<typeof vi.fn>).mockRejectedValue(
        new Error('Confidence calc overflow'),
      );

      const result = await orchestrator.execute(defaultInput);

      expect(result.status).toBe(BatchStatus.FAILED);
      expect(result.failed_stage).toBe('confidence');
      expect(result.completed_stages).toEqual([
        'ingestion', 'fingerprint', 'similarity', 'outcome', 'forecast',
      ]);
      expect(handlers.cache_write).not.toHaveBeenCalled();
    });
  });

  // ===========================================================================
  // 5. Timeout scenario
  // ===========================================================================

  describe('Pipeline timeout behaviour', () => {
    it('should return TIMEOUT when pipeline exceeds configured timeout', async () => {
      const shortTimeoutOrchestrator = new BatchOrchestrator({
        supabaseClient: mockSupabase.client,
        stageHandlers: handlers,
        timeoutMs: 30,
      });

      // Make similarity stage take longer than timeout
      (handlers.similarity as ReturnType<typeof vi.fn>).mockImplementation(
        () => new Promise((resolve) => setTimeout(() => resolve(sampleSimilarityOutput), 200)),
      );

      const result = await shortTimeoutOrchestrator.execute(defaultInput);

      expect(result.status).toBe(BatchStatus.TIMEOUT);
      expect(result.failure_detail).toContain('timeout');
    });

    it('should update batch record to TIMEOUT status on timeout', async () => {
      const shortTimeoutOrchestrator = new BatchOrchestrator({
        supabaseClient: mockSupabase.client,
        stageHandlers: handlers,
        timeoutMs: 30,
      });

      (handlers.ingestion as ReturnType<typeof vi.fn>).mockImplementation(
        () => new Promise((resolve) => setTimeout(() => resolve(sampleIngestionOutput), 200)),
      );

      const result = await shortTimeoutOrchestrator.execute(defaultInput);

      expect(result.status).toBe(BatchStatus.TIMEOUT);
      expect(mockSupabase.updateCalls.length).toBeGreaterThanOrEqual(1);
      const lastUpdate = mockSupabase.updateCalls[mockSupabase.updateCalls.length - 1];
      const updateData = lastUpdate.data as Record<string, unknown>;
      expect(updateData.status).toBe(BatchStatus.TIMEOUT);
    });
  });

  // ===========================================================================
  // 6. Overlap detection (Req 14.2)
  // ===========================================================================

  describe('Overlap detection prevents concurrent batch runs', () => {
    it('should reject a new batch when a previous batch is still RUNNING', async () => {
      const overlappingSupabase = createMockSupabase({
        batchRunsSelect: { data: { batch_id: 'running-batch-xyz' }, error: null },
      });

      const overlappingOrchestrator = new BatchOrchestrator({
        supabaseClient: overlappingSupabase.client,
        stageHandlers: handlers,
        timeoutMs: 10000,
      });

      const result = await overlappingOrchestrator.execute(defaultInput);

      expect(result.status).toBe(BatchStatus.FAILED);
      expect(result.failure_detail).toContain('Overlap detected');
      expect(result.failure_detail).toContain('running-batch-xyz');

      // No stages should have been executed
      expect(handlers.ingestion).not.toHaveBeenCalled();
      expect(handlers.fingerprint).not.toHaveBeenCalled();
      expect(handlers.similarity).not.toHaveBeenCalled();
      expect(handlers.outcome).not.toHaveBeenCalled();
      expect(handlers.forecast).not.toHaveBeenCalled();
      expect(handlers.confidence).not.toHaveBeenCalled();
      expect(handlers.cache_write).not.toHaveBeenCalled();
    });

    it('should proceed normally when no overlapping batch is running', async () => {
      const result = await orchestrator.execute(defaultInput);
      expect(result.status).toBe(BatchStatus.COMPLETED);
      expect(handlers.ingestion).toHaveBeenCalledTimes(1);
    });

    it('should fail-open (proceed) when overlap check encounters a database error', async () => {
      const errorSupabase = createMockSupabase({
        batchRunsSelect: { data: null, error: { message: 'Connection refused' } },
      });

      const errorOrchestrator = new BatchOrchestrator({
        supabaseClient: errorSupabase.client,
        stageHandlers: handlers,
        timeoutMs: 10000,
      });

      const result = await errorOrchestrator.execute(defaultInput);

      // Should still complete successfully (fail-open)
      expect(result.status).toBe(BatchStatus.COMPLETED);
      expect(handlers.ingestion).toHaveBeenCalledTimes(1);
    });
  });
});
