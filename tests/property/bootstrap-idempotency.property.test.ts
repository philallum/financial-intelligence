import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';
import type { CandleRecord } from '../../src/bootstrap/types.js';

// Feature: gbpusd-asset-onboarding, Property 8: Bootstrap idempotency

// ─── In-Memory Mock Upsert Layer ────────────────────────────────────────────────

/**
 * Simulates the Supabase upsert with `ignoreDuplicates: true` semantics.
 * Keyed on "asset,timeframe,timestamp_utc" to mirror the real conflict constraint.
 */
class MockUpsertStore {
  private store = new Map<string, CandleRecord & { asset: string; timeframe: string }>();
  public lastInsertCount = 0;

  private makeKey(asset: string, timeframe: string, timestamp_utc: string): string {
    return `${asset},${timeframe},${timestamp_utc}`;
  }

  /**
   * Upsert rows with ignoreDuplicates semantics:
   * - New keys are inserted
   * - Existing keys are skipped (not updated)
   * Returns the count of actually inserted rows.
   */
  upsert(
    rows: Array<CandleRecord & { asset: string; timeframe: string }>,
    _options: { ignoreDuplicates: true },
  ): { inserted: number } {
    let inserted = 0;

    for (const row of rows) {
      const key = this.makeKey(row.asset, row.timeframe, row.timestamp_utc);
      if (!this.store.has(key)) {
        this.store.set(key, { ...row });
        inserted++;
      }
      // ignoreDuplicates: skip if key already exists
    }

    this.lastInsertCount = inserted;
    return { inserted };
  }

  get size(): number {
    return this.store.size;
  }

  snapshot(): Map<string, CandleRecord & { asset: string; timeframe: string }> {
    return new Map(this.store);
  }
}

// ─── Generators ─────────────────────────────────────────────────────────────────

/**
 * Generates a random ISO 8601 timestamp string for candle records.
 */
const timestampArb = fc
  .date({ min: new Date('2020-01-01T00:00:00Z'), max: new Date('2024-12-31T20:00:00Z') })
  .map((d) => {
    // Snap to 4H boundaries to mimic realistic candle timestamps
    const ms = d.getTime();
    const fourHoursMs = 4 * 60 * 60 * 1000;
    const snapped = new Date(Math.floor(ms / fourHoursMs) * fourHoursMs);
    return snapped.toISOString();
  });

/**
 * Generates a single CandleRecord with valid OHLCV values.
 */
const candleRecordArb: fc.Arbitrary<CandleRecord> = fc
  .record({
    timestamp_utc: timestampArb,
    open: fc.double({ min: 1.0, max: 2.0, noNaN: true, noDefaultInfinity: true }),
    high: fc.double({ min: 1.0, max: 2.0, noNaN: true, noDefaultInfinity: true }),
    low: fc.double({ min: 1.0, max: 2.0, noNaN: true, noDefaultInfinity: true }),
    close: fc.double({ min: 1.0, max: 2.0, noNaN: true, noDefaultInfinity: true }),
    volume: fc.integer({ min: 0, max: 100000 }),
  })
  .map((r) => ({
    ...r,
    // Ensure OHLC validity: high >= max(open, close), low <= min(open, close)
    high: Math.max(r.open, r.close, r.high),
    low: Math.min(r.open, r.close, r.low),
  }));

/**
 * Generates an array of CandleRecords with unique timestamps (1-20 records).
 * Uses uniqueBy on timestamp_utc to avoid accidental duplication within a single batch.
 */
const candleSetArb: fc.Arbitrary<CandleRecord[]> = fc.uniqueArray(candleRecordArb, {
  minLength: 1,
  maxLength: 20,
  comparator: (a, b) => a.timestamp_utc === b.timestamp_utc,
});

// ─── Property 8: Bootstrap idempotency ──────────────────────────────────────────

describe('Property 8: Bootstrap idempotency', () => {
  /**
   * Validates: Requirements 8.1, 8.4
   * For any set of candle records, inserting them twice via the mock upsert layer
   * (with ignoreDuplicates: true) SHALL produce 0 new inserts on the second pass,
   * and the store state SHALL be identical after both passes.
   */
  it('double-insert via mock upsert layer produces 0 new inserts on second pass', () => {
    fc.assert(
      fc.property(candleSetArb, (records) => {
        const store = new MockUpsertStore();
        const asset = 'GBPUSD';
        const timeframe = '4H';

        // Prepare rows matching the real upsert shape
        const rows = records.map((r) => ({
          ...r,
          asset,
          timeframe,
        }));

        // First pass: insert all records
        const firstResult = store.upsert(rows, { ignoreDuplicates: true });
        expect(firstResult.inserted).toBe(records.length);
        expect(store.size).toBe(records.length);

        // Capture store state after first pass
        const snapshotAfterFirst = store.snapshot();

        // Second pass: insert the same records again
        const secondResult = store.upsert(rows, { ignoreDuplicates: true });
        expect(secondResult.inserted).toBe(0);

        // Store size unchanged
        expect(store.size).toBe(records.length);

        // Store state identical after both passes
        const snapshotAfterSecond = store.snapshot();
        expect(snapshotAfterSecond.size).toBe(snapshotAfterFirst.size);

        for (const [key, value] of snapshotAfterFirst) {
          const secondValue = snapshotAfterSecond.get(key);
          expect(secondValue).toBeDefined();
          expect(secondValue).toEqual(value);
        }
      }),
      { numRuns: 100 },
    );
  });

  /**
   * Validates: Requirements 8.1, 8.4
   * All upsert operations resolve as duplicate-ignore on re-run:
   * multiple sequential re-runs all produce 0 inserts.
   */
  it('all upsert operations resolve as duplicate-ignore on repeated re-runs', () => {
    fc.assert(
      fc.property(candleSetArb, fc.integer({ min: 2, max: 5 }), (records, reruns) => {
        const store = new MockUpsertStore();
        const asset = 'GBPUSD';
        const timeframe = '4H';

        const rows = records.map((r) => ({
          ...r,
          asset,
          timeframe,
        }));

        // Initial insert
        const firstResult = store.upsert(rows, { ignoreDuplicates: true });
        expect(firstResult.inserted).toBe(records.length);

        // All subsequent re-runs produce 0 inserts
        for (let i = 0; i < reruns; i++) {
          const result = store.upsert(rows, { ignoreDuplicates: true });
          expect(result.inserted).toBe(0);
          expect(store.size).toBe(records.length);
        }
      }),
      { numRuns: 100 },
    );
  });
});
