/**
 * Property-Based Test: Duplicate Rejection Idempotence
 *
 * Property 11: Duplicate Rejection Idempotence
 * - Generate records, persist twice with same key
 * - Verify existing record unchanged after rejected write
 *
 * **Validates: Requirements 3.7, 9.6**
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fc from 'fast-check';
import { createResearchArchiveWriter } from '../../../src/research/persistence/research-archive-writer.js';
import type { ResearchForecastRecord } from '../../../src/research/persistence/types.js';

// =============================================================================
// Arbitraries
// =============================================================================

/** Generates a valid ISO-8601 UTC timestamp string. */
const arbIsoTimestamp: fc.Arbitrary<string> = fc.integer({
  min: new Date('2020-01-01T00:00:00Z').getTime(),
  max: new Date('2030-12-31T23:59:59Z').getTime(),
}).map(ms => new Date(ms).toISOString());

/** Generates a valid direction_probabilities object (sums to ~1.0). */
const arbDirectionProbabilities: fc.Arbitrary<{ up: number; down: number; flat: number }> = fc
  .tuple(
    fc.double({ min: 0, max: 1, noNaN: true, noDefaultInfinity: true }),
    fc.double({ min: 0, max: 1, noNaN: true, noDefaultInfinity: true }),
  )
  .map(([a, b]) => {
    const sorted = [a, b].sort((x, y) => x - y);
    return {
      up: sorted[0],
      down: sorted[1] - sorted[0],
      flat: 1 - sorted[1],
    };
  });

/** Generates a valid regime object. */
const arbRegime: fc.Arbitrary<{ volatility_regime: string; trend_regime: string; session: string }> = fc.record({
  volatility_regime: fc.constantFrom('low', 'normal', 'high', 'extreme'),
  trend_regime: fc.constantFrom('trending', 'ranging', 'breakout'),
  session: fc.constantFrom('london', 'newyork', 'tokyo', 'sydney'),
});

/** Generates a non-empty engine_versions record. */
const arbEngineVersions: fc.Arbitrary<Record<string, string>> = fc.dictionary(
  fc.constantFrom('fingerprint', 'similarity', 'outcome', 'forecast', 'confidence'),
  fc.stringMatching(/^\d+\.\d+\.\d+$/),
  { minKeys: 1, maxKeys: 5 },
);

/** Generates a valid ResearchForecastRecord with random field values. */
const arbResearchForecastRecord: fc.Arbitrary<ResearchForecastRecord> = fc.record({
  fingerprint_id: fc.uuid(),
  batch_id: fc.uuid(),
  asset: fc.constantFrom('EURUSD', 'GBPUSD', 'USDJPY', 'AUDUSD', 'USDCAD', 'NZDUSD'),
  timeframe: fc.constantFrom('4H', '1H', '1D'),
  forecast_timestamp: arbIsoTimestamp,
  forecast_expiry: arbIsoTimestamp,
  direction_probabilities: arbDirectionProbabilities,
  expected_move_pips: fc.double({ min: -200, max: 200, noNaN: true, noDefaultInfinity: true }),
  confidence_raw: fc.double({ min: 0, max: 1, noNaN: true, noDefaultInfinity: true }),
  confidence_final: fc.double({ min: 0, max: 1, noNaN: true, noDefaultInfinity: true }),
  tradeability_placeholder: fc.constant(null),
  engine_versions: arbEngineVersions,
  quantile_table_version: fc.stringMatching(/^20\d{2}-Q[1-4]$/),
  regime: arbRegime,
  sample_size: fc.integer({ min: 1, max: 10000 }),
  created_at: arbIsoTimestamp,
});

// =============================================================================
// Mock Factory
// =============================================================================

/**
 * Creates a mock Supabase client that simulates:
 * - First insert: success (record written)
 * - Second insert: duplicate key error (23505)
 *
 * Also captures all data passed to insert() for verification.
 * Tracks log calls independently of vitest spy state.
 */
function createDuplicateRejectingSupabase() {
  let callCount = 0;
  const insertCalls: unknown[] = [];

  const chain = {
    insert: vi.fn((data: unknown) => {
      callCount++;
      insertCalls.push(structuredClone(data));

      if (callCount === 1) {
        return Promise.resolve({ data: null, error: null });
      }
      // Second and subsequent calls return duplicate key error
      return Promise.resolve({
        data: null,
        error: { message: 'duplicate key value violates unique constraint', code: '23505' },
      });
    }),
  };

  const supabase = {
    from: vi.fn(() => chain),
  };

  return { supabase, chain, insertCalls };
}

// =============================================================================
// Property Tests
// =============================================================================

describe('Property 11: Duplicate Rejection Idempotence', () => {
  let warnMessages: string[];
  let errorMessages: string[];

  beforeEach(() => {
    warnMessages = [];
    errorMessages = [];
    vi.spyOn(console, 'warn').mockImplementation((...args: unknown[]) => {
      warnMessages.push(args.map(String).join(' '));
    });
    vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
      errorMessages.push(args.map(String).join(' '));
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('persisting the same record twice never throws — both calls resolve successfully', async () => {
    await fc.assert(
      fc.asyncProperty(arbResearchForecastRecord, async (record) => {
        const { supabase } = createDuplicateRejectingSupabase();
        const writer = createResearchArchiveWriter(supabase as never);

        // Neither call should throw
        await writer.persistForecast(record);
        await writer.persistForecast(record);
      }),
      { numRuns: 100 },
    );
  });

  it('second call logs a warning (not an error) on duplicate key rejection', async () => {
    await fc.assert(
      fc.asyncProperty(arbResearchForecastRecord, async (record) => {
        // Clear tracked messages for this iteration
        warnMessages.length = 0;
        errorMessages.length = 0;

        const { supabase } = createDuplicateRejectingSupabase();
        const writer = createResearchArchiveWriter(supabase as never);

        await writer.persistForecast(record);
        await writer.persistForecast(record);

        // The duplicate rejection should produce a warning, not an error
        const hasDuplicateWarning = warnMessages.some(msg => msg.includes('Duplicate forecast rejected'));
        expect(hasDuplicateWarning).toBe(true);

        // console.error should NOT have been called for duplicate key
        expect(errorMessages).toHaveLength(0);
      }),
      { numRuns: 100 },
    );
  });

  it('the first insert receives the original record data unchanged', async () => {
    await fc.assert(
      fc.asyncProperty(arbResearchForecastRecord, async (record) => {
        const { supabase, insertCalls } = createDuplicateRejectingSupabase();
        const writer = createResearchArchiveWriter(supabase as never);

        await writer.persistForecast(record);

        // Verify first insert was called with the full record fields
        const firstInsertData = insertCalls[0] as Record<string, unknown>;
        expect(firstInsertData.fingerprint_id).toBe(record.fingerprint_id);
        expect(firstInsertData.batch_id).toBe(record.batch_id);
        expect(firstInsertData.asset).toBe(record.asset);
        expect(firstInsertData.timeframe).toBe(record.timeframe);
        expect(firstInsertData.forecast_timestamp).toBe(record.forecast_timestamp);
        expect(firstInsertData.forecast_expiry).toBe(record.forecast_expiry);
        expect(firstInsertData.direction_probabilities).toEqual(record.direction_probabilities);
        expect(firstInsertData.expected_move_pips).toBe(record.expected_move_pips);
        expect(firstInsertData.confidence_raw).toBe(record.confidence_raw);
        expect(firstInsertData.confidence_final).toBe(record.confidence_final);
        expect(firstInsertData.tradeability_placeholder).toBe(record.tradeability_placeholder);
        expect(firstInsertData.engine_versions).toEqual(record.engine_versions);
        expect(firstInsertData.quantile_table_version).toBe(record.quantile_table_version);
        expect(firstInsertData.regime).toEqual(record.regime);
        expect(firstInsertData.sample_size).toBe(record.sample_size);
        expect(firstInsertData.created_at).toBe(record.created_at);
      }),
      { numRuns: 100 },
    );
  });

  it('record data passed to both insert calls is identical (writer does not mutate between attempts)', async () => {
    await fc.assert(
      fc.asyncProperty(arbResearchForecastRecord, async (record) => {
        const { supabase, insertCalls } = createDuplicateRejectingSupabase();
        const writer = createResearchArchiveWriter(supabase as never);

        await writer.persistForecast(record);
        await writer.persistForecast(record);

        // Both insert calls should have received identical data
        expect(insertCalls).toHaveLength(2);
        expect(insertCalls[0]).toEqual(insertCalls[1]);
      }),
      { numRuns: 100 },
    );
  });
});
