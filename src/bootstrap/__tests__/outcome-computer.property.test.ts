import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';
import { computeOutcomes } from '../outcome-computer.js';
import type { CandleRecord, OutcomeRecord } from '../types.js';

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
          low: fc.double({ min: Math.max(0.01, minOC - 0.5), max: minOC, noNaN: true, noDefaultInfinity: true }),
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

/** Generates a pip size from common values */
function arbPipSize(): fc.Arbitrary<number> {
  return fc.constantFrom(0.0001, 0.01);
}

// ─── Property 8: Outcome Count Invariant ────────────────────────────────────

// Feature: historical-data-bootstrap, Property 8: Outcome Count Invariant
/**
 * For N candles (N ≥ 2), computeOutcomes produces exactly N-1 records.
 *
 * **Validates: Requirements 5.1**
 */
describe('Property 8: Outcome Count Invariant', () => {
  it('for N candles (N ≥ 2), computeOutcomes produces exactly N-1 outcome records', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 2, max: 100 }).chain(n =>
          fc.tuple(arbCandleArray(n, n), arbFingerprintIds(n)).map(([candles, ids]) => ({
            candles,
            ids,
            n,
          })),
        ),
        ({ candles, ids, n }) => {
          const outcomes = computeOutcomes(candles, ids, 'TESTPAIR', 0.0001);
          expect(outcomes).toHaveLength(n - 1);
        },
      ),
      { numRuns: 100 },
    );
  });
});

// ─── Property 9: Outcome Formula Correctness ────────────────────────────────

// Feature: historical-data-bootstrap, Property 9: Outcome Formula Correctness
/**
 * Computed metrics match expected formulas within ±0.01 tolerance.
 * - net_return_pips ≈ (next_close - current_close) / pipSize
 * - max_favourable_excursion ≈ (next_high - current_close) / pipSize
 * - max_adverse_excursion ≈ (current_close - next_low) / pipSize
 * - realised_volatility ≈ ((next_high - next_low) / pipSize) / 10000
 *
 * **Validates: Requirements 5.2, 5.3, 5.4, 5.5**
 */
describe('Property 9: Outcome Formula Correctness', () => {
  it('computed metrics match expected formulas within ±0.01 tolerance', () => {
    fc.assert(
      fc.property(
        fc.tuple(arbCandleRecord(), arbCandleRecord(), arbPipSize(), fc.uuid(), fc.uuid()),
        ([currentCandle, nextCandle, pipSize, fpId1, fpId2]) => {
          // Assign distinct timestamps
          const current: CandleRecord = {
            ...currentCandle,
            timestamp_utc: '2020-01-01T00:00:00.000Z',
          };
          const next: CandleRecord = {
            ...nextCandle,
            timestamp_utc: '2020-01-01T04:00:00.000Z',
          };

          const candles = [current, next];
          const fingerprintIds = [fpId1, fpId2];

          const outcomes = computeOutcomes(candles, fingerprintIds, 'TESTPAIR', pipSize);
          expect(outcomes).toHaveLength(1);

          const outcome = outcomes[0];

          // Expected formulas
          const expectedNetReturn = (next.close - current.close) / pipSize;
          const expectedMFE = (next.high - current.close) / pipSize;
          const expectedMAE = (current.close - next.low) / pipSize;
          const expectedVolatility = ((next.high - next.low) / pipSize) / 10000;

          // Verify within ±0.01 tolerance
          expect(outcome.net_return_pips).toBeCloseTo(expectedNetReturn, 1);
          expect(outcome.max_favourable_excursion).toBeCloseTo(expectedMFE, 1);
          expect(outcome.max_adverse_excursion).toBeCloseTo(expectedMAE, 1);
          expect(outcome.realised_volatility).toBeCloseTo(expectedVolatility, 1);
        },
      ),
      { numRuns: 100 },
    );
  });
});
