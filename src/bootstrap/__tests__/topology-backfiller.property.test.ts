import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as fc from 'fast-check';
import type { CandleRecord } from '../types.js';
import { MIN_TOPOLOGY_CANDLES, MAX_TOPOLOGY_CANDLES } from '../types.js';

// Mock the topology engine to capture candles passed to computeTopology
const computeTopologyMock = vi.fn().mockImplementation((input) => ({
  fingerprint_id: input.fingerprint_id,
  asset: input.asset,
  levels: [],
  topology_vector: Array(40).fill(0),
  insufficient_history: false,
  candle_count_used: input.candles.length,
  engine_version: '1.0.0',
}));

vi.mock('../../engines/topology-engine.js', () => ({
  computeTopology: (...args: unknown[]) => computeTopologyMock(...args),
}));

// Mock Supabase client
function createMockSupabase() {
  const upsertMock = vi.fn().mockResolvedValue({ error: null });
  return {
    from: vi.fn().mockReturnValue({
      upsert: upsertMock,
    }),
    _upsertMock: upsertMock,
  };
}

// ─── Shared Generators ──────────────────────────────────────────────────────

/** Generates a valid CandleRecord with reasonable OHLCV ranges */
function arbCandleRecord(): fc.Arbitrary<CandleRecord> {
  return fc
    .record({
      open: fc.double({ min: 0.5, max: 2.0, noNaN: true, noDefaultInfinity: true }),
      close: fc.double({ min: 0.5, max: 2.0, noNaN: true, noDefaultInfinity: true }),
      volume: fc.double({ min: 0, max: 100000, noNaN: true, noDefaultInfinity: true }),
    })
    .chain(({ open, close, volume }) => {
      const maxOC = Math.max(open, close);
      const minOC = Math.min(open, close);
      return fc
        .record({
          high: fc.double({ min: maxOC, max: maxOC + 0.5, noNaN: true, noDefaultInfinity: true }),
          low: fc.double({
            min: Math.max(0.01, minOC - 0.5),
            max: minOC,
            noNaN: true,
            noDefaultInfinity: true,
          }),
        })
        .map(({ high, low }) => ({
          timestamp_utc: new Date(Date.now()).toISOString(),
          open,
          high,
          low,
          close,
          volume,
        }));
    });
}

/** Generates an array of N candle records with distinct timestamps */
function arbCandleArray(minLen: number, maxLen: number): fc.Arbitrary<CandleRecord[]> {
  return fc
    .array(arbCandleRecord(), { minLength: minLen, maxLength: maxLen })
    .map(candles =>
      candles.map((c, i) => ({
        ...c,
        timestamp_utc: new Date(Date.UTC(2020, 0, 1) + i * 4 * 60 * 60 * 1000).toISOString(),
      })),
    );
}

/** Generates a fingerprintIds array of length N using fc.uuid() */
function arbFingerprintIds(length: number): fc.Arbitrary<string[]> {
  return fc.array(fc.uuid(), { minLength: length, maxLength: length });
}

// ─── Property 10: Topology Window and Skip Logic ────────────────────────────

// Feature: historical-data-bootstrap, Property 10: Topology Window and Skip Logic
/**
 * For any array of candles and for any index i:
 * - If i < 30, the topology backfiller SHALL skip this fingerprint
 * - If i >= 30, the topology backfiller SHALL provide min(i, 120) preceding candles
 *   as context to computeTopology
 *
 * **Validates: Requirements 6.2, 6.3**
 */
describe('Property 10: Topology Window and Skip Logic', () => {
  beforeEach(() => {
    computeTopologyMock.mockClear();
  });

  it('skips the first 30 indices (index < 30) and computes for index >= 30', async () => {
    const { backfillTopology } = await import('../topology-backfiller.js');

    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 30, max: 200 }).chain(n =>
          fc.tuple(arbCandleArray(n, n), arbFingerprintIds(n)).map(([candles, ids]) => ({
            candles,
            ids,
            n,
          })),
        ),
        async ({ candles, ids, n }) => {
          computeTopologyMock.mockClear();
          const supabase = createMockSupabase();

          const result = await backfillTopology(
            supabase as any,
            candles,
            ids,
            'TESTPAIR',
          );

          // First 30 candles should be skipped
          expect(result.skipped).toBe(MIN_TOPOLOGY_CANDLES);

          // Remaining candles should be computed
          expect(result.computed).toBe(n - MIN_TOPOLOGY_CANDLES);

          // computeTopology should have been called for each index >= 30
          expect(computeTopologyMock).toHaveBeenCalledTimes(n - MIN_TOPOLOGY_CANDLES);
        },
      ),
      { numRuns: 50 },
    );
  });

  it('provides min(i, 120) preceding candles as context for index i >= 30', async () => {
    const { backfillTopology } = await import('../topology-backfiller.js');

    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 30, max: 200 }).chain(n =>
          fc.tuple(arbCandleArray(n, n), arbFingerprintIds(n)).map(([candles, ids]) => ({
            candles,
            ids,
            n,
          })),
        ),
        async ({ candles, ids, n }) => {
          computeTopologyMock.mockClear();
          const supabase = createMockSupabase();

          await backfillTopology(supabase as any, candles, ids, 'TESTPAIR');

          // Verify each call to computeTopology received the correct number of preceding candles
          let callIndex = 0;
          for (let i = MIN_TOPOLOGY_CANDLES; i < n; i++) {
            const expectedCandleCount = Math.min(i, MAX_TOPOLOGY_CANDLES);
            const call = computeTopologyMock.mock.calls[callIndex];
            const input = call[0];

            // Verify candle count matches min(i, 120)
            expect(input.candles).toHaveLength(expectedCandleCount);

            // Verify the fingerprint_id matches the current index
            expect(input.fingerprint_id).toBe(ids[i]);

            callIndex++;
          }
        },
      ),
      { numRuns: 50 },
    );
  });

  it('preceding candles do NOT include the current candle at index i', async () => {
    const { backfillTopology } = await import('../topology-backfiller.js');

    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 31, max: 100 }).chain(n =>
          fc.tuple(arbCandleArray(n, n), arbFingerprintIds(n)).map(([candles, ids]) => ({
            candles,
            ids,
            n,
          })),
        ),
        async ({ candles, ids, n }) => {
          computeTopologyMock.mockClear();
          const supabase = createMockSupabase();

          await backfillTopology(supabase as any, candles, ids, 'TESTPAIR');

          // For each computed index, verify the last candle in the context
          // is the candle at index i-1, not the candle at index i
          let callIndex = 0;
          for (let i = MIN_TOPOLOGY_CANDLES; i < n; i++) {
            const call = computeTopologyMock.mock.calls[callIndex];
            const input = call[0];
            const passedCandles = input.candles;

            // The last OHLC candle passed should correspond to candles[i-1]
            const lastPassed = passedCandles[passedCandles.length - 1];
            const expectedCandle = candles[i - 1];

            expect(lastPassed.open).toBe(expectedCandle.open);
            expect(lastPassed.high).toBe(expectedCandle.high);
            expect(lastPassed.low).toBe(expectedCandle.low);
            expect(lastPassed.close).toBe(expectedCandle.close);

            callIndex++;
          }
        },
      ),
      { numRuns: 50 },
    );
  });
});
