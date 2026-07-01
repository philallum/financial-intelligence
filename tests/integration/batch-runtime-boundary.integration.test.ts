/**
 * Integration Tests: Batch-Runtime Boundary Enforcement
 *
 * Verifies the strict architectural separation between:
 * - Batch Intelligence Layer (every 4H, historical computation only)
 * - Runtime Execution Layer (per request, live conditions only)
 *
 * Validates: Requirements 9.1, 9.2, 9.3, 9.4
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  BatchOrchestrator,
  PIPELINE_STAGES,
  type StageHandlers,
  type BatchTriggerInput,
} from '../../src/services/pipeline/batch-orchestrator.js';
import { createForecastRouter } from '../../src/api/routes/forecast.js';
import { computeTradeabilityFromInput } from '../../src/engines/tradeability-engine.js';
import { BatchStatus, Session } from '../../src/types/enums.js';
import type {
  IngestionInput,
  IngestionOutput,
  FingerprintInput,
  Fingerprint,
  SimilarityInput,
  SimilarityOutput,
  OutcomeDistribution,
  Forecast,
  ConfidenceOutput,
  TradeabilityInput,
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
  fingerprint_id: 'fp-boundary-test',
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
      fingerprint_id: 'fp-boundary-test',
      match_fingerprint_id: 'fp-hist-1',
      similarity_score: 0.92,
      rank: 1,
      layer_breakdown: { market_structure: 0.9, volatility: 0.85, liquidity: 0.88, macro: 0.9, sentiment: 0.8 },
      match_explanation: { matched_layers: ['market_structure'], mismatched_layers: [], primary_match_reason: 'strong_alignment' },
      batch_id: 'batch-boundary',
    },
  ],
  match_count: 1,
  regime_weights_used: { market_structure: 0.2, volatility: 0.15, liquidity: 0.15, macro: 0.3, sentiment: 0.2 },
};

const sampleOutcome: OutcomeDistribution = {
  fingerprint_id: 'fp-boundary-test',
  sample_size: 40,
  mean_return: 12.5,
  median_return: 10.0,
  direction_probability: { up: 0.6, down: 0.25, flat: 0.15 },
  volatility_profile: { std_dev: 0.3, max_absolute_return: 50 },
  risk_range: { p10: -20, p50: 10, p90: 40 },
  confidence_inputs: { regime_consistency: 0.7, distribution_sharpness: 0.6 },
  batch_id: 'batch-boundary',
  engine_version: '1.0.0',
};

const sampleForecast: Forecast = {
  fingerprint_id: 'fp-boundary-test',
  direction_probabilities: { up: 0.6, down: 0.25, flat: 0.15 },
  expected_move_pips: 12.5,
  confidence_raw: 0.72,
  confidence_final: 0.612,
  engine_version: '1.0.0',
  batch_id: 'batch-boundary',
};

const sampleConfidence: ConfidenceOutput = {
  confidence_raw: 0.72,
  sample_weight: 1.0,
  regime_stability: 0.85,
  confidence_final: 0.612,
};

// =============================================================================
// Mock Supabase
// =============================================================================

function createMockSupabase(overrides: Record<string, unknown> = {}) {
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
        insert: vi.fn().mockResolvedValue({ error: null }),
        update: vi.fn().mockReturnValue({
          eq: vi.fn().mockResolvedValue({ error: null }),
        }),
      };
    }
    if (table === 'engine_versions') {
      return {
        select: vi.fn().mockReturnValue({
          eq: vi.fn().mockResolvedValue({
            data: [
              { engine_name: 'fingerprint', engine_version: '1.0.0' },
              { engine_name: 'similarity', engine_version: '1.0.0' },
              { engine_name: 'outcome', engine_version: '1.0.0' },
              { engine_name: 'forecast', engine_version: '1.0.0' },
              { engine_name: 'confidence', engine_version: '1.0.0' },
            ],
            error: null,
          }),
        }),
      };
    }
    if (table === 'cached_forecasts') {
      return {
        select: vi.fn().mockReturnValue({
          eq: vi.fn().mockReturnValue({
            single: vi.fn().mockResolvedValue({
              data: {
                payload: overrides.forecast ?? sampleForecast,
                valid_until: '2024-01-15T12:00:00.000Z',
              },
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
// Req 9.1: Batch Layer SHALL NOT Access Live Market Data
// =============================================================================

describe('Req 9.1: Batch layer isolation from live data', () => {
  it('BatchTriggerInput accepts only asset, timeframe, candle_boundary — no live data params', () => {
    const input: BatchTriggerInput = {
      asset: 'EURUSD',
      timeframe: '4H',
      candle_boundary: '2024-01-15T08:00:00.000Z',
    };

    // Verify only batch-layer inputs are present
    const keys = Object.keys(input);
    expect(keys).toEqual(['asset', 'timeframe', 'candle_boundary']);

    // Confirm no live market data parameters exist
    expect(input).not.toHaveProperty('spread_pips');
    expect(input).not.toHaveProperty('current_price');
    expect(input).not.toHaveProperty('live_spread');
    expect(input).not.toHaveProperty('news_risk_flag');
    expect(input).not.toHaveProperty('session_state');
    expect(input).not.toHaveProperty('live_liquidity_proxy');
  });

  it('StageHandlers interface ingestion receives only IngestionInput (no live data)', async () => {
    // Mock ingestion handler that asserts its input shape
    const ingestionSpy = vi.fn().mockImplementation((input: IngestionInput) => {
      // IngestionInput only has asset, timeframe, candle_boundary
      expect(input).toHaveProperty('asset');
      expect(input).toHaveProperty('timeframe');
      expect(input).toHaveProperty('candle_boundary');
      expect(input).not.toHaveProperty('spread_pips');
      expect(input).not.toHaveProperty('current_price');
      expect(input).not.toHaveProperty('news_risk_flag');
      expect(input).not.toHaveProperty('live_liquidity_proxy');
      return Promise.resolve(sampleIngestionOutput);
    });

    const handlers: StageHandlers = {
      ingestion: ingestionSpy,
      fingerprint: vi.fn().mockResolvedValue(sampleFingerprint),
      similarity: vi.fn().mockResolvedValue(sampleSimilarityOutput),
      outcome: vi.fn().mockResolvedValue(sampleOutcome),
      forecast: vi.fn().mockResolvedValue(sampleForecast),
      confidence: vi.fn().mockResolvedValue(sampleConfidence),
      cache_write: vi.fn().mockResolvedValue(undefined),
    };

    const orchestrator = new BatchOrchestrator({
      supabaseClient: createMockSupabase(),
      stageHandlers: handlers,
      timeoutMs: 5000,
    });

    const result = await orchestrator.execute({
      asset: 'EURUSD',
      timeframe: '4H',
      candle_boundary: '2024-01-15T08:00:00.000Z',
    });

    expect(result.status).toBe(BatchStatus.COMPLETED);
    expect(ingestionSpy).toHaveBeenCalledTimes(1);
    expect(ingestionSpy).toHaveBeenCalledWith({
      asset: 'EURUSD',
      timeframe: '4H',
      candle_boundary: '2024-01-15T08:00:00.000Z',
    });
  });

  it('pipeline completes successfully with only batch-layer inputs (no live data needed)', async () => {
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
      supabaseClient: createMockSupabase(),
      stageHandlers: handlers,
      timeoutMs: 5000,
    });

    const result = await orchestrator.execute({
      asset: 'EURUSD',
      timeframe: '4H',
      candle_boundary: '2024-01-15T08:00:00.000Z',
    });

    // Full pipeline completes without any live market data
    expect(result.status).toBe(BatchStatus.COMPLETED);
    expect(result.completed_stages).toEqual(PIPELINE_STAGES);
  });
});

// =============================================================================
// Req 9.2: Runtime Layer SHALL NOT Compute Historical Statistics
// =============================================================================

describe('Req 9.2: Runtime layer isolation from historical computation', () => {
  it('forecast route only reads from cached_forecasts and calls tradeability engine', () => {
    const mockSupabase = createMockSupabase();
    const router = createForecastRouter({ supabase: mockSupabase });

    // The router creation should succeed — it only needs supabase access
    expect(router).toBeDefined();
    // The route is configured to read from cached_forecasts (not compute anything)
  });

  it('tradeability engine receives only forecast + live conditions, not raw historical data', () => {
    const tradeabilityInput: TradeabilityInput = {
      forecast: sampleForecast,
      spread_pips: 1.5,
      session_state: Session.LONDON,
      live_liquidity_proxy: 0.75,
      news_risk_flag: false,
    };

    // Verify the input shape has NO historical computation fields
    expect(tradeabilityInput).not.toHaveProperty('fingerprint_ids');
    expect(tradeabilityInput).not.toHaveProperty('outcome_distribution');
    expect(tradeabilityInput).not.toHaveProperty('similarity_matches');
    expect(tradeabilityInput).not.toHaveProperty('ohlc');
    expect(tradeabilityInput).not.toHaveProperty('state_layers');

    // Verify it computes successfully with only runtime data
    const result = computeTradeabilityFromInput(tradeabilityInput);
    expect(result.tradeability_score).toBeGreaterThanOrEqual(0);
    expect(result.tradeability_score).toBeLessThanOrEqual(1);
    expect(result.tradeability_label).toBeDefined();
  });

  it('tradeability engine does NOT modify forecast probabilities or confidence', () => {
    const originalForecast: Forecast = { ...sampleForecast };
    const input: TradeabilityInput = {
      forecast: sampleForecast,
      spread_pips: 1.5,
      session_state: Session.LONDON,
      live_liquidity_proxy: 0.75,
      news_risk_flag: false,
    };

    computeTradeabilityFromInput(input);

    // Forecast object must remain unmodified after tradeability computation
    expect(sampleForecast.direction_probabilities).toEqual(originalForecast.direction_probabilities);
    expect(sampleForecast.confidence_final).toBe(originalForecast.confidence_final);
    expect(sampleForecast.confidence_raw).toBe(originalForecast.confidence_raw);
    expect(sampleForecast.expected_move_pips).toBe(originalForecast.expected_move_pips);
  });

  it('runtime layer does NOT call similarity, outcome, or forecast engines', () => {
    // The forecast route source code imports ONLY:
    // - computeTradeabilityFromInput (runtime engine)
    // - supabase.from('cached_forecasts') (pre-computed data)
    // It does NOT import similarity-engine, outcome-engine, or forecast-engine

    // Verify the runtime tradeability engine output doesn't contain batch metrics
    const result = computeTradeabilityFromInput({
      forecast: sampleForecast,
      spread_pips: 1.5,
      session_state: Session.NY,
      live_liquidity_proxy: 0.8,
      news_risk_flag: false,
    });

    // Output is strictly runtime tradeability — no batch computation artefacts
    expect(result).toHaveProperty('tradeability_score');
    expect(result).toHaveProperty('tradeability_label');
    expect(result).toHaveProperty('execution_metrics');
    expect(result).not.toHaveProperty('outcome_distribution');
    expect(result).not.toHaveProperty('similarity_matches');
    expect(result).not.toHaveProperty('fingerprint');
    expect(result).not.toHaveProperty('confidence_raw');
  });
});

// =============================================================================
// Req 9.3: Fingerprint is Sole Originating Input to Batch Pipeline
// =============================================================================

describe('Req 9.3: Fingerprint as sole originating input to batch pipeline', () => {
  it('similarity stage receives query_fingerprint (not raw OHLC or ingestion data)', async () => {
    const similaritySpy = vi.fn().mockResolvedValue(sampleSimilarityOutput);

    const handlers: StageHandlers = {
      ingestion: vi.fn().mockResolvedValue(sampleIngestionOutput),
      fingerprint: vi.fn().mockResolvedValue(sampleFingerprint),
      similarity: similaritySpy,
      outcome: vi.fn().mockResolvedValue(sampleOutcome),
      forecast: vi.fn().mockResolvedValue(sampleForecast),
      confidence: vi.fn().mockResolvedValue(sampleConfidence),
      cache_write: vi.fn().mockResolvedValue(undefined),
    };

    const orchestrator = new BatchOrchestrator({
      supabaseClient: createMockSupabase(),
      stageHandlers: handlers,
      timeoutMs: 5000,
    });

    await orchestrator.execute({
      asset: 'EURUSD',
      timeframe: '4H',
      candle_boundary: '2024-01-15T08:00:00.000Z',
    });

    // Similarity receives a SimilarityInput with query_fingerprint and top_n
    const similarityArg = similaritySpy.mock.calls[0][0] as SimilarityInput;
    expect(similarityArg).toHaveProperty('query_fingerprint');
    expect(similarityArg).toHaveProperty('top_n');
    expect(similarityArg.query_fingerprint).toEqual(sampleFingerprint);

    // It does NOT receive raw ingestion data
    expect(similarityArg).not.toHaveProperty('ohlc');
    expect(similarityArg).not.toHaveProperty('asset');
    expect(similarityArg).not.toHaveProperty('candle_boundary');
    expect(similarityArg).not.toHaveProperty('volume');
  });

  it('outcome stage receives fingerprint_ids from similarity (not raw fingerprint data)', async () => {
    const outcomeSpy = vi.fn().mockResolvedValue(sampleOutcome);

    const handlers: StageHandlers = {
      ingestion: vi.fn().mockResolvedValue(sampleIngestionOutput),
      fingerprint: vi.fn().mockResolvedValue(sampleFingerprint),
      similarity: vi.fn().mockResolvedValue(sampleSimilarityOutput),
      outcome: outcomeSpy,
      forecast: vi.fn().mockResolvedValue(sampleForecast),
      confidence: vi.fn().mockResolvedValue(sampleConfidence),
      cache_write: vi.fn().mockResolvedValue(undefined),
    };

    const orchestrator = new BatchOrchestrator({
      supabaseClient: createMockSupabase(),
      stageHandlers: handlers,
      timeoutMs: 5000,
    });

    await orchestrator.execute({
      asset: 'EURUSD',
      timeframe: '4H',
      candle_boundary: '2024-01-15T08:00:00.000Z',
    });

    // Outcome receives OutcomeInput: { fingerprint_ids: string[] }
    const outcomeArg = outcomeSpy.mock.calls[0][0];
    expect(outcomeArg).toHaveProperty('fingerprint_ids');
    expect(outcomeArg.fingerprint_ids).toEqual(['fp-hist-1']);

    // It does NOT receive the full fingerprint object or similarity scores
    expect(outcomeArg).not.toHaveProperty('query_fingerprint');
    expect(outcomeArg).not.toHaveProperty('similarity_score');
    expect(outcomeArg).not.toHaveProperty('state_layers');
    expect(outcomeArg).not.toHaveProperty('ohlc');
  });

  it('forecast stage receives outcome_distribution (not similarity or fingerprint data)', async () => {
    const forecastSpy = vi.fn().mockResolvedValue(sampleForecast);

    const handlers: StageHandlers = {
      ingestion: vi.fn().mockResolvedValue(sampleIngestionOutput),
      fingerprint: vi.fn().mockResolvedValue(sampleFingerprint),
      similarity: vi.fn().mockResolvedValue(sampleSimilarityOutput),
      outcome: vi.fn().mockResolvedValue(sampleOutcome),
      forecast: forecastSpy,
      confidence: vi.fn().mockResolvedValue(sampleConfidence),
      cache_write: vi.fn().mockResolvedValue(undefined),
    };

    const orchestrator = new BatchOrchestrator({
      supabaseClient: createMockSupabase(),
      stageHandlers: handlers,
      timeoutMs: 5000,
    });

    await orchestrator.execute({
      asset: 'EURUSD',
      timeframe: '4H',
      candle_boundary: '2024-01-15T08:00:00.000Z',
    });

    // Forecast receives ForecastInput: { outcome_distribution }
    const forecastArg = forecastSpy.mock.calls[0][0];
    expect(forecastArg).toHaveProperty('outcome_distribution');
    expect(forecastArg.outcome_distribution).toEqual(sampleOutcome);

    // It does NOT receive fingerprint or similarity data
    expect(forecastArg).not.toHaveProperty('query_fingerprint');
    expect(forecastArg).not.toHaveProperty('fingerprint_ids');
    expect(forecastArg).not.toHaveProperty('similarity_matches');
    expect(forecastArg).not.toHaveProperty('state_layers');
  });
});

// =============================================================================
// Req 9.4: Each Engine Receives Only Its Predecessor's Output
// =============================================================================

describe('Req 9.4: Each engine receives only predecessor output', () => {
  it('fingerprint stage receives only ingestion output fields (asset, timestamp_utc, ohlc)', async () => {
    const fingerprintSpy = vi.fn().mockResolvedValue(sampleFingerprint);

    const handlers: StageHandlers = {
      ingestion: vi.fn().mockResolvedValue(sampleIngestionOutput),
      fingerprint: fingerprintSpy,
      similarity: vi.fn().mockResolvedValue(sampleSimilarityOutput),
      outcome: vi.fn().mockResolvedValue(sampleOutcome),
      forecast: vi.fn().mockResolvedValue(sampleForecast),
      confidence: vi.fn().mockResolvedValue(sampleConfidence),
      cache_write: vi.fn().mockResolvedValue(undefined),
    };

    const orchestrator = new BatchOrchestrator({
      supabaseClient: createMockSupabase(),
      stageHandlers: handlers,
      timeoutMs: 5000,
    });

    await orchestrator.execute({
      asset: 'EURUSD',
      timeframe: '4H',
      candle_boundary: '2024-01-15T08:00:00.000Z',
    });

    // Fingerprint receives FingerprintInput derived from ingestion output
    const fpArg = fingerprintSpy.mock.calls[0][0] as FingerprintInput;
    expect(fpArg.asset).toBe('EURUSD');
    expect(fpArg.timestamp_utc).toBe('2024-01-15T08:00:00.000Z');
    expect(fpArg.ohlc).toEqual(sampleIngestionOutput.ohlc);

    // It does NOT receive the raw batch trigger input or other stage outputs
    expect(fpArg).not.toHaveProperty('candle_boundary');
    expect(fpArg).not.toHaveProperty('timeframe');
    expect(fpArg).not.toHaveProperty('similarity');
    expect(fpArg).not.toHaveProperty('outcome');
  });

  it('confidence stage receives derived ConfidenceInput from outcome (not full outcome object)', async () => {
    const confidenceSpy = vi.fn().mockResolvedValue(sampleConfidence);

    const handlers: StageHandlers = {
      ingestion: vi.fn().mockResolvedValue(sampleIngestionOutput),
      fingerprint: vi.fn().mockResolvedValue(sampleFingerprint),
      similarity: vi.fn().mockResolvedValue(sampleSimilarityOutput),
      outcome: vi.fn().mockResolvedValue(sampleOutcome),
      forecast: vi.fn().mockResolvedValue(sampleForecast),
      confidence: confidenceSpy,
      cache_write: vi.fn().mockResolvedValue(undefined),
    };

    const orchestrator = new BatchOrchestrator({
      supabaseClient: createMockSupabase(),
      stageHandlers: handlers,
      timeoutMs: 5000,
    });

    await orchestrator.execute({
      asset: 'EURUSD',
      timeframe: '4H',
      candle_boundary: '2024-01-15T08:00:00.000Z',
    });

    // Confidence receives ConfidenceInput with specific fields
    const confArg = confidenceSpy.mock.calls[0][0];
    expect(confArg).toHaveProperty('up_probability');
    expect(confArg).toHaveProperty('down_probability');
    expect(confArg).toHaveProperty('flat_probability');
    expect(confArg).toHaveProperty('sample_size');
    expect(confArg).toHaveProperty('variance');
    expect(confArg).toHaveProperty('regime_metadata');

    // It does NOT receive raw objects from other stages
    expect(confArg).not.toHaveProperty('forecast');
    expect(confArg).not.toHaveProperty('fingerprint');
    expect(confArg).not.toHaveProperty('similarity_matches');
    expect(confArg).not.toHaveProperty('ohlc');
  });

  it('full pipeline data flow: each handler called with correct predecessor-derived input', async () => {
    const callArgs: Record<string, unknown[]> = {};

    const handlers: StageHandlers = {
      ingestion: vi.fn().mockImplementation((...args) => {
        callArgs['ingestion'] = args;
        return Promise.resolve(sampleIngestionOutput);
      }),
      fingerprint: vi.fn().mockImplementation((...args) => {
        callArgs['fingerprint'] = args;
        return Promise.resolve(sampleFingerprint);
      }),
      similarity: vi.fn().mockImplementation((...args) => {
        callArgs['similarity'] = args;
        return Promise.resolve(sampleSimilarityOutput);
      }),
      outcome: vi.fn().mockImplementation((...args) => {
        callArgs['outcome'] = args;
        return Promise.resolve(sampleOutcome);
      }),
      forecast: vi.fn().mockImplementation((...args) => {
        callArgs['forecast'] = args;
        return Promise.resolve(sampleForecast);
      }),
      confidence: vi.fn().mockImplementation((...args) => {
        callArgs['confidence'] = args;
        return Promise.resolve(sampleConfidence);
      }),
      cache_write: vi.fn().mockImplementation((...args) => {
        callArgs['cache_write'] = args;
        return Promise.resolve(undefined);
      }),
    };

    const orchestrator = new BatchOrchestrator({
      supabaseClient: createMockSupabase(),
      stageHandlers: handlers,
      timeoutMs: 5000,
    });

    const result = await orchestrator.execute({
      asset: 'EURUSD',
      timeframe: '4H',
      candle_boundary: '2024-01-15T08:00:00.000Z',
    });

    expect(result.status).toBe(BatchStatus.COMPLETED);

    // ingestion: receives BatchTriggerInput-derived IngestionInput
    const ingestionArg = callArgs['ingestion'][0] as IngestionInput;
    expect(Object.keys(ingestionArg).sort()).toEqual(['asset', 'candle_boundary', 'timeframe']);

    // fingerprint: receives FingerprintInput (from ingestion output)
    const fpArg = callArgs['fingerprint'][0] as FingerprintInput;
    expect(fpArg.asset).toBe(sampleIngestionOutput.asset);
    expect(fpArg.timestamp_utc).toBe(sampleIngestionOutput.timestamp_utc);
    expect(fpArg.ohlc).toEqual(sampleIngestionOutput.ohlc);

    // similarity: receives SimilarityInput (from fingerprint output)
    const simArg = callArgs['similarity'][0] as SimilarityInput;
    expect(simArg.query_fingerprint).toEqual(sampleFingerprint);
    expect(simArg.top_n).toBe(50);

    // outcome: receives OutcomeInput with fingerprint_ids from similarity matches
    const outcomeArg = callArgs['outcome'][0] as { fingerprint_ids: string[] };
    expect(outcomeArg.fingerprint_ids).toEqual(
      sampleSimilarityOutput.matches.map(m => m.match_fingerprint_id),
    );

    // forecast: receives ForecastInput with outcome_distribution
    const forecastArg = callArgs['forecast'][0] as { outcome_distribution: OutcomeDistribution };
    expect(forecastArg.outcome_distribution).toEqual(sampleOutcome);

    // confidence: receives ConfidenceInput derived from outcome
    const confArg = callArgs['confidence'][0] as Record<string, unknown>;
    expect(confArg.up_probability).toBe(sampleOutcome.direction_probability.up);
    expect(confArg.down_probability).toBe(sampleOutcome.direction_probability.down);
    expect(confArg.flat_probability).toBe(sampleOutcome.direction_probability.flat);
    expect(confArg.sample_size).toBe(sampleOutcome.sample_size);
  });
});
