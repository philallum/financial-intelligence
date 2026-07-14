/**
 * Property-Based Tests for DiagnosticsCollector
 *
 * Property 1: Diagnostics shape completeness
 * Property 2: Fire-and-forget guarantee
 *
 * Uses Vitest + fast-check to verify universal invariants across randomly
 * generated inputs matching each stage's interface.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fc from 'fast-check';
import { DiagnosticsCollector } from '../../../src/services/observability/diagnostics-collector.js';

// =============================================================================
// Arbitraries for each diagnostics stage interface
// =============================================================================

/** SentimentDiagnostics arbitrary */
const sentimentArb = fc.record({
  article_count: fc.nat(),
  window_hours: fc.double({ noNaN: true, noDefaultInfinity: true, min: 0 }),
  sentiment_vector: fc.tuple(
    fc.double({ noNaN: true, noDefaultInfinity: true }),
    fc.double({ noNaN: true, noDefaultInfinity: true }),
    fc.double({ noNaN: true, noDefaultInfinity: true }),
    fc.double({ noNaN: true, noDefaultInfinity: true }),
    fc.double({ noNaN: true, noDefaultInfinity: true }),
    fc.double({ noNaN: true, noDefaultInfinity: true }),
  ),
  sentiment_score: fc.double({ noNaN: true, noDefaultInfinity: true }),
  confidence_factor: fc.double({ noNaN: true, noDefaultInfinity: true, min: 0, max: 1 }),
});

/** MacroContextDiagnostics arbitrary */
const macroContextArb = fc.record({
  event_count: fc.nat(),
  macro_vector: fc.tuple(
    fc.double({ noNaN: true, noDefaultInfinity: true }),
    fc.double({ noNaN: true, noDefaultInfinity: true }),
    fc.double({ noNaN: true, noDefaultInfinity: true }),
    fc.double({ noNaN: true, noDefaultInfinity: true }),
    fc.double({ noNaN: true, noDefaultInfinity: true }),
    fc.double({ noNaN: true, noDefaultInfinity: true }),
    fc.double({ noNaN: true, noDefaultInfinity: true }),
    fc.double({ noNaN: true, noDefaultInfinity: true }),
  ),
  macro_state: fc.string({ minLength: 1, maxLength: 50 }),
});

/** ML response probabilities arbitrary */
const mlResponseArb = fc.record({
  up: fc.double({ noNaN: true, noDefaultInfinity: true, min: 0, max: 1 }),
  down: fc.double({ noNaN: true, noDefaultInfinity: true, min: 0, max: 1 }),
  flat: fc.double({ noNaN: true, noDefaultInfinity: true, min: 0, max: 1 }),
});

/** MLServiceDiagnostics arbitrary */
const mlServiceArb = fc.record({
  called: fc.boolean(),
  response: fc.option(mlResponseArb, { nil: null }),
  latency_ms: fc.option(fc.double({ noNaN: true, noDefaultInfinity: true, min: 0 }), { nil: null }),
});

/** MarketContextDiagnostics arbitrary */
const marketContextArb = fc.record({
  available: fc.boolean(),
  dxy: fc.option(fc.double({ noNaN: true, noDefaultInfinity: true }), { nil: null }),
  vix: fc.option(fc.double({ noNaN: true, noDefaultInfinity: true }), { nil: null }),
  spx: fc.option(fc.double({ noNaN: true, noDefaultInfinity: true }), { nil: null }),
});

/** SimilarityDiagnostics arbitrary */
const similarityArb = fc.record({
  match_count: fc.nat(),
  session_bonus_count: fc.nat(),
  regime_bonus_count: fc.nat(),
});

/** OutcomeDiagnostics arbitrary */
const outcomeArb = fc.record({
  dynamic_flat_threshold: fc.double({ noNaN: true, noDefaultInfinity: true, min: 0 }),
  weighted_return_count: fc.nat(),
});

/** ForecastDiagnostics arbitrary */
const forecastArb = fc.record({
  similarity_only: mlResponseArb,
  ensemble: mlResponseArb,
  alpha_weight: fc.double({ noNaN: true, noDefaultInfinity: true, min: 0, max: 1 }),
});

/** GeminiDiagnostics arbitrary */
const geminiArb = fc.record({
  scored_article_count: fc.nat(),
});

// =============================================================================
// Helpers
// =============================================================================

function createMockSupabase() {
  const mockUpsert = vi.fn().mockResolvedValue({ error: null });
  const mockFrom = vi.fn().mockReturnValue({ upsert: mockUpsert });
  return { from: mockFrom, _mockUpsert: mockUpsert };
}

// =============================================================================
// Property 1: Diagnostics Shape Completeness
// =============================================================================

describe('Property 1: Diagnostics shape completeness', () => {
  /**
   * **Validates: Requirements 1.1, 1.2, 1.3, 1.4, 1.5, 1.6, 1.7, 1.8, 1.9**
   *
   * For any valid stage output recorded into the DiagnosticsCollector,
   * the built payload SHALL contain an entry for that stage with all fields
   * matching the expected interface types.
   */

  let consoleWarnSpy: ReturnType<typeof vi.spyOn>;
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    consoleWarnSpy.mockRestore();
    consoleErrorSpy.mockRestore();
  });

  it('payload contains all 8 keys with correctly-typed values after recording all stages', async () => {
    await fc.assert(
      fc.asyncProperty(
        sentimentArb,
        macroContextArb,
        mlServiceArb,
        marketContextArb,
        similarityArb,
        outcomeArb,
        forecastArb,
        geminiArb,
        async (sentiment, macroContext, mlService, marketContext, similarity, outcome, forecast, gemini) => {
          const mockSupabase = createMockSupabase();
          const collector = new DiagnosticsCollector('TEST-ASSET', 'batch-123', mockSupabase as any);

          // Record all stages
          collector.recordSentiment(sentiment);
          collector.recordMacroContext(macroContext);
          collector.recordMLService(mlService);
          collector.recordMarketContext(marketContext);
          collector.recordSimilarity(similarity);
          collector.recordOutcome(outcome);
          collector.recordForecast(forecast);
          collector.recordGemini(gemini);

          // Persist to capture the payload via the spy
          await collector.persist();

          expect(mockSupabase._mockUpsert).toHaveBeenCalledTimes(1);
          const upsertArgs = mockSupabase._mockUpsert.mock.calls[0];
          const row = upsertArgs[0];
          const payload = row.diagnostics;

          // Verify all 8 keys exist
          expect(payload).toHaveProperty('sentiment');
          expect(payload).toHaveProperty('macro_context');
          expect(payload).toHaveProperty('ml_service');
          expect(payload).toHaveProperty('market_context');
          expect(payload).toHaveProperty('similarity');
          expect(payload).toHaveProperty('outcome');
          expect(payload).toHaveProperty('forecast');
          expect(payload).toHaveProperty('gemini');

          // Verify sentiment shape (Req 1.2)
          expect(typeof payload.sentiment.article_count).toBe('number');
          expect(Number.isInteger(payload.sentiment.article_count)).toBe(true);
          expect(typeof payload.sentiment.window_hours).toBe('number');
          expect(Array.isArray(payload.sentiment.sentiment_vector)).toBe(true);
          expect(payload.sentiment.sentiment_vector).toHaveLength(6);
          payload.sentiment.sentiment_vector.forEach((v: number) => expect(typeof v).toBe('number'));
          expect(typeof payload.sentiment.sentiment_score).toBe('number');
          expect(typeof payload.sentiment.confidence_factor).toBe('number');

          // Verify macro_context shape (Req 1.3)
          expect(typeof payload.macro_context.event_count).toBe('number');
          expect(Number.isInteger(payload.macro_context.event_count)).toBe(true);
          expect(Array.isArray(payload.macro_context.macro_vector)).toBe(true);
          expect(payload.macro_context.macro_vector).toHaveLength(8);
          payload.macro_context.macro_vector.forEach((v: number) => expect(typeof v).toBe('number'));
          expect(typeof payload.macro_context.macro_state).toBe('string');

          // Verify ml_service shape (Req 1.4)
          expect(typeof payload.ml_service.called).toBe('boolean');
          if (payload.ml_service.response !== null) {
            expect(typeof payload.ml_service.response.up).toBe('number');
            expect(typeof payload.ml_service.response.down).toBe('number');
            expect(typeof payload.ml_service.response.flat).toBe('number');
          }
          if (payload.ml_service.latency_ms !== null) {
            expect(typeof payload.ml_service.latency_ms).toBe('number');
          }

          // Verify market_context shape (Req 1.5)
          expect(typeof payload.market_context.available).toBe('boolean');
          if (payload.market_context.dxy !== null) {
            expect(typeof payload.market_context.dxy).toBe('number');
          }
          if (payload.market_context.vix !== null) {
            expect(typeof payload.market_context.vix).toBe('number');
          }
          if (payload.market_context.spx !== null) {
            expect(typeof payload.market_context.spx).toBe('number');
          }

          // Verify similarity shape (Req 1.6)
          expect(typeof payload.similarity.match_count).toBe('number');
          expect(Number.isInteger(payload.similarity.match_count)).toBe(true);
          expect(typeof payload.similarity.session_bonus_count).toBe('number');
          expect(Number.isInteger(payload.similarity.session_bonus_count)).toBe(true);
          expect(typeof payload.similarity.regime_bonus_count).toBe('number');
          expect(Number.isInteger(payload.similarity.regime_bonus_count)).toBe(true);

          // Verify outcome shape (Req 1.7)
          expect(typeof payload.outcome.dynamic_flat_threshold).toBe('number');
          expect(typeof payload.outcome.weighted_return_count).toBe('number');
          expect(Number.isInteger(payload.outcome.weighted_return_count)).toBe(true);

          // Verify forecast shape (Req 1.8)
          expect(typeof payload.forecast.similarity_only.up).toBe('number');
          expect(typeof payload.forecast.similarity_only.down).toBe('number');
          expect(typeof payload.forecast.similarity_only.flat).toBe('number');
          expect(typeof payload.forecast.ensemble.up).toBe('number');
          expect(typeof payload.forecast.ensemble.down).toBe('number');
          expect(typeof payload.forecast.ensemble.flat).toBe('number');
          expect(typeof payload.forecast.alpha_weight).toBe('number');

          // Verify gemini shape (Req 1.9)
          expect(typeof payload.gemini.scored_article_count).toBe('number');
          expect(Number.isInteger(payload.gemini.scored_article_count)).toBe(true);
        },
      ),
      { numRuns: 200 },
    );
  });

  it('payload values match the exact data recorded for each stage', async () => {
    await fc.assert(
      fc.asyncProperty(
        sentimentArb,
        macroContextArb,
        mlServiceArb,
        marketContextArb,
        similarityArb,
        outcomeArb,
        forecastArb,
        geminiArb,
        async (sentiment, macroContext, mlService, marketContext, similarity, outcome, forecast, gemini) => {
          const mockSupabase = createMockSupabase();
          const collector = new DiagnosticsCollector('ASSET-X', 'batch-456', mockSupabase as any);

          collector.recordSentiment(sentiment);
          collector.recordMacroContext(macroContext);
          collector.recordMLService(mlService);
          collector.recordMarketContext(marketContext);
          collector.recordSimilarity(similarity);
          collector.recordOutcome(outcome);
          collector.recordForecast(forecast);
          collector.recordGemini(gemini);

          await collector.persist();

          const row = mockSupabase._mockUpsert.mock.calls[0][0];
          const payload = row.diagnostics;

          // Each stage's payload equals the recorded data exactly
          expect(payload.sentiment).toEqual(sentiment);
          expect(payload.macro_context).toEqual(macroContext);
          expect(payload.ml_service).toEqual(mlService);
          expect(payload.market_context).toEqual(marketContext);
          expect(payload.similarity).toEqual(similarity);
          expect(payload.outcome).toEqual(outcome);
          expect(payload.forecast).toEqual(forecast);
          expect(payload.gemini).toEqual(gemini);
        },
      ),
      { numRuns: 200 },
    );
  });

  it('payload contains all 8 keys even when stages are recorded in any order', async () => {
    // Permutation-based test: record stages in random order, payload always has all keys
    const stageRecorders = fc.shuffledSubarray(
      ['sentiment', 'macroContext', 'mlService', 'marketContext', 'similarity', 'outcome', 'forecast', 'gemini'] as const,
      { minLength: 8, maxLength: 8 },
    );

    await fc.assert(
      fc.asyncProperty(
        stageRecorders,
        sentimentArb,
        macroContextArb,
        mlServiceArb,
        marketContextArb,
        similarityArb,
        outcomeArb,
        forecastArb,
        geminiArb,
        async (order, sentiment, macroContext, mlService, marketContext, similarity, outcome, forecast, gemini) => {
          const mockSupabase = createMockSupabase();
          const collector = new DiagnosticsCollector('PERM-ASSET', 'batch-perm', mockSupabase as any);

          const recorders: Record<string, () => void> = {
            sentiment: () => collector.recordSentiment(sentiment),
            macroContext: () => collector.recordMacroContext(macroContext),
            mlService: () => collector.recordMLService(mlService),
            marketContext: () => collector.recordMarketContext(marketContext),
            similarity: () => collector.recordSimilarity(similarity),
            outcome: () => collector.recordOutcome(outcome),
            forecast: () => collector.recordForecast(forecast),
            gemini: () => collector.recordGemini(gemini),
          };

          // Record in the randomly shuffled order
          for (const stage of order) {
            recorders[stage]();
          }

          await collector.persist();

          const row = mockSupabase._mockUpsert.mock.calls[0][0];
          const payload = row.diagnostics;

          // All 8 keys must be present regardless of recording order
          const expectedKeys = ['sentiment', 'macro_context', 'ml_service', 'market_context', 'similarity', 'outcome', 'forecast', 'gemini'];
          for (const key of expectedKeys) {
            expect(payload).toHaveProperty(key);
            expect(payload[key]).not.toBeUndefined();
          }
        },
      ),
      { numRuns: 100 },
    );
  });
});

// =============================================================================
// Property 2: Fire-and-forget guarantee
// =============================================================================

describe('Property 2: Fire-and-forget guarantee', () => {
  /**
   * **Validates: Requirements 2.1, 2.2**
   *
   * For any error thrown during any record*() or persist() operation,
   * the DiagnosticsCollector SHALL catch the error and never propagate it.
   */

  let consoleWarnSpy: ReturnType<typeof vi.spyOn>;
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    consoleWarnSpy.mockRestore();
    consoleErrorSpy.mockRestore();
  });

  it('persist() never throws even when Supabase rejects or throws', async () => {
    const errorArb = fc.oneof(
      fc.string({ minLength: 1, maxLength: 100 }).map(msg => ({ error: { message: msg } })),
      fc.string({ minLength: 1, maxLength: 100 }).map(msg => new Error(msg)),
    );

    await fc.assert(
      fc.asyncProperty(
        fc.string({ minLength: 1, maxLength: 10 }),
        fc.uuid(),
        errorArb,
        async (asset, batchId, errorCase) => {
          let mockSupabase: any;

          if (errorCase instanceof Error) {
            // Supabase throws an exception
            const mockUpsert = vi.fn().mockRejectedValue(errorCase);
            mockSupabase = { from: vi.fn().mockReturnValue({ upsert: mockUpsert }) };
          } else {
            // Supabase returns an error object
            const mockUpsert = vi.fn().mockResolvedValue(errorCase);
            mockSupabase = { from: vi.fn().mockReturnValue({ upsert: mockUpsert }) };
          }

          const collector = new DiagnosticsCollector(asset, batchId, mockSupabase);

          // Should never throw
          await expect(collector.persist()).resolves.toBeUndefined();
        },
      ),
      { numRuns: 200 },
    );
  });

  it('record*() methods never throw regardless of input', () => {
    fc.assert(
      fc.property(
        sentimentArb,
        macroContextArb,
        mlServiceArb,
        marketContextArb,
        similarityArb,
        outcomeArb,
        forecastArb,
        geminiArb,
        (sentiment, macroContext, mlService, marketContext, similarity, outcome, forecast, gemini) => {
          const mockSupabase = createMockSupabase();
          const collector = new DiagnosticsCollector('TEST', 'batch', mockSupabase as any);

          // None of these should throw
          expect(() => collector.recordSentiment(sentiment)).not.toThrow();
          expect(() => collector.recordMacroContext(macroContext)).not.toThrow();
          expect(() => collector.recordMLService(mlService)).not.toThrow();
          expect(() => collector.recordMarketContext(marketContext)).not.toThrow();
          expect(() => collector.recordSimilarity(similarity)).not.toThrow();
          expect(() => collector.recordOutcome(outcome)).not.toThrow();
          expect(() => collector.recordForecast(forecast)).not.toThrow();
          expect(() => collector.recordGemini(gemini)).not.toThrow();
        },
      ),
      { numRuns: 200 },
    );
  });
});
