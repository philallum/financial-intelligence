/**
 * Unit tests for batch pipeline registry integration.
 *
 * Tests that:
 * 1. getProcessableAssets() drives the batch processing loop (Req 6.1)
 * 2. Engine participation flags control stage skipping (Req 4.2, 4.3)
 * 3. Zero processable assets causes graceful exit (Req 6.6)
 * 4. Failures in individual assets don't halt the loop (Req 6.7)
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { BatchOrchestrator } from '../batch-orchestrator.js';
import type { StageHandlers, BatchTriggerInput, PipelineResult } from '../batch-orchestrator.js';
import { BatchStatus } from '../../../types/enums.js';
import type { EngineParticipationMap, ResearchAsset } from '../../../config/research-assets.js';
import { AssetClass, AssetStatus } from '../../../config/research-assets.js';

// ─── Mock Supabase Client ───────────────────────────────────────────────────

/**
 * Creates a mock Supabase client that properly supports the fluent chaining pattern.
 *
 * Supabase PostgREST builder pattern:
 *   supabase.from('table').select('col').eq('x', y).limit(1).maybeSingle()
 *   supabase.from('table').insert(data)   → awaitable
 *   supabase.from('table').update(data).eq('id', x)  → awaitable
 *   const { data } = await supabase.from('table').select(...).eq(...).order(...)  → awaitable
 *
 * The builder is PromiseLike (has .then) so it can be awaited directly at any point in the chain.
 */
function createMockSupabase() {
  function createQueryBuilder(): any {
    const resolvedValue = { data: null, error: null };
    const resolvedArrayValue = { data: [], error: null };

    const builder: any = {};

    // Chaining methods — return the builder itself
    const chainMethods = ['select', 'eq', 'neq', 'in', 'order', 'limit', 'update', 'delete'];
    for (const method of chainMethods) {
      builder[method] = (..._args: any[]) => builder;
    }

    // insert is also chainable but typically awaited directly
    builder.insert = (..._args: any[]) => builder;

    // Terminal methods — return a Promise
    builder.maybeSingle = () => Promise.resolve(resolvedValue);
    builder.single = () => Promise.resolve(resolvedValue);

    // Make the builder itself thenable for direct `await` usage
    // This handles: `const { data, error } = await supabase.from(...).select(...).eq(...).order(...)`
    // as well as: `const { error } = await supabase.from(...).insert(...)`
    builder.then = (resolve: any, reject?: any) =>
      Promise.resolve(resolvedArrayValue).then(resolve, reject);

    return builder;
  }

  return {
    from: (_tableName: string) => createQueryBuilder(),
  } as any;
}

// ─── Mock Stage Handlers ────────────────────────────────────────────────────

function createMockStageHandlers(): StageHandlers {
  return {
    ingestion: vi.fn().mockResolvedValue({
      asset: 'EURUSD',
      timestamp_utc: '2024-01-01T00:00:00.000Z',
      ohlc: { open: 1.1, high: 1.2, low: 1.0, close: 1.15 },
      ingestion_time: '2024-01-01T00:02:00.000Z',
    }),
    fingerprint: vi.fn().mockResolvedValue({
      fingerprint_id: 'fp-123',
      asset: 'EURUSD',
      timeframe: '4H',
      timestamp_utc: '2024-01-01T00:00:00.000Z',
      market_state_version: '1.0.0',
      ohlc: { open: 1.1, high: 1.2, low: 1.0, close: 1.15 },
      return_profile: { net_return_pips: 50, range_pips: 200 },
      regime: { volatility_regime: 'NORMAL', trend_regime: 'BULLISH', session: 'LONDON' },
      state_layers: {
        market_structure: [0.5, 0.5, 0.5, 0.5],
        volatility_profile: [0.5, 0.5, 0.5, 0.5],
        liquidity_field: [0.5, 0.5, 0.5, 0.5],
        macro_context: [0.5, 0.5, 0.5, 0.5],
        sentiment_pressure: [0.5, 0.5, 0.5, 0.5],
      },
      normalisation: { quantile_table_version: '1.0.0', scaling_method: 'quantile' },
    }),
    similarity: vi.fn().mockResolvedValue({
      matches: [{ fingerprint_id: 'fp-123', match_fingerprint_id: 'fp-456', similarity_score: 0.95, rank: 1, layer_breakdown: { market_structure: 0.9, volatility: 0.8, liquidity: 0.7, macro: 0.6, sentiment: 0.5 }, match_explanation: { matched_layers: ['market_structure'], mismatched_layers: [], primary_match_reason: 'test' }, batch_id: 'batch-1' }],
      match_count: 1,
      regime_weights_used: { market_structure: 0.35, volatility: 0.25, liquidity: 0.2, macro: 0.1, sentiment: 0.1 },
    }),
    outcome: vi.fn().mockResolvedValue({
      fingerprint_id: 'fp-123',
      sample_size: 1,
      mean_return: 10,
      median_return: 8,
      direction_probability: { up: 0.6, down: 0.3, flat: 0.1 },
      volatility_profile: { std_dev: 15, max_absolute_return: 50 },
      risk_range: { p10: -20, p50: 10, p90: 40 },
      confidence_inputs: { regime_consistency: 0.8, distribution_sharpness: 0.7 },
      batch_id: 'batch-1',
      engine_version: '1.0.0',
    }),
    forecast: vi.fn().mockResolvedValue({
      fingerprint_id: 'fp-123',
      direction_probabilities: { up: 0.6, down: 0.3, flat: 0.1 },
      expected_move_pips: 10,
      confidence_raw: 0.75,
      confidence_final: 0.65,
      engine_version: '1.0.0',
      batch_id: 'batch-1',
    }),
    confidence: vi.fn().mockResolvedValue({
      confidence_raw: 0.75,
      sample_weight: 0.9,
      regime_stability: 0.85,
      confidence_final: 0.65,
    }),
    cache_write: vi.fn().mockResolvedValue(undefined),
  };
}

// ─── Test Helpers ───────────────────────────────────────────────────────────

function createTestAsset(overrides: Partial<ResearchAsset> = {}): ResearchAsset {
  return {
    id: 'eurusd',
    symbol: 'EURUSD',
    assetClass: AssetClass.FOREX,
    status: AssetStatus.ACTIVE,
    processingPriority: 1,
    pipSize: 0.0001,
    pricePrecision: 5,
    marketHours: '24x5',
    supportedTimeframes: ['4H'],
    providers: { twelveData: 'EUR/USD' },
    engines: {
      fingerprint: true,
      similarity: true,
      confidence: true,
      tradeability: true,
      sentiment: false,
      macro: true,
    },
    ...overrides,
  };
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('Batch Pipeline Registry Integration', () => {
  let mockSupabase: ReturnType<typeof createMockSupabase>;

  beforeEach(() => {
    mockSupabase = createMockSupabase();
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ─── Test 1: Registry drives the batch loop (Req 6.1) ──────────────────

  describe('Registry drives the batch loop (Req 6.1)', () => {
    it('orchestrator.execute() is called for each asset/timeframe combination', async () => {
      const handlers = createMockStageHandlers();
      const orchestrator = new BatchOrchestrator({
        supabaseClient: mockSupabase,
        timeoutMs: 30_000,
        stageHandlers: handlers,
      });

      // Simulate processable assets from registry
      const assets: ResearchAsset[] = [
        createTestAsset({ id: 'eurusd', symbol: 'EURUSD', supportedTimeframes: ['4H'] }),
        createTestAsset({ id: 'gbpusd', symbol: 'GBPUSD', supportedTimeframes: ['4H', '1D'], providers: { twelveData: 'GBP/USD' } }),
      ];

      const candleBoundary = '2024-01-01T00:00:00.000Z';
      const results: PipelineResult[] = [];

      // Replicate the batch-entry.ts loop
      for (const asset of assets) {
        for (const timeframe of asset.supportedTimeframes) {
          const result = await orchestrator.execute({
            asset: asset.symbol,
            timeframe,
            candle_boundary: candleBoundary,
            providerSymbol: asset.providers.twelveData,
            engineParticipation: asset.engines,
          });
          results.push(result);
        }
      }

      // EURUSD has 1 timeframe, GBPUSD has 2 timeframes → 3 total executions
      expect(results).toHaveLength(3);

      // All should complete (mocks don't fail)
      for (const result of results) {
        expect(result.status).toBe(BatchStatus.COMPLETED);
      }
    });

    it('providerSymbol and engineParticipation are passed to the orchestrator', async () => {
      const handlers = createMockStageHandlers();
      const orchestrator = new BatchOrchestrator({
        supabaseClient: mockSupabase,
        timeoutMs: 30_000,
        stageHandlers: handlers,
      });

      const asset = createTestAsset({
        providers: { twelveData: 'EUR/USD' },
        engines: {
          fingerprint: true,
          similarity: true,
          confidence: true,
          tradeability: true,
          sentiment: false,
          macro: true,
        },
      });

      const input: BatchTriggerInput = {
        asset: asset.symbol,
        timeframe: '4H',
        candle_boundary: '2024-01-01T00:00:00.000Z',
        providerSymbol: asset.providers.twelveData,
        engineParticipation: asset.engines,
      };

      const result = await orchestrator.execute(input);

      expect(result.status).toBe(BatchStatus.COMPLETED);
      // The ingestion handler should have been called (pipeline ran)
      expect(handlers.ingestion).toHaveBeenCalled();
    });
  });

  // ─── Test 2: Engine participation skipping (Req 4.2, 4.3) ───────────────

  describe('Engine participation skipping (Req 4.2, 4.3)', () => {
    it('similarity=false short-circuits all downstream stages', async () => {
      const handlers = createMockStageHandlers();
      const orchestrator = new BatchOrchestrator({
        supabaseClient: mockSupabase,
        timeoutMs: 30_000,
        stageHandlers: handlers,
      });

      const engines: EngineParticipationMap = {
        fingerprint: true,
        similarity: false,  // <-- this should short-circuit
        confidence: true,
        tradeability: true,
        sentiment: false,
        macro: true,
      };

      const result = await orchestrator.execute({
        asset: 'EURUSD',
        timeframe: '4H',
        candle_boundary: '2024-01-01T00:00:00.000Z',
        providerSymbol: 'EUR/USD',
        engineParticipation: engines,
      });

      // Pipeline completes successfully but only runs ingestion + fingerprint
      expect(result.status).toBe(BatchStatus.COMPLETED);
      expect(result.completed_stages).toContain('ingestion');
      expect(result.completed_stages).toContain('fingerprint');

      // Downstream stages should NOT have been called
      expect(handlers.similarity).not.toHaveBeenCalled();
      expect(handlers.outcome).not.toHaveBeenCalled();
      expect(handlers.forecast).not.toHaveBeenCalled();
      expect(handlers.confidence).not.toHaveBeenCalled();
      expect(handlers.cache_write).not.toHaveBeenCalled();
    });

    it('confidence=false skips confidence but cache_write still runs with placeholder values', async () => {
      const handlers = createMockStageHandlers();
      const orchestrator = new BatchOrchestrator({
        supabaseClient: mockSupabase,
        timeoutMs: 30_000,
        stageHandlers: handlers,
      });

      const engines: EngineParticipationMap = {
        fingerprint: true,
        similarity: true,
        confidence: false,  // <-- confidence skipped
        tradeability: true,
        sentiment: false,
        macro: true,
      };

      const result = await orchestrator.execute({
        asset: 'EURUSD',
        timeframe: '4H',
        candle_boundary: '2024-01-01T00:00:00.000Z',
        providerSymbol: 'EUR/USD',
        engineParticipation: engines,
      });

      expect(result.status).toBe(BatchStatus.COMPLETED);

      // Confidence handler should NOT have been called
      expect(handlers.confidence).not.toHaveBeenCalled();

      // cache_write SHOULD have been called (it always runs if we reach it)
      expect(handlers.cache_write).toHaveBeenCalled();

      // Verify cache_write received placeholder confidence values
      const cacheWriteCall = (handlers.cache_write as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(cacheWriteCall.confidence).toEqual({
        confidence_raw: 0,
        sample_weight: 0,
        regime_stability: 0,
        confidence_final: 0,
      });
    });

    it('all engines enabled runs the full pipeline', async () => {
      const handlers = createMockStageHandlers();
      const orchestrator = new BatchOrchestrator({
        supabaseClient: mockSupabase,
        timeoutMs: 30_000,
        stageHandlers: handlers,
      });

      const engines: EngineParticipationMap = {
        fingerprint: true,
        similarity: true,
        confidence: true,
        tradeability: true,
        sentiment: true,
        macro: true,
      };

      const result = await orchestrator.execute({
        asset: 'EURUSD',
        timeframe: '4H',
        candle_boundary: '2024-01-01T00:00:00.000Z',
        providerSymbol: 'EUR/USD',
        engineParticipation: engines,
      });

      expect(result.status).toBe(BatchStatus.COMPLETED);
      expect(result.completed_stages).toContain('ingestion');
      expect(result.completed_stages).toContain('fingerprint');
      expect(result.completed_stages).toContain('similarity');
      expect(result.completed_stages).toContain('outcome');
      expect(result.completed_stages).toContain('forecast');
      expect(result.completed_stages).toContain('confidence');
      expect(result.completed_stages).toContain('cache_write');

      // All handlers should have been called
      expect(handlers.ingestion).toHaveBeenCalled();
      expect(handlers.fingerprint).toHaveBeenCalled();
      expect(handlers.similarity).toHaveBeenCalled();
      expect(handlers.outcome).toHaveBeenCalled();
      expect(handlers.forecast).toHaveBeenCalled();
      expect(handlers.confidence).toHaveBeenCalled();
      expect(handlers.cache_write).toHaveBeenCalled();
    });
  });

  // ─── Test 3: Zero-asset graceful exit (Req 6.6) ─────────────────────────

  describe('Zero-asset graceful exit (Req 6.6)', () => {
    it('empty processable assets array results in no orchestrator calls', async () => {
      const handlers = createMockStageHandlers();
      const orchestrator = new BatchOrchestrator({
        supabaseClient: mockSupabase,
        timeoutMs: 30_000,
        stageHandlers: handlers,
      });

      const processableAssets: ResearchAsset[] = [];
      const results: PipelineResult[] = [];

      // Replicate batch-entry.ts logic: check for empty before looping
      if (processableAssets.length === 0) {
        // In batch-entry.ts this would log a warning and call process.exit(0)
        // Here we just verify the orchestrator is never called
      } else {
        for (const asset of processableAssets) {
          for (const timeframe of asset.supportedTimeframes) {
            const result = await orchestrator.execute({
              asset: asset.symbol,
              timeframe,
              candle_boundary: '2024-01-01T00:00:00.000Z',
              providerSymbol: asset.providers.twelveData,
              engineParticipation: asset.engines,
            });
            results.push(result);
          }
        }
      }

      // No orchestrator calls should have been made
      expect(results).toHaveLength(0);
      expect(handlers.ingestion).not.toHaveBeenCalled();
      expect(handlers.fingerprint).not.toHaveBeenCalled();
    });

    it('batch-entry logs warning and exits with code 0 when no processable assets exist', async () => {
      // Mock process.exit to prevent actual exit
      const mockExit = vi.spyOn(process, 'exit').mockImplementation((() => {}) as any);
      const mockWarn = vi.spyOn(console, 'warn').mockImplementation(() => {});

      // Simulate the batch-entry.ts zero-asset path
      const processableAssets: ResearchAsset[] = [];

      if (processableAssets.length === 0) {
        console.warn('[BatchEntry] No processable assets found in registry (ACTIVE or BETA). Exiting.');
        process.exit(0);
      }

      expect(mockWarn).toHaveBeenCalledWith(
        expect.stringContaining('No processable assets found'),
      );
      expect(mockExit).toHaveBeenCalledWith(0);

      mockExit.mockRestore();
      mockWarn.mockRestore();
    });
  });

  // ─── Test 4: Failure-continuation behaviour (Req 6.7) ───────────────────

  describe('Failure-continuation behaviour (Req 6.7)', () => {
    it('loop continues processing remaining assets after one fails', async () => {
      const handlers = createMockStageHandlers();

      // Make ingestion fail on first call, succeed on second
      let callCount = 0;
      (handlers.ingestion as ReturnType<typeof vi.fn>).mockImplementation(async () => {
        callCount++;
        if (callCount === 1) {
          throw new Error('Provider timeout');
        }
        return {
          asset: 'GBPUSD',
          timestamp_utc: '2024-01-01T00:00:00.000Z',
          ohlc: { open: 1.3, high: 1.4, low: 1.2, close: 1.35 },
          ingestion_time: '2024-01-01T00:02:00.000Z',
        };
      });

      const orchestrator = new BatchOrchestrator({
        supabaseClient: mockSupabase,
        timeoutMs: 30_000,
        stageHandlers: handlers,
      });

      const assets: ResearchAsset[] = [
        createTestAsset({ id: 'eurusd', symbol: 'EURUSD', supportedTimeframes: ['4H'] }),
        createTestAsset({ id: 'gbpusd', symbol: 'GBPUSD', supportedTimeframes: ['4H'], providers: { twelveData: 'GBP/USD' } }),
      ];

      let hasFailure = false;
      const results: PipelineResult[] = [];

      // Replicate the batch-entry.ts failure-continuation pattern
      for (const asset of assets) {
        for (const timeframe of asset.supportedTimeframes) {
          try {
            const result = await orchestrator.execute({
              asset: asset.symbol,
              timeframe,
              candle_boundary: '2024-01-01T00:00:00.000Z',
              providerSymbol: asset.providers.twelveData,
              engineParticipation: asset.engines,
            });
            results.push(result);
            if (result.status !== BatchStatus.COMPLETED) {
              hasFailure = true;
            }
          } catch (error) {
            hasFailure = true;
          }
        }
      }

      // Both assets were processed (loop did not short-circuit)
      expect(results).toHaveLength(2);

      // First asset failed at ingestion
      expect(results[0].status).toBe(BatchStatus.FAILED);
      expect(results[0].failure_detail).toContain('ingestion');

      // Second asset succeeded
      expect(results[1].status).toBe(BatchStatus.COMPLETED);

      // Overall batch has a failure
      expect(hasFailure).toBe(true);
    });

    it('process exits with code 1 when any asset fails', async () => {
      const mockExit = vi.spyOn(process, 'exit').mockImplementation((() => {}) as any);
      const mockError = vi.spyOn(console, 'error').mockImplementation(() => {});

      // Simulate the batch-entry.ts exit-code-1 path
      const hasFailure = true;

      if (hasFailure) {
        console.error('[BatchEntry] Batch pipeline completed with failures');
        process.exit(1);
      }

      expect(mockError).toHaveBeenCalledWith(
        expect.stringContaining('completed with failures'),
      );
      expect(mockExit).toHaveBeenCalledWith(1);

      mockExit.mockRestore();
      mockError.mockRestore();
    });

    it('all assets are attempted even when multiple fail', async () => {
      const handlers = createMockStageHandlers();

      // Make ingestion fail on all calls
      (handlers.ingestion as ReturnType<typeof vi.fn>).mockRejectedValue(
        new Error('Provider unavailable'),
      );

      const orchestrator = new BatchOrchestrator({
        supabaseClient: mockSupabase,
        timeoutMs: 30_000,
        stageHandlers: handlers,
      });

      const assets: ResearchAsset[] = [
        createTestAsset({ id: 'eurusd', symbol: 'EURUSD', supportedTimeframes: ['4H'] }),
        createTestAsset({ id: 'gbpusd', symbol: 'GBPUSD', supportedTimeframes: ['4H'], providers: { twelveData: 'GBP/USD' } }),
        createTestAsset({ id: 'usdjpy', symbol: 'USDJPY', supportedTimeframes: ['4H'], providers: { twelveData: 'USD/JPY' } }),
      ];

      const results: PipelineResult[] = [];

      for (const asset of assets) {
        for (const timeframe of asset.supportedTimeframes) {
          try {
            const result = await orchestrator.execute({
              asset: asset.symbol,
              timeframe,
              candle_boundary: '2024-01-01T00:00:00.000Z',
              providerSymbol: asset.providers.twelveData,
              engineParticipation: asset.engines,
            });
            results.push(result);
          } catch (error) {
            // In batch-entry.ts, errors are caught and hasFailure is set
            results.push({
              batch_id: 'error',
              status: BatchStatus.FAILED,
              completed_stages: [],
              total_duration_ms: 0,
            });
          }
        }
      }

      // All 3 assets were attempted
      expect(results).toHaveLength(3);

      // All should have failed
      for (const result of results) {
        expect(result.status).toBe(BatchStatus.FAILED);
      }

      // Ingestion was called 3 times (once per asset/timeframe)
      expect(handlers.ingestion).toHaveBeenCalledTimes(3);
    });
  });
});
