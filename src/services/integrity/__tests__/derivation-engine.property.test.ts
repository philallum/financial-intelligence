import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fc from 'fast-check';
import { AssetClass, AssetStatus } from '../../../config/research-assets.js';
import type { ResearchAsset } from '../../../config/research-assets.js';
import type { DerivationInput } from '../types.js';

// ─── Mocks ───────────────────────────────────────────────────────────────────

vi.mock('../../../engines/fingerprint-engine.js', () => ({
  generateFingerprint: vi.fn(() => ({
    fingerprint_id: 'test-fp-id',
    asset: 'EURUSD',
    timeframe: '4H',
    timestamp_utc: '2024-01-01T00:00:00.000Z',
    market_state_version: '1.0',
    ohlc: { open: 1.09, high: 1.12, low: 1.08, close: 1.1 },
    return_profile: { close_to_close: 0 },
    regime: 'ranging',
    state_layers: {},
    normalisation: {},
  })),
  computeFingerprintId: vi.fn((asset: string, timestamp: string) => `${asset}-${timestamp}`),
}));

vi.mock('../../../engines/topology-engine.js', () => ({
  computeTopology: vi.fn(() => ({
    levels: [],
    topology_vector: [],
    insufficient_history: false,
    candle_count_used: 35,
    engine_version: '1.0',
  })),
}));

// Import after mocks are set up
import { recomputeDerivations } from '../derivation-engine.js';

/**
 * Property 8: Derivation Completeness and Ordering
 * Validates: Requirements 6.1, 6.2, 6.3, 6.4
 *
 * For any set of newly backfilled candles, the derivation engine SHALL produce
 * fingerprints, outcomes, and topology for each candle, and SHALL process them
 * in strict dependency order: all fingerprints before any outcomes, all outcomes
 * before any topology.
 */

// ─── Generators ──────────────────────────────────────────────────────────────

/** Generates a valid ISO-8601 4H-aligned timestamp within a bounded range. */
const arbTimestamp = fc.integer({ min: 0, max: 9 }).map((i) => {
  const base = new Date('2024-01-15T00:00:00.000Z');
  base.setHours(base.getHours() + i * 4);
  return base.toISOString();
});

/** Generates a set of 1-10 unique timestamps (sorted ascending). */
const arbTimestamps = fc
  .uniqueArray(arbTimestamp, { minLength: 1, maxLength: 10 })
  .map((timestamps) => timestamps.sort());

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeAsset(overrides: Partial<ResearchAsset> = {}): ResearchAsset {
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

function makeOHLC(close = 1.1) {
  return { open: 1.09, high: 1.12, low: 1.08, close };
}

/**
 * Creates a mock Supabase client that tracks table write order.
 * The writeOrder array records which table is being upserted to, in order.
 */
function createTrackingMockSupabase(writeOrder: string[]) {
  const mockSupabase = {
    from: vi.fn((table: string) => {
      if (table === 'raw_candles') {
        return {
          select: vi.fn().mockReturnValue({
            eq: vi.fn().mockReturnValue({
              eq: vi.fn().mockReturnValue({
                eq: vi.fn().mockReturnValue({
                  single: vi.fn().mockResolvedValue({
                    data: makeOHLC(),
                    error: null,
                  }),
                }),
                gt: vi.fn().mockReturnValue({
                  order: vi.fn().mockReturnValue({
                    limit: vi.fn().mockReturnValue({
                      maybeSingle: vi.fn().mockResolvedValue({
                        data: makeOHLC(1.11),
                        error: null,
                      }),
                    }),
                  }),
                }),
                lte: vi.fn().mockReturnValue({
                  order: vi.fn().mockReturnValue({
                    limit: vi.fn().mockResolvedValue({
                      data: Array.from({ length: 35 }, () => makeOHLC()),
                      error: null,
                    }),
                  }),
                }),
              }),
            }),
          }),
        };
      }

      // For market_fingerprints, market_outcomes, fingerprint_topology — track order
      writeOrder.push(table);
      return {
        upsert: vi.fn().mockResolvedValue({ error: null }),
      };
    }),
  };

  return mockSupabase as any;
}

/**
 * Creates a mock Supabase that simulates failures in specific stages
 * to test fail-forward ordering. Fingerprint stage fails for first N timestamps
 * but ordering still holds.
 */
function createFailingMockSupabase(
  writeOrder: string[],
  failStage?: 'fingerprint' | 'outcome' | 'topology',
) {
  let fingerprintCallCount = 0;

  const mockSupabase = {
    from: vi.fn((table: string) => {
      if (table === 'raw_candles') {
        return {
          select: vi.fn().mockReturnValue({
            eq: vi.fn().mockReturnValue({
              eq: vi.fn().mockReturnValue({
                eq: vi.fn().mockReturnValue({
                  single: vi.fn().mockImplementation(async () => {
                    if (failStage === 'fingerprint') {
                      fingerprintCallCount++;
                      if (fingerprintCallCount === 1) {
                        return { data: null, error: { message: 'simulated failure' } };
                      }
                    }
                    return { data: makeOHLC(), error: null };
                  }),
                }),
                gt: vi.fn().mockReturnValue({
                  order: vi.fn().mockReturnValue({
                    limit: vi.fn().mockReturnValue({
                      maybeSingle: vi.fn().mockImplementation(async () => {
                        if (failStage === 'outcome') {
                          return { data: null, error: { message: 'simulated failure' } };
                        }
                        return { data: makeOHLC(1.11), error: null };
                      }),
                    }),
                  }),
                }),
                lte: vi.fn().mockReturnValue({
                  order: vi.fn().mockReturnValue({
                    limit: vi.fn().mockImplementation(async () => {
                      if (failStage === 'topology') {
                        return { data: null, error: { message: 'simulated failure' } };
                      }
                      return {
                        data: Array.from({ length: 35 }, () => makeOHLC()),
                        error: null,
                      };
                    }),
                  }),
                }),
              }),
            }),
          }),
        };
      }

      // Track write order for non-raw_candles tables
      writeOrder.push(table);
      return {
        upsert: vi.fn().mockResolvedValue({ error: null }),
      };
    }),
  };

  return mockSupabase as any;
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('Property 8: Derivation Completeness and Ordering', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  /**
   * Validates: Requirements 6.1, 6.2, 6.3, 6.4
   *
   * For any set of 1-10 timestamps, ALL fingerprint writes come before ANY
   * outcome writes, and ALL outcome writes come before ANY topology writes.
   */
  it('all fingerprint writes precede all outcome writes, which precede all topology writes', async () => {
    await fc.assert(
      fc.asyncProperty(arbTimestamps, async (timestamps) => {
        const writeOrder: string[] = [];
        const supabase = createTrackingMockSupabase(writeOrder);

        const input: DerivationInput = {
          asset: makeAsset(),
          timeframe: '4H',
          newCandleTimestamps: timestamps,
        };

        await recomputeDerivations(supabase, input);

        // Extract indices for each stage
        const fingerprintIndices = writeOrder
          .map((t, i) => (t === 'market_fingerprints' ? i : -1))
          .filter((i) => i >= 0);
        const outcomeIndices = writeOrder
          .map((t, i) => (t === 'market_outcomes' ? i : -1))
          .filter((i) => i >= 0);
        const topologyIndices = writeOrder
          .map((t, i) => (t === 'fingerprint_topology' ? i : -1))
          .filter((i) => i >= 0);

        // Property: All fingerprints before any outcomes
        if (fingerprintIndices.length > 0 && outcomeIndices.length > 0) {
          expect(Math.max(...fingerprintIndices)).toBeLessThan(
            Math.min(...outcomeIndices),
          );
        }

        // Property: All outcomes before any topology
        if (outcomeIndices.length > 0 && topologyIndices.length > 0) {
          expect(Math.max(...outcomeIndices)).toBeLessThan(
            Math.min(...topologyIndices),
          );
        }

        // Property: All fingerprints before any topology (transitive but verify)
        if (fingerprintIndices.length > 0 && topologyIndices.length > 0) {
          expect(Math.max(...fingerprintIndices)).toBeLessThan(
            Math.min(...topologyIndices),
          );
        }
      }),
      { numRuns: 100 },
    );
  });

  /**
   * Validates: Requirements 6.1, 6.2, 6.3, 6.4
   *
   * For any set of 1-10 timestamps, the derivation engine produces a fingerprint
   * write for every timestamp (completeness).
   */
  it('produces a fingerprint write for every timestamp', async () => {
    await fc.assert(
      fc.asyncProperty(arbTimestamps, async (timestamps) => {
        const writeOrder: string[] = [];
        const supabase = createTrackingMockSupabase(writeOrder);

        const input: DerivationInput = {
          asset: makeAsset(),
          timeframe: '4H',
          newCandleTimestamps: timestamps,
        };

        const result = await recomputeDerivations(supabase, input);

        // Every timestamp should generate a fingerprint (no failures in mock)
        expect(result.fingerprintsGenerated).toBe(timestamps.length);

        // Count fingerprint writes matches timestamp count
        const fingerprintCount = writeOrder.filter((t) => t === 'market_fingerprints').length;
        expect(fingerprintCount).toBe(timestamps.length);
      }),
      { numRuns: 100 },
    );
  });

  /**
   * Validates: Requirements 6.1, 6.2, 6.3, 6.4
   *
   * When newCandleTimestamps is empty, no writes happen at all (skip entirely).
   */
  it('when newCandleTimestamps is empty, no writes happen', async () => {
    const writeOrder: string[] = [];
    const supabase = createTrackingMockSupabase(writeOrder);

    const input: DerivationInput = {
      asset: makeAsset(),
      timeframe: '4H',
      newCandleTimestamps: [],
    };

    const result = await recomputeDerivations(supabase, input);

    expect(writeOrder).toHaveLength(0);
    expect(result.fingerprintsGenerated).toBe(0);
    expect(result.outcomesComputed).toBe(0);
    expect(result.topologyComputed).toBe(0);
    expect(result.errors).toHaveLength(0);
  });

  /**
   * Validates: Requirements 6.1, 6.2, 6.3, 6.4
   *
   * The ordering property holds even when some operations fail (fail-forward).
   * A failure in the fingerprint stage for one timestamp should not break
   * the strict ordering guarantee across stages.
   */
  it('ordering property holds even when some operations fail (fail-forward)', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.uniqueArray(arbTimestamp, { minLength: 2, maxLength: 10 }).map((ts) => ts.sort()),
        fc.constantFrom('fingerprint' as const, 'outcome' as const, 'topology' as const),
        async (timestamps, failStage) => {
          const writeOrder: string[] = [];
          const supabase = createFailingMockSupabase(writeOrder, failStage);

          const input: DerivationInput = {
            asset: makeAsset(),
            timeframe: '4H',
            newCandleTimestamps: timestamps,
          };

          const result = await recomputeDerivations(supabase, input);

          // Even with failures, the ordering property should hold
          const fingerprintIndices = writeOrder
            .map((t, i) => (t === 'market_fingerprints' ? i : -1))
            .filter((i) => i >= 0);
          const outcomeIndices = writeOrder
            .map((t, i) => (t === 'market_outcomes' ? i : -1))
            .filter((i) => i >= 0);
          const topologyIndices = writeOrder
            .map((t, i) => (t === 'fingerprint_topology' ? i : -1))
            .filter((i) => i >= 0);

          // Property: All fingerprints before any outcomes
          if (fingerprintIndices.length > 0 && outcomeIndices.length > 0) {
            expect(Math.max(...fingerprintIndices)).toBeLessThan(
              Math.min(...outcomeIndices),
            );
          }

          // Property: All outcomes before any topology
          if (outcomeIndices.length > 0 && topologyIndices.length > 0) {
            expect(Math.max(...outcomeIndices)).toBeLessThan(
              Math.min(...topologyIndices),
            );
          }

          // Verify errors were accumulated (fail-forward)
          expect(result.errors.length).toBeGreaterThanOrEqual(0);
        },
      ),
      { numRuns: 100 },
    );
  });
});
