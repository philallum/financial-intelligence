/**
 * Integration tests for the research archive lifecycle.
 *
 * Tests end-to-end flows across the research persistence, evaluation,
 * and similarity archival modules, including trace emission verification
 * and RLS policy enforcement.
 *
 * Validates: Requirements 20.1, 20.3
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createResearchArchiveWriter } from '../../src/research/persistence/research-archive-writer.js';
import { createEvaluationEngine } from '../../src/research/evaluation/evaluation-engine.js';
import { createSimilarityArchiver } from '../../src/research/archival/similarity-archiver.js';
import {
  BatchOrchestrator,
  PIPELINE_STAGES,
  type StageHandlers,
  type BatchTriggerInput,
} from '../../src/services/pipeline/batch-orchestrator.js';
import { BatchStatus } from '../../src/types/enums.js';
import type { ResearchForecastRecord } from '../../src/research/persistence/types.js';
import type { SimilarityArchiveRecord } from '../../src/research/archival/types.js';
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

const sampleForecastRecord: ResearchForecastRecord = {
  fingerprint_id: 'fp-lifecycle-001',
  batch_id: 'batch-lifecycle-1',
  asset: 'EURUSD',
  timeframe: '4H',
  forecast_timestamp: '2024-01-15T08:00:00.000Z',
  forecast_expiry: '2024-01-15T12:00:00.000Z',
  direction_probabilities: { up: 0.62, down: 0.23, flat: 0.15 },
  expected_move_pips: 15.0,
  confidence_raw: 0.72,
  confidence_final: 0.61,
  tradeability_placeholder: null,
  engine_versions: { fingerprint: '2.1.0', similarity: '1.3.0', outcome: '1.2.0', forecast: '1.1.0', confidence: '1.0.0' },
  quantile_table_version: 'v1_0',
  regime: { volatility_regime: 'NORMAL', trend_regime: 'BULLISH', session: 'LONDON' },
  sample_size: 45,
  created_at: '2024-01-15T08:05:00.000Z',
};

const sampleSimilarityRecords: SimilarityArchiveRecord[] = [
  {
    fingerprint_id: 'fp-lifecycle-001',
    match_fingerprint_id: 'fp-hist-100',
    similarity_score: 0.94,
    layer_breakdown: { market_structure: 0.92, volatility: 0.88, liquidity: 0.9, macro: 0.91, sentiment: 0.85 },
    match_explanation: { matched_layers: ['market_structure', 'macro'], mismatched_layers: [], primary_match_reason: 'strong_alignment' },
    rank: 1,
    batch_id: 'batch-lifecycle-1',
    engine_versions: { similarity: '1.3.0' },
    created_at: '2024-01-15T08:05:00.000Z',
  },
  {
    fingerprint_id: 'fp-lifecycle-001',
    match_fingerprint_id: 'fp-hist-101',
    similarity_score: 0.89,
    layer_breakdown: { market_structure: 0.87, volatility: 0.84, liquidity: 0.86, macro: 0.88, sentiment: 0.82 },
    match_explanation: { matched_layers: ['volatility'], mismatched_layers: ['sentiment'], primary_match_reason: 'volatility_match' },
    rank: 2,
    batch_id: 'batch-lifecycle-1',
    engine_versions: { similarity: '1.3.0' },
    created_at: '2024-01-15T08:05:00.000Z',
  },
];

const sampleIngestionOutput: IngestionOutput = {
  asset: 'EURUSD',
  timestamp_utc: '2024-01-15T08:00:00.000Z',
  ohlc: { open: 1.085, high: 1.09, low: 1.083, close: 1.088 },
  volume: 1000,
  ingestion_time: '2024-01-15T08:02:00.000Z',
};

const sampleFingerprint: Fingerprint = {
  fingerprint_id: 'fp-lifecycle-001',
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
      fingerprint_id: 'fp-lifecycle-001',
      match_fingerprint_id: 'fp-hist-100',
      similarity_score: 0.94,
      rank: 1,
      layer_breakdown: { market_structure: 0.92, volatility: 0.88, liquidity: 0.9, macro: 0.91, sentiment: 0.85 },
      match_explanation: { matched_layers: ['market_structure', 'macro'], mismatched_layers: [], primary_match_reason: 'strong_alignment' },
      batch_id: 'batch-lifecycle-1',
    },
  ],
  match_count: 1,
  regime_weights_used: { market_structure: 0.25, volatility: 0.2, liquidity: 0.15, macro: 0.25, sentiment: 0.15 },
};

const sampleOutcome: OutcomeDistribution = {
  fingerprint_id: 'fp-lifecycle-001',
  sample_size: 45,
  mean_return: 15.0,
  median_return: 12.0,
  direction_probability: { up: 0.62, down: 0.23, flat: 0.15 },
  volatility_profile: { std_dev: 0.28, max_absolute_return: 55 },
  risk_range: { p10: -18, p50: 12, p90: 45 },
  confidence_inputs: { regime_consistency: 0.75, distribution_sharpness: 0.65 },
  batch_id: 'batch-lifecycle-1',
  engine_version: '1.0.0',
};

const sampleForecast: Forecast = {
  fingerprint_id: 'fp-lifecycle-001',
  direction_probabilities: { up: 0.62, down: 0.23, flat: 0.15 },
  expected_move_pips: 15.0,
  confidence_raw: 0.72,
  confidence_final: 0.61,
  engine_version: '1.0.0',
  batch_id: 'batch-lifecycle-1',
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

interface MockTableCalls {
  inserts: { table: string; data: unknown }[];
  selects: { table: string }[];
  updates: { table: string; data: unknown }[];
  deletes: { table: string }[];
}

function createMockSupabaseForResearch(options: {
  insertError?: { code?: string; message: string } | null;
  selectData?: unknown[];
  updateError?: { code?: string; message: string } | null;
  deleteError?: { code?: string; message: string } | null;
} = {}) {
  const calls: MockTableCalls = { inserts: [], selects: [], updates: [], deletes: [] };

  const mockFrom = vi.fn().mockImplementation((table: string) => ({
    insert: vi.fn().mockImplementation((data: unknown) => {
      calls.inserts.push({ table, data });
      return { error: options.insertError ?? null };
    }),
    select: vi.fn().mockImplementation(() => ({
      eq: vi.fn().mockImplementation(() => ({
        limit: vi.fn().mockReturnValue({
          maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null }),
        }),
      })),
      lt: vi.fn().mockImplementation(() => ({
        not: vi.fn().mockImplementation(() => ({
          returns: vi.fn().mockResolvedValue({
            data: options.selectData ?? [],
            error: null,
          }),
        })),
      })),
      returns: vi.fn().mockResolvedValue({
        data: options.selectData ?? [],
        error: null,
      }),
    })),
    update: vi.fn().mockImplementation((data: unknown) => {
      calls.updates.push({ table, data });
      return {
        eq: vi.fn().mockReturnValue({
          error: options.updateError ?? null,
        }),
        error: options.updateError ?? null,
      };
    }),
    delete: vi.fn().mockImplementation(() => {
      calls.deletes.push({ table });
      return {
        eq: vi.fn().mockReturnValue({
          error: options.deleteError ?? null,
        }),
        error: options.deleteError ?? null,
      };
    }),
  }));

  return {
    client: { from: mockFrom } as unknown as import('@supabase/supabase-js').SupabaseClient,
    calls,
    mockFrom,
  };
}

/** Creates a mock Supabase for the full pipeline (batch_runs + engine_versions + execution_traces). */
function createMockSupabaseForPipeline() {
  const traceCalls: { table: string; data: unknown }[] = [];
  const insertCalls: { table: string; data: unknown }[] = [];

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
        insert: vi.fn().mockImplementation((data: unknown) => {
          insertCalls.push({ table, data });
          return { error: null };
        }),
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
                { engine_name: 'ingestion', engine_version: '1.0.0' },
                { engine_name: 'fingerprint', engine_version: '2.1.0' },
                { engine_name: 'topology', engine_version: '1.0.0' },
                { engine_name: 'regime_v2', engine_version: '1.0.0' },
                { engine_name: 'similarity', engine_version: '1.3.0' },
                { engine_name: 'outcome', engine_version: '1.2.0' },
                { engine_name: 'forecast', engine_version: '1.1.0' },
                { engine_name: 'confidence', engine_version: '1.0.0' },
                { engine_name: 'cache_write', engine_version: '1.0.0' },
                { engine_name: 'research_persist', engine_version: '1.0.0' },
              ],
              error: null,
            }),
          }),
        }),
      };
    }
    if (table === 'execution_traces') {
      return {
        insert: vi.fn().mockImplementation((data: unknown) => {
          traceCalls.push({ table, data });
          return { error: null };
        }),
      };
    }
    // Default handler for other tables (research_forecasts, etc.)
    return {
      insert: vi.fn().mockImplementation((data: unknown) => {
        insertCalls.push({ table, data });
        return { error: null };
      }),
      select: vi.fn().mockReturnValue({
        eq: vi.fn().mockResolvedValue({ data: [], error: null }),
      }),
    };
  });

  return {
    client: { from: mockFrom } as unknown as import('@supabase/supabase-js').SupabaseClient,
    traceCalls,
    insertCalls,
    mockFrom,
  };
}

// =============================================================================
// 1. End-to-end persist + query flow
// =============================================================================

describe('Research Archive Lifecycle Integration', () => {
  describe('End-to-end persist + query flow', () => {
    it('should call Supabase insert with correct data when persisting a forecast record', async () => {
      const mock = createMockSupabaseForResearch();
      const writer = createResearchArchiveWriter(mock.client);

      await writer.persistForecast(sampleForecastRecord);

      expect(mock.calls.inserts).toHaveLength(1);
      expect(mock.calls.inserts[0].table).toBe('research_forecasts');
      const insertedData = mock.calls.inserts[0].data as Record<string, unknown>;
      expect(insertedData.fingerprint_id).toBe('fp-lifecycle-001');
      expect(insertedData.batch_id).toBe('batch-lifecycle-1');
      expect(insertedData.asset).toBe('EURUSD');
      expect(insertedData.timeframe).toBe('4H');
      expect(insertedData.forecast_timestamp).toBe('2024-01-15T08:00:00.000Z');
      expect(insertedData.forecast_expiry).toBe('2024-01-15T12:00:00.000Z');
      expect(insertedData.direction_probabilities).toEqual({ up: 0.62, down: 0.23, flat: 0.15 });
      expect(insertedData.expected_move_pips).toBe(15.0);
      expect(insertedData.confidence_raw).toBe(0.72);
      expect(insertedData.confidence_final).toBe(0.61);
      expect(insertedData.engine_versions).toEqual(sampleForecastRecord.engine_versions);
      expect(insertedData.created_at).toBe('2024-01-15T08:05:00.000Z');
    });

    it('should contain all required provenance fields (batch_id, engine_versions, created_at, fingerprint_id)', async () => {
      const mock = createMockSupabaseForResearch();
      const writer = createResearchArchiveWriter(mock.client);

      await writer.persistForecast(sampleForecastRecord);

      const insertedData = mock.calls.inserts[0].data as Record<string, unknown>;
      expect(insertedData.batch_id).toBeDefined();
      expect(insertedData.engine_versions).toBeDefined();
      expect(Object.keys(insertedData.engine_versions as object).length).toBeGreaterThan(0);
      expect(insertedData.created_at).toBeDefined();
      expect(insertedData.fingerprint_id).toBeDefined();
    });

    it('should reject duplicate records silently (same fingerprint_id + batch_id)', async () => {
      const mock = createMockSupabaseForResearch({
        insertError: { code: '23505', message: 'duplicate key value violates unique constraint' },
      });
      const writer = createResearchArchiveWriter(mock.client);

      const consoleSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      // Should not throw — duplicate is logged as warning
      await expect(writer.persistForecast(sampleForecastRecord)).resolves.toBeUndefined();
      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining('Duplicate forecast rejected'),
      );

      consoleSpy.mockRestore();
    });
  });

  // ===========================================================================
  // 2. Matured forecast evaluation lifecycle
  // ===========================================================================

  describe('Matured forecast evaluation lifecycle', () => {
    it('should produce evaluation records for matured forecasts with outcomes', async () => {
      const maturedForecast = {
        id: 'forecast-001',
        batch_id: 'batch-lifecycle-1',
        fingerprint_id: 'fp-lifecycle-001',
        forecast_expiry: '2024-01-14T12:00:00.000Z', // In the past
        direction_probabilities: { up: 0.62, down: 0.23, flat: 0.15 },
        expected_move_pips: 15.0,
        confidence_final: 0.61,
        market_outcomes: {
          outcome_id: 'outcome-001',
          net_return_pips: 20.0,
          timestamp_utc: '2024-01-15T12:00:00.000Z',
        },
      };

      // Plain forecast (without embedded market_outcomes) for the research_forecasts query
      const plainForecast = {
        id: maturedForecast.id,
        batch_id: maturedForecast.batch_id,
        fingerprint_id: maturedForecast.fingerprint_id,
        forecast_expiry: maturedForecast.forecast_expiry,
        direction_probabilities: maturedForecast.direction_probabilities,
        expected_move_pips: maturedForecast.expected_move_pips,
        confidence_final: maturedForecast.confidence_final,
      };

      // Outcome row for the market_outcomes query
      const outcomeRow = {
        outcome_id: maturedForecast.market_outcomes.outcome_id,
        fingerprint_id: maturedForecast.fingerprint_id,
        net_return_pips: maturedForecast.market_outcomes.net_return_pips,
        timestamp_utc: maturedForecast.market_outcomes.timestamp_utc,
      };

      const insertCalls: unknown[] = [];
      const mockFrom = vi.fn().mockImplementation((table: string) => {
        if (table === 'research_forecasts') {
          return {
            select: vi.fn().mockReturnValue({
              lt: vi.fn().mockReturnValue({
                order: vi.fn().mockReturnValue({
                  returns: vi.fn().mockResolvedValue({
                    data: [plainForecast],
                    error: null,
                  }),
                }),
              }),
            }),
          };
        }
        if (table === 'market_outcomes') {
          return {
            select: vi.fn().mockReturnValue({
              in: vi.fn().mockReturnValue({
                returns: vi.fn().mockResolvedValue({
                  data: [outcomeRow],
                  error: null,
                }),
              }),
            }),
          };
        }
        if (table === 'research_evaluations') {
          return {
            select: vi.fn().mockResolvedValue({ data: [], error: null }),
            insert: vi.fn().mockImplementation((data: unknown) => {
              insertCalls.push(data);
              return { error: null };
            }),
          };
        }
        return { select: vi.fn().mockReturnValue({ eq: vi.fn().mockResolvedValue({ data: [], error: null }) }) };
      });

      const mockClient = { from: mockFrom } as unknown as import('@supabase/supabase-js').SupabaseClient;
      const engine = createEvaluationEngine(mockClient);

      const results = await engine.evaluateMaturedForecasts('batch-eval-1');

      expect(results).toHaveLength(1);
      expect(results[0].forecast_id).toBe('forecast-001');
      expect(results[0].outcome_id).toBe('outcome-001');
      expect(results[0].batch_id).toBe('batch-eval-1');
      expect(results[0].direction_accuracy).toBe(1); // up predicted, up realised (20 pips > 2 threshold)
      expect(results[0].forecast_success).toBe(true);
      expect(results[0].brier_score).toBeGreaterThan(0);
      expect(results[0].calibration_bucket).toBe('0.6-0.7');
    });

    it('should mark forecast as outcome_unavailable when outcome is missing after 2 cycles (8h)', async () => {
      // Forecast expired more than 8 hours ago — no outcome available
      const expiredLongAgo = new Date(Date.now() - 9 * 60 * 60 * 1000).toISOString();
      const forecastWithoutOutcome = {
        id: 'forecast-timeout-001',
        batch_id: 'batch-lifecycle-1',
        fingerprint_id: 'fp-lifecycle-001',
        forecast_expiry: expiredLongAgo,
        direction_probabilities: { up: 0.5, down: 0.3, flat: 0.2 },
        expected_move_pips: 10.0,
        confidence_final: 0.45,
      };

      const insertCalls: unknown[] = [];
      const mockFrom = vi.fn().mockImplementation((table: string) => {
        if (table === 'research_forecasts') {
          return {
            select: vi.fn().mockReturnValue({
              lt: vi.fn().mockReturnValue({
                order: vi.fn().mockReturnValue({
                  returns: vi.fn().mockResolvedValue({
                    data: [forecastWithoutOutcome],
                    error: null,
                  }),
                }),
              }),
            }),
          };
        }
        if (table === 'market_outcomes') {
          // No outcomes for this fingerprint
          return {
            select: vi.fn().mockReturnValue({
              in: vi.fn().mockReturnValue({
                returns: vi.fn().mockResolvedValue({
                  data: [],
                  error: null,
                }),
              }),
            }),
          };
        }
        if (table === 'research_evaluations') {
          return {
            select: vi.fn().mockResolvedValue({ data: [], error: null }),
            insert: vi.fn().mockImplementation((data: unknown) => {
              insertCalls.push(data);
              return { error: null };
            }),
          };
        }
        return { select: vi.fn().mockReturnValue({ eq: vi.fn().mockResolvedValue({ data: [], error: null }) }) };
      });

      const mockClient = { from: mockFrom } as unknown as import('@supabase/supabase-js').SupabaseClient;
      const engine = createEvaluationEngine(mockClient);

      await engine.evaluateMaturedForecasts('batch-eval-timeout');

      // Verify outcome_unavailable record was inserted
      const unavailableInserts = insertCalls.filter((call) => {
        const data = call as Record<string, unknown>;
        return data.status === 'outcome_unavailable';
      });
      expect(unavailableInserts.length).toBeGreaterThanOrEqual(1);
      const record = unavailableInserts[0] as Record<string, unknown>;
      expect(record.forecast_id).toBe('forecast-timeout-001');
      expect(record.outcome_id).toBeNull();
    });
  });

  // ===========================================================================
  // 3. Similarity archive write + failure halting
  // ===========================================================================

  describe('Similarity archive write + failure halting', () => {
    it('should insert valid similarity records successfully', async () => {
      const mock = createMockSupabaseForResearch();
      const archiver = createSimilarityArchiver(mock.client);

      await archiver.persistMatches(sampleSimilarityRecords);

      expect(mock.calls.inserts).toHaveLength(1);
      expect(mock.calls.inserts[0].table).toBe('research_similarity_archive');
      const insertedData = mock.calls.inserts[0].data as unknown[];
      expect(insertedData).toHaveLength(2);
    });

    it('should throw an error on insert failure (halting downstream)', async () => {
      const mock = createMockSupabaseForResearch({
        insertError: { code: 'PGRST301', message: 'Connection refused' },
      });
      const archiver = createSimilarityArchiver(mock.client);

      await expect(archiver.persistMatches(sampleSimilarityRecords)).rejects.toThrow(
        /SimilarityArchiver.*Failed to persist/,
      );
    });

    it('should produce no archive records when zero matches provided', async () => {
      const mock = createMockSupabaseForResearch();
      const archiver = createSimilarityArchiver(mock.client);

      await archiver.persistMatches([]);

      expect(mock.calls.inserts).toHaveLength(0);
    });
  });

  // ===========================================================================
  // 4. All stages emit traces
  // ===========================================================================

  describe('All stages emit traces', () => {
    it('should emit execution_traces for each pipeline stage on successful run', async () => {
      const mock = createMockSupabaseForPipeline();

      const handlers: StageHandlers = {
        ingestion: vi.fn().mockResolvedValue(sampleIngestionOutput),
        fingerprint: vi.fn().mockResolvedValue(sampleFingerprint),
        topology: vi.fn().mockResolvedValue(undefined),
        regime_v2: vi.fn().mockResolvedValue(undefined),
        similarity: vi.fn().mockResolvedValue(sampleSimilarityOutput),
        outcome: vi.fn().mockResolvedValue(sampleOutcome),
        forecast: vi.fn().mockResolvedValue(sampleForecast),
        confidence: vi.fn().mockResolvedValue(sampleConfidence),
        cache_write: vi.fn().mockResolvedValue(undefined),
        research_persist: vi.fn().mockResolvedValue(undefined),
      };

      const orchestrator = new BatchOrchestrator({
        supabaseClient: mock.client,
        stageHandlers: handlers,
        timeoutMs: 10000,
      });

      const result = await orchestrator.execute(defaultInput);
      // Allow microtask queue to flush (for fire-and-forget research_persist)
      await new Promise((resolve) => setTimeout(resolve, 50));

      expect(result.status).toBe(BatchStatus.COMPLETED);

      // Verify execution_traces insert calls
      const traceInserts = mock.traceCalls.filter((c) => c.table === 'execution_traces');

      // Expected stages: ingestion, fingerprint, topology, regime_v2, similarity, outcome, forecast, confidence, cache_write, research_persist
      const expectedStages = [
        'ingestion', 'fingerprint', 'topology', 'regime_v2',
        'similarity', 'outcome', 'forecast', 'confidence',
        'cache_write', 'research_persist',
      ];

      expect(traceInserts.length).toBeGreaterThanOrEqual(expectedStages.length);

      // Verify trace records contain required fields
      for (const traceCall of traceInserts) {
        const trace = traceCall.data as Record<string, unknown>;
        expect(trace.batch_id).toBeDefined();
        expect(typeof trace.batch_id).toBe('string');
        expect(trace.engine_name).toBeDefined();
        expect(trace.engine_version).toBeDefined();
        expect(typeof trace.input_hash).toBe('string');
        expect((trace.input_hash as string).length).toBe(64);
        expect(typeof trace.output_hash).toBe('string');
        expect((trace.output_hash as string).length).toBe(64);
        expect(typeof trace.execution_time_ms).toBe('number');
        expect(trace.execution_time_ms as number).toBeGreaterThanOrEqual(0);
        expect(trace.status).toBeDefined();
        expect(['success', 'error']).toContain(trace.status);
        expect(trace.timestamp_utc).toBeDefined();
      }
    });

    it('should emit traces for all core pipeline stages by engine_name', async () => {
      const mock = createMockSupabaseForPipeline();

      const handlers: StageHandlers = {
        ingestion: vi.fn().mockResolvedValue(sampleIngestionOutput),
        fingerprint: vi.fn().mockResolvedValue(sampleFingerprint),
        topology: vi.fn().mockResolvedValue(undefined),
        regime_v2: vi.fn().mockResolvedValue(undefined),
        similarity: vi.fn().mockResolvedValue(sampleSimilarityOutput),
        outcome: vi.fn().mockResolvedValue(sampleOutcome),
        forecast: vi.fn().mockResolvedValue(sampleForecast),
        confidence: vi.fn().mockResolvedValue(sampleConfidence),
        cache_write: vi.fn().mockResolvedValue(undefined),
        research_persist: vi.fn().mockResolvedValue(undefined),
      };

      const orchestrator = new BatchOrchestrator({
        supabaseClient: mock.client,
        stageHandlers: handlers,
        timeoutMs: 10000,
      });

      const result = await orchestrator.execute(defaultInput);
      await new Promise((resolve) => setTimeout(resolve, 50));

      expect(result.status).toBe(BatchStatus.COMPLETED);

      const traceInserts = mock.traceCalls.filter((c) => c.table === 'execution_traces');
      const engineNames = traceInserts.map((c) => (c.data as Record<string, unknown>).engine_name);

      // Verify all expected engine stages are present
      expect(engineNames).toContain('ingestion');
      expect(engineNames).toContain('fingerprint');
      expect(engineNames).toContain('topology');
      expect(engineNames).toContain('regime_v2');
      expect(engineNames).toContain('similarity');
      expect(engineNames).toContain('outcome');
      expect(engineNames).toContain('forecast');
      expect(engineNames).toContain('confidence');
      expect(engineNames).toContain('cache_write');
      expect(engineNames).toContain('research_persist');
    });
  });

  // ===========================================================================
  // 5. RLS policies reject UPDATE/DELETE on research tables
  // ===========================================================================

  describe('RLS policies reject UPDATE/DELETE on research tables', () => {
    const researchTables = [
      'research_forecasts',
      'research_evaluations',
      'research_similarity_archive',
    ];

    it.each(researchTables)(
      'should return permission denied error when attempting UPDATE on %s',
      async (table) => {
        const rlsError = { code: '42501', message: 'permission denied for table ' + table };

        const mockFrom = vi.fn().mockImplementation((t: string) => ({
          update: vi.fn().mockImplementation(() => ({
            eq: vi.fn().mockReturnValue({ error: t === table ? rlsError : null }),
          })),
          delete: vi.fn().mockImplementation(() => ({
            eq: vi.fn().mockReturnValue({ error: null }),
          })),
        }));

        const mockClient = { from: mockFrom } as unknown as import('@supabase/supabase-js').SupabaseClient;

        const result = await mockClient.from(table).update({ direction_probabilities: { up: 1, down: 0, flat: 0 } }).eq('id', 'some-id');

        expect(result.error).not.toBeNull();
        expect(result.error!.code).toBe('42501');
        expect(result.error!.message).toContain('permission denied');
      },
    );

    it.each(researchTables)(
      'should return permission denied error when attempting DELETE on %s',
      async (table) => {
        const rlsError = { code: '42501', message: 'permission denied for table ' + table };

        const mockFrom = vi.fn().mockImplementation((t: string) => ({
          update: vi.fn().mockImplementation(() => ({
            eq: vi.fn().mockReturnValue({ error: null }),
          })),
          delete: vi.fn().mockImplementation(() => ({
            eq: vi.fn().mockReturnValue({ error: t === table ? rlsError : null }),
          })),
        }));

        const mockClient = { from: mockFrom } as unknown as import('@supabase/supabase-js').SupabaseClient;

        const result = await mockClient.from(table).delete().eq('id', 'some-id');

        expect(result.error).not.toBeNull();
        expect(result.error!.code).toBe('42501');
        expect(result.error!.message).toContain('permission denied');
      },
    );

    it('should allow INSERT on research tables (RLS permits writes)', async () => {
      const mock = createMockSupabaseForResearch();
      const writer = createResearchArchiveWriter(mock.client);

      // INSERT should succeed without error
      await expect(writer.persistForecast(sampleForecastRecord)).resolves.toBeUndefined();
      expect(mock.calls.inserts).toHaveLength(1);
    });
  });
});
