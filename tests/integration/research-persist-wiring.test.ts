/**
 * Tests for research_persist handler wiring in the batch pipeline.
 *
 * Verifies:
 * - research_persist is called after all 7 stages succeed (fire-and-forget)
 * - research_persist failure does NOT halt the batch (status remains COMPLETED)
 * - research_persist receives correct pipeline context (fingerprint, forecast, confidence, engine_versions, candle_boundary)
 * - research_persist is NOT called when a stage fails
 *
 * Validates: Requirements 9.2, 9.3, 3.3, 6.4
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  BatchOrchestrator,
  type StageHandlers,
  type BatchTriggerInput,
  type ResearchPersistInput,
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
  fingerprint_id: 'fp-rp-001',
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
      fingerprint_id: 'fp-rp-001',
      match_fingerprint_id: 'fp-hist-200',
      similarity_score: 0.91,
      rank: 1,
      layer_breakdown: { market_structure: 0.9, volatility: 0.88, liquidity: 0.87, macro: 0.9, sentiment: 0.85 },
      match_explanation: { matched_layers: ['market_structure'], mismatched_layers: [], primary_match_reason: 'strong_alignment' },
      batch_id: 'batch-rp-1',
    },
  ],
  match_count: 1,
  regime_weights_used: { market_structure: 0.25, volatility: 0.2, liquidity: 0.15, macro: 0.25, sentiment: 0.15 },
};

const sampleOutcome: OutcomeDistribution = {
  fingerprint_id: 'fp-rp-001',
  sample_size: 42,
  mean_return: 12.0,
  median_return: 10.0,
  direction_probability: { up: 0.58, down: 0.27, flat: 0.15 },
  volatility_profile: { std_dev: 0.3, max_absolute_return: 50 },
  risk_range: { p10: -15, p50: 10, p90: 40 },
  confidence_inputs: { regime_consistency: 0.72, distribution_sharpness: 0.6 },
  batch_id: 'batch-rp-1',
  engine_version: '1.0.0',
};

const sampleForecast: Forecast = {
  fingerprint_id: 'fp-rp-001',
  direction_probabilities: { up: 0.58, down: 0.27, flat: 0.15 },
  expected_move_pips: 12.0,
  confidence_raw: 0.68,
  confidence_final: 0.55,
  engine_version: '1.0.0',
  batch_id: 'batch-rp-1',
};

const sampleConfidence: ConfidenceOutput = {
  confidence_raw: 0.68,
  sample_weight: 1.0,
  regime_stability: 0.81,
  confidence_final: 0.55,
};

const defaultInput: BatchTriggerInput = {
  asset: 'EURUSD',
  timeframe: '4H',
  candle_boundary: '2024-01-15T08:00:00.000Z',
};

// =============================================================================
// Mock Supabase
// =============================================================================

function createMockSupabase() {
  const mockFrom = vi.fn().mockImplementation((table: string) => {
    if (table === 'batch_runs') {
      return {
        select: vi.fn().mockReturnValue({
          eq: vi.fn().mockReturnValue({
            limit: vi.fn().mockReturnValue({
              maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null }),
            }),
          }),
        }),
        insert: vi.fn().mockReturnValue({ error: null }),
        update: vi.fn().mockReturnValue({
          eq: vi.fn().mockReturnValue({ error: null }),
        }),
      };
    }
    if (table === 'engine_versions') {
      return {
        select: vi.fn().mockReturnValue({
          eq: vi.fn().mockReturnValue({
            order: vi.fn().mockResolvedValue({
              data: [
                { engine_name: 'fingerprint', engine_version: '2.1.0' },
                { engine_name: 'similarity', engine_version: '1.3.0' },
                { engine_name: 'outcome', engine_version: '1.2.0' },
                { engine_name: 'forecast', engine_version: '1.1.0' },
                { engine_name: 'confidence', engine_version: '1.0.0' },
              ],
              error: null,
            }),
          }),
        }),
      };
    }
    return {};
  });

  return { from: mockFrom } as unknown as import('@supabase/supabase-js').SupabaseClient;
}

// =============================================================================
// Helpers
// =============================================================================

function createHandlersWithResearchPersist(
  researchPersistFn: StageHandlers['research_persist'],
): StageHandlers {
  return {
    ingestion: vi.fn().mockResolvedValue(sampleIngestionOutput),
    fingerprint: vi.fn().mockResolvedValue(sampleFingerprint),
    similarity: vi.fn().mockResolvedValue(sampleSimilarityOutput),
    outcome: vi.fn().mockResolvedValue(sampleOutcome),
    forecast: vi.fn().mockResolvedValue(sampleForecast),
    confidence: vi.fn().mockResolvedValue(sampleConfidence),
    cache_write: vi.fn().mockResolvedValue(undefined),
    research_persist: researchPersistFn,
  };
}

// =============================================================================
// Tests
// =============================================================================

describe('Research Persist Wiring in Batch Pipeline', () => {
  let mockSupabase: ReturnType<typeof createMockSupabase>;

  beforeEach(() => {
    mockSupabase = createMockSupabase();
  });

  it('should call research_persist after all 7 stages succeed', async () => {
    const researchPersist = vi.fn().mockResolvedValue(undefined);
    const handlers = createHandlersWithResearchPersist(researchPersist);

    const orchestrator = new BatchOrchestrator({
      supabaseClient: mockSupabase,
      stageHandlers: handlers,
      timeoutMs: 10000,
    });

    const result = await orchestrator.execute(defaultInput);

    expect(result.status).toBe(BatchStatus.COMPLETED);

    // Allow microtask queue to flush the fire-and-forget promise
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(researchPersist).toHaveBeenCalledTimes(1);
  });

  it('should pass correct pipeline context to research_persist', async () => {
    let capturedInput: ResearchPersistInput | null = null;
    const researchPersist = vi.fn().mockImplementation(async (data: ResearchPersistInput) => {
      capturedInput = data;
    });
    const handlers = createHandlersWithResearchPersist(researchPersist);

    const orchestrator = new BatchOrchestrator({
      supabaseClient: mockSupabase,
      stageHandlers: handlers,
      timeoutMs: 10000,
    });

    const result = await orchestrator.execute(defaultInput);
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(result.status).toBe(BatchStatus.COMPLETED);
    expect(capturedInput).not.toBeNull();
    expect(capturedInput!.fingerprint).toEqual(sampleFingerprint);
    expect(capturedInput!.forecast).toEqual(sampleForecast);
    expect(capturedInput!.confidence).toEqual(sampleConfidence);
    expect(capturedInput!.outcome).toEqual(sampleOutcome);
    expect(capturedInput!.similarity).toEqual(sampleSimilarityOutput);
    expect(capturedInput!.batch_id).toBe(result.batch_id);
    expect(capturedInput!.candle_boundary).toBe('2024-01-15T08:00:00.000Z');
    expect(capturedInput!.engine_versions).toEqual({
      fingerprint: '2.1.0',
      similarity: '1.3.0',
      outcome: '1.2.0',
      forecast: '1.1.0',
      confidence: '1.0.0',
    });
  });

  it('should still return COMPLETED when research_persist fails (fire-and-forget)', async () => {
    const researchPersist = vi.fn().mockRejectedValue(new Error('DB insert failed'));
    const handlers = createHandlersWithResearchPersist(researchPersist);

    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const orchestrator = new BatchOrchestrator({
      supabaseClient: mockSupabase,
      stageHandlers: handlers,
      timeoutMs: 10000,
    });

    const result = await orchestrator.execute(defaultInput);

    // The batch still completes — research persistence failure is non-blocking
    expect(result.status).toBe(BatchStatus.COMPLETED);

    // Allow microtask queue to flush so the error is logged
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(researchPersist).toHaveBeenCalledTimes(1);
    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining('Research persistence failed'),
    );

    consoleSpy.mockRestore();
  });

  it('should NOT call research_persist when a pipeline stage fails', async () => {
    const researchPersist = vi.fn().mockResolvedValue(undefined);
    const handlers = createHandlersWithResearchPersist(researchPersist);

    // Make forecast stage fail
    (handlers.forecast as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error('Forecast engine crashed'),
    );

    const orchestrator = new BatchOrchestrator({
      supabaseClient: mockSupabase,
      stageHandlers: handlers,
      timeoutMs: 10000,
    });

    const result = await orchestrator.execute(defaultInput);

    expect(result.status).toBe(BatchStatus.FAILED);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(researchPersist).not.toHaveBeenCalled();
  });

  it('should work correctly when research_persist is not provided (optional)', async () => {
    const handlers: StageHandlers = {
      ingestion: vi.fn().mockResolvedValue(sampleIngestionOutput),
      fingerprint: vi.fn().mockResolvedValue(sampleFingerprint),
      similarity: vi.fn().mockResolvedValue(sampleSimilarityOutput),
      outcome: vi.fn().mockResolvedValue(sampleOutcome),
      forecast: vi.fn().mockResolvedValue(sampleForecast),
      confidence: vi.fn().mockResolvedValue(sampleConfidence),
      cache_write: vi.fn().mockResolvedValue(undefined),
    };

    const orchestrator = new BatchOrchestrator({
      supabaseClient: mockSupabase,
      stageHandlers: handlers,
      timeoutMs: 10000,
    });

    const result = await orchestrator.execute(defaultInput);
    expect(result.status).toBe(BatchStatus.COMPLETED);
  });
});
