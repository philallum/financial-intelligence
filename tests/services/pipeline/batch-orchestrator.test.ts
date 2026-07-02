/**
 * Unit tests for the Batch Pipeline Orchestration Service.
 *
 * Verifies:
 * - Sequential stage execution
 * - Failure halts downstream
 * - Timeout handling
 * - Overlap detection
 * - Batch status transitions
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  BatchOrchestrator,
  PIPELINE_STAGES,
  type StageHandlers,
  type BatchTriggerInput,
  type BatchOrchestratorConfig,
} from '../../../src/services/pipeline/batch-orchestrator.js';
import { BatchStatus } from '../../../src/types/enums.js';
import type {
  IngestionOutput,
  Fingerprint,
  SimilarityOutput,
  OutcomeDistribution,
  Forecast,
  ConfidenceOutput,
} from '../../../src/types/index.js';

// =============================================================================
// Mocks
// =============================================================================

/** Create a mock Supabase client. */
function createMockSupabase(overrides: {
  batchRunsSelect?: { data: unknown; error: unknown };
  engineVersionsSelect?: { data: unknown; error: unknown };
  batchRunsInsert?: { error: unknown };
  batchRunsUpdate?: { error: unknown };
} = {}) {
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
        insert: vi.fn().mockResolvedValue(
          overrides.batchRunsInsert ?? { error: null }
        ),
        update: vi.fn().mockReturnValue({
          eq: vi.fn().mockResolvedValue(
            overrides.batchRunsUpdate ?? { error: null }
          ),
        }),
      };
    }
    if (table === 'engine_versions') {
      return {
        select: vi.fn().mockReturnValue({
          eq: vi.fn().mockReturnValue({
            order: vi.fn().mockResolvedValue(
              overrides.engineVersionsSelect ?? {
                data: [
                  { engine_name: 'fingerprint', engine_version: '1.0.0' },
                  { engine_name: 'similarity', engine_version: '1.0.0' },
                  { engine_name: 'outcome', engine_version: '1.0.0' },
                  { engine_name: 'forecast', engine_version: '1.0.0' },
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

  return { from: mockFrom } as unknown as import('@supabase/supabase-js').SupabaseClient;
}

/** Sample ingestion output. */
const sampleIngestionOutput: IngestionOutput = {
  asset: 'EURUSD',
  timestamp_utc: '2024-01-15T08:00:00.000Z',
  ohlc: { open: 1.085, high: 1.09, low: 1.083, close: 1.088 },
  volume: 1000,
  ingestion_time: '2024-01-15T08:02:00.000Z',
};

/** Sample fingerprint. */
const sampleFingerprint: Fingerprint = {
  fingerprint_id: 'fp-123',
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

/** Sample similarity output. */
const sampleSimilarityOutput: SimilarityOutput = {
  matches: [
    {
      fingerprint_id: 'fp-123',
      match_fingerprint_id: 'fp-hist-1',
      similarity_score: 0.92,
      rank: 1,
      layer_breakdown: { market_structure: 0.9, volatility: 0.85, liquidity: 0.88, macro: 0.9, sentiment: 0.8 },
      match_explanation: { matched_layers: ['market_structure'], mismatched_layers: [], primary_match_reason: 'strong_market_structure_alignment' },
      batch_id: 'batch-1',
    },
  ],
  match_count: 1,
  regime_weights_used: { market_structure: 0.2, volatility: 0.15, liquidity: 0.15, macro: 0.3, sentiment: 0.2 },
};

/** Sample outcome distribution. */
const sampleOutcome: OutcomeDistribution = {
  fingerprint_id: 'fp-123',
  sample_size: 40,
  mean_return: 12.5,
  median_return: 10.0,
  direction_probability: { up: 0.6, down: 0.25, flat: 0.15 },
  volatility_profile: { std_dev: 0.3, max_absolute_return: 50 },
  risk_range: { p10: -20, p50: 10, p90: 40 },
  confidence_inputs: { regime_consistency: 0.7, distribution_sharpness: 0.6 },
  batch_id: 'batch-1',
  engine_version: '1.0.0',
};

/** Sample forecast. */
const sampleForecast: Forecast = {
  fingerprint_id: 'fp-123',
  direction_probabilities: { up: 0.6, down: 0.25, flat: 0.15 },
  expected_move_pips: 12.5,
  confidence_raw: 0,
  confidence_final: 0,
  engine_version: '1.0.0',
  batch_id: 'batch-1',
};

/** Sample confidence output. */
const sampleConfidence: ConfidenceOutput = {
  confidence_raw: 0.72,
  sample_weight: 1.0,
  regime_stability: 0.85,
  confidence_final: 0.612,
};

/** Create mock stage handlers where all stages succeed. */
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

const defaultInput: BatchTriggerInput = {
  asset: 'EURUSD',
  timeframe: '4H',
  candle_boundary: '2024-01-15T08:00:00.000Z',
};

// =============================================================================
// Tests
// =============================================================================

describe('BatchOrchestrator', () => {
  let mockSupabase: ReturnType<typeof createMockSupabase>;
  let handlers: StageHandlers;
  let orchestrator: BatchOrchestrator;

  beforeEach(() => {
    mockSupabase = createMockSupabase();
    handlers = createSuccessHandlers();
    orchestrator = new BatchOrchestrator({
      supabaseClient: mockSupabase,
      stageHandlers: handlers,
      timeoutMs: 5000, // 5s for tests
    });
  });

  describe('Sequential stage execution', () => {
    it('should execute all 7 stages in order and return COMPLETED', async () => {
      const result = await orchestrator.execute(defaultInput);

      expect(result.status).toBe(BatchStatus.COMPLETED);
      expect(result.completed_stages).toEqual(PIPELINE_STAGES);
      expect(result.total_duration_ms).toBeGreaterThanOrEqual(0);
      expect(result.batch_id).toBeDefined();
    });

    it('should call each stage handler exactly once', async () => {
      await orchestrator.execute(defaultInput);

      expect(handlers.ingestion).toHaveBeenCalledTimes(1);
      expect(handlers.fingerprint).toHaveBeenCalledTimes(1);
      expect(handlers.similarity).toHaveBeenCalledTimes(1);
      expect(handlers.outcome).toHaveBeenCalledTimes(1);
      expect(handlers.forecast).toHaveBeenCalledTimes(1);
      expect(handlers.confidence).toHaveBeenCalledTimes(1);
      expect(handlers.cache_write).toHaveBeenCalledTimes(1);
    });

    it('should pass predecessor output to the next stage', async () => {
      await orchestrator.execute(defaultInput);

      // Fingerprint receives ingestion output data
      expect(handlers.fingerprint).toHaveBeenCalledWith(
        expect.objectContaining({
          asset: 'EURUSD',
          timestamp_utc: '2024-01-15T08:00:00.000Z',
          ohlc: sampleIngestionOutput.ohlc,
        }),
      );

      // Similarity receives fingerprint
      expect(handlers.similarity).toHaveBeenCalledWith(
        expect.objectContaining({
          query_fingerprint: sampleFingerprint,
          top_n: 50,
        }),
        expect.any(String), // batch_id
      );

      // Outcome receives matched fingerprint IDs
      expect(handlers.outcome).toHaveBeenCalledWith(
        expect.objectContaining({
          fingerprint_ids: ['fp-hist-1'],
        }),
        'fp-123', // query fingerprint id
        expect.any(String), // batch_id
      );
    });

    it('should execute stages sequentially (not in parallel)', async () => {
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
      });

      await orchestrator.execute(defaultInput);

      expect(callOrder).toEqual([
        'ingestion',
        'fingerprint',
        'similarity',
        'outcome',
        'forecast',
        'confidence',
        'cache_write',
      ]);
    });
  });

  describe('Failure halts downstream', () => {
    it('should halt downstream stages when ingestion fails', async () => {
      (handlers.ingestion as ReturnType<typeof vi.fn>).mockRejectedValue(
        new Error('Provider timeout'),
      );

      const result = await orchestrator.execute(defaultInput);

      expect(result.status).toBe(BatchStatus.FAILED);
      expect(result.failed_stage).toBe('ingestion');
      expect(result.failure_detail).toContain('ingestion');
      expect(result.failure_detail).toContain('Provider timeout');
      expect(result.completed_stages).toEqual([]);
      expect(handlers.fingerprint).not.toHaveBeenCalled();
      expect(handlers.similarity).not.toHaveBeenCalled();
    });

    it('should halt downstream stages when fingerprint fails', async () => {
      (handlers.fingerprint as ReturnType<typeof vi.fn>).mockRejectedValue(
        new Error('Invalid OHLC data'),
      );

      const result = await orchestrator.execute(defaultInput);

      expect(result.status).toBe(BatchStatus.FAILED);
      expect(result.failed_stage).toBe('fingerprint');
      expect(result.completed_stages).toEqual(['ingestion']);
      expect(handlers.similarity).not.toHaveBeenCalled();
      expect(handlers.outcome).not.toHaveBeenCalled();
    });

    it('should halt downstream stages when similarity fails', async () => {
      (handlers.similarity as ReturnType<typeof vi.fn>).mockRejectedValue(
        new Error('HNSW index unavailable'),
      );

      const result = await orchestrator.execute(defaultInput);

      expect(result.status).toBe(BatchStatus.FAILED);
      expect(result.failed_stage).toBe('similarity');
      expect(result.completed_stages).toEqual(['ingestion', 'fingerprint']);
      expect(handlers.outcome).not.toHaveBeenCalled();
    });

    it('should halt downstream when outcome stage fails', async () => {
      (handlers.outcome as ReturnType<typeof vi.fn>).mockRejectedValue(
        new Error('No forward returns found'),
      );

      const result = await orchestrator.execute(defaultInput);

      expect(result.status).toBe(BatchStatus.FAILED);
      expect(result.failed_stage).toBe('outcome');
      expect(result.completed_stages).toEqual(['ingestion', 'fingerprint', 'similarity']);
      expect(handlers.forecast).not.toHaveBeenCalled();
    });

    it('should halt downstream when forecast stage fails', async () => {
      (handlers.forecast as ReturnType<typeof vi.fn>).mockRejectedValue(
        new Error('Insufficient data'),
      );

      const result = await orchestrator.execute(defaultInput);

      expect(result.status).toBe(BatchStatus.FAILED);
      expect(result.failed_stage).toBe('forecast');
      expect(result.completed_stages).toEqual(['ingestion', 'fingerprint', 'similarity', 'outcome']);
      expect(handlers.confidence).not.toHaveBeenCalled();
    });

    it('should halt downstream when confidence stage fails', async () => {
      (handlers.confidence as ReturnType<typeof vi.fn>).mockRejectedValue(
        new Error('Invalid probability input'),
      );

      const result = await orchestrator.execute(defaultInput);

      expect(result.status).toBe(BatchStatus.FAILED);
      expect(result.failed_stage).toBe('confidence');
      expect(result.completed_stages).toEqual(['ingestion', 'fingerprint', 'similarity', 'outcome', 'forecast']);
      expect(handlers.cache_write).not.toHaveBeenCalled();
    });

    it('should report failure when cache_write fails', async () => {
      (handlers.cache_write as ReturnType<typeof vi.fn>).mockRejectedValue(
        new Error('Cache write timeout'),
      );

      const result = await orchestrator.execute(defaultInput);

      expect(result.status).toBe(BatchStatus.FAILED);
      expect(result.failed_stage).toBe('cache_write');
      expect(result.completed_stages).toEqual([
        'ingestion', 'fingerprint', 'similarity', 'outcome', 'forecast', 'confidence',
      ]);
    });

    it('should treat null ingestion output as failure', async () => {
      (handlers.ingestion as ReturnType<typeof vi.fn>).mockResolvedValue(null);

      const result = await orchestrator.execute(defaultInput);

      expect(result.status).toBe(BatchStatus.FAILED);
      expect(result.failed_stage).toBe('ingestion');
      expect(result.failure_detail).toContain('Ingestion returned null');
      expect(handlers.fingerprint).not.toHaveBeenCalled();
    });
  });

  describe('Timeout handling', () => {
    it('should return TIMEOUT status when pipeline exceeds timeout', async () => {
      // Create orchestrator with very short timeout
      const shortTimeoutOrchestrator = new BatchOrchestrator({
        supabaseClient: mockSupabase,
        stageHandlers: handlers,
        timeoutMs: 50, // 50ms timeout
      });

      // Make ingestion take longer than timeout
      (handlers.ingestion as ReturnType<typeof vi.fn>).mockImplementation(
        () => new Promise((resolve) => setTimeout(() => resolve(sampleIngestionOutput), 200)),
      );

      const result = await shortTimeoutOrchestrator.execute(defaultInput);

      expect(result.status).toBe(BatchStatus.TIMEOUT);
      expect(result.failure_detail).toContain('timeout');
    });

    it('should use default BATCH_TIMEOUT_MS when timeoutMs not specified', () => {
      const orchestratorNoTimeout = new BatchOrchestrator({
        supabaseClient: mockSupabase,
        stageHandlers: handlers,
      });

      // Just verify it creates without error
      expect(orchestratorNoTimeout).toBeDefined();
    });
  });

  describe('Overlap detection', () => {
    it('should detect overlap when a batch is already running', async () => {
      const overlappingSupabase = createMockSupabase({
        batchRunsSelect: { data: { batch_id: 'existing-batch-123' }, error: null },
      });

      const overlappingOrchestrator = new BatchOrchestrator({
        supabaseClient: overlappingSupabase,
        stageHandlers: handlers,
        timeoutMs: 5000,
      });

      const result = await overlappingOrchestrator.execute(defaultInput);

      expect(result.status).toBe(BatchStatus.FAILED);
      expect(result.failure_detail).toContain('Overlap detected');
      expect(result.failure_detail).toContain('existing-batch-123');
      expect(handlers.ingestion).not.toHaveBeenCalled();
    });

    it('should proceed when no overlap exists', async () => {
      const result = await orchestrator.execute(defaultInput);

      expect(result.status).toBe(BatchStatus.COMPLETED);
      expect(handlers.ingestion).toHaveBeenCalled();
    });

    it('should proceed (fail-open) when overlap check has a database error', async () => {
      const errorSupabase = createMockSupabase({
        batchRunsSelect: { data: null, error: { message: 'Connection timeout' } },
      });

      const errorOrchestrator = new BatchOrchestrator({
        supabaseClient: errorSupabase,
        stageHandlers: handlers,
        timeoutMs: 5000,
      });

      const result = await errorOrchestrator.execute(defaultInput);

      // Should still proceed
      expect(result.status).toBe(BatchStatus.COMPLETED);
    });
  });

  describe('Batch status transitions', () => {
    it('should generate a unique batch_id', async () => {
      const result1 = await orchestrator.execute(defaultInput);
      const result2 = await orchestrator.execute(defaultInput);

      expect(result1.batch_id).toBeDefined();
      expect(result2.batch_id).toBeDefined();
      expect(result1.batch_id).not.toBe(result2.batch_id);
    });

    it('should record total_duration_ms on completion', async () => {
      const result = await orchestrator.execute(defaultInput);

      expect(result.total_duration_ms).toBeGreaterThanOrEqual(0);
      expect(typeof result.total_duration_ms).toBe('number');
    });

    it('should transition to COMPLETED when all stages succeed', async () => {
      const result = await orchestrator.execute(defaultInput);
      expect(result.status).toBe(BatchStatus.COMPLETED);
    });

    it('should transition to FAILED on stage error', async () => {
      (handlers.outcome as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('DB error'));
      const result = await orchestrator.execute(defaultInput);
      expect(result.status).toBe(BatchStatus.FAILED);
    });

    it('should transition to TIMEOUT on global timeout exceed', async () => {
      const shortTimeoutOrchestrator = new BatchOrchestrator({
        supabaseClient: mockSupabase,
        stageHandlers: handlers,
        timeoutMs: 10,
      });

      (handlers.ingestion as ReturnType<typeof vi.fn>).mockImplementation(
        () => new Promise((resolve) => setTimeout(() => resolve(sampleIngestionOutput), 100)),
      );

      const result = await shortTimeoutOrchestrator.execute(defaultInput);
      expect(result.status).toBe(BatchStatus.TIMEOUT);
    });
  });

  describe('Engine version snapshot', () => {
    it('should snapshot engine versions from the database', async () => {
      const versions = await orchestrator.snapshotEngineVersions();

      expect(versions).toEqual({
        fingerprint: '1.0.0',
        similarity: '1.0.0',
        outcome: '1.0.0',
        forecast: '1.0.0',
        confidence: '1.0.0',
      });
    });

    it('should return empty object when engine_versions query fails', async () => {
      const errorSupabase = createMockSupabase({
        engineVersionsSelect: { data: null, error: { message: 'Table not found' } },
      });

      const errorOrchestrator = new BatchOrchestrator({
        supabaseClient: errorSupabase,
        stageHandlers: handlers,
        timeoutMs: 5000,
      });

      const versions = await errorOrchestrator.snapshotEngineVersions();
      expect(versions).toEqual({});
    });
  });

  describe('checkOverlap', () => {
    it('should return is_overlapping=false when no running batch exists', async () => {
      const result = await orchestrator.checkOverlap();
      expect(result.is_overlapping).toBe(false);
      expect(result.running_batch_id).toBeUndefined();
    });

    it('should return is_overlapping=true with running batch_id', async () => {
      const overlappingSupabase = createMockSupabase({
        batchRunsSelect: { data: { batch_id: 'running-batch-456' }, error: null },
      });

      const overlappingOrchestrator = new BatchOrchestrator({
        supabaseClient: overlappingSupabase,
        stageHandlers: handlers,
        timeoutMs: 5000,
      });

      const result = await overlappingOrchestrator.checkOverlap();
      expect(result.is_overlapping).toBe(true);
      expect(result.running_batch_id).toBe('running-batch-456');
    });
  });
});
