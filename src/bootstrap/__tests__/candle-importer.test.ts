/**
 * Unit tests for candle-importer.ts
 *
 * Uses a mock Supabase client to verify batching, deduplication,
 * and fail-forward behavior without requiring a real database.
 */

import { describe, it, expect, vi } from 'vitest';
import { importCandles } from '../candle-importer.js';
import type { CandleRecord } from '../types.js';

function makeCandleRecord(overrides: Partial<CandleRecord> = {}): CandleRecord {
  return {
    timestamp_utc: '2023-01-02T00:00:00.000Z',
    open: 1.05,
    high: 1.06,
    low: 1.04,
    close: 1.055,
    volume: 1000,
    ...overrides,
  };
}

function createMockSupabase(upsertFn: (...args: any[]) => any) {
  return {
    from: () => ({
      upsert: upsertFn,
    }),
  } as any;
}

describe('importCandles', () => {
  it('should insert all records successfully with correct asset and timeframe', async () => {
    const upsertMock = vi.fn().mockResolvedValue({ error: null, count: 3 });
    const supabase = createMockSupabase(upsertMock);

    const records = [
      makeCandleRecord({ timestamp_utc: '2023-01-02T00:00:00.000Z' }),
      makeCandleRecord({ timestamp_utc: '2023-01-02T04:00:00.000Z' }),
      makeCandleRecord({ timestamp_utc: '2023-01-02T08:00:00.000Z' }),
    ];

    const result = await importCandles(supabase, records, 'eurusd');

    expect(result).toEqual({ inserted: 3, skipped: 0, errors: 0 });
    expect(upsertMock).toHaveBeenCalledTimes(1);

    // Verify the rows passed to upsert have uppercase asset and 4H timeframe
    const [rows, options] = upsertMock.mock.calls[0];
    expect(rows[0].asset).toBe('EURUSD');
    expect(rows[0].timeframe).toBe('4H');
    expect(options).toEqual({
      onConflict: 'asset,timeframe,timestamp_utc',
      ignoreDuplicates: true,
      count: 'exact',
    });
  });

  it('should batch records according to batchSize option', async () => {
    const upsertMock = vi.fn().mockResolvedValue({ error: null, count: 2 });
    const supabase = createMockSupabase(upsertMock);

    const records = Array.from({ length: 5 }, (_, i) =>
      makeCandleRecord({ timestamp_utc: `2023-01-02T${String(i * 4).padStart(2, '0')}:00:00.000Z` })
    );

    const result = await importCandles(supabase, records, 'GBPUSD', { batchSize: 2 });

    // 5 records with batchSize 2 → 3 batches (2, 2, 1)
    expect(upsertMock).toHaveBeenCalledTimes(3);
    // count=2 for each batch call, so inserted = 2+2+2 = 6... but that's the mock.
    // The real logic: batchInserted = count ?? batch.length
    expect(result.inserted).toBe(6);
    expect(result.errors).toBe(0);
  });

  it('should handle duplicates by tracking skipped count', async () => {
    // count=1 means only 1 of 3 rows in the batch was actually inserted
    const upsertMock = vi.fn().mockResolvedValue({ error: null, count: 1 });
    const supabase = createMockSupabase(upsertMock);

    const records = [
      makeCandleRecord({ timestamp_utc: '2023-01-02T00:00:00.000Z' }),
      makeCandleRecord({ timestamp_utc: '2023-01-02T04:00:00.000Z' }),
      makeCandleRecord({ timestamp_utc: '2023-01-02T08:00:00.000Z' }),
    ];

    const result = await importCandles(supabase, records, 'EURUSD');

    expect(result.inserted).toBe(1);
    expect(result.skipped).toBe(2);
    expect(result.errors).toBe(0);
  });

  it('should continue on batch error and track error count (fail-forward)', async () => {
    const upsertMock = vi.fn()
      .mockResolvedValueOnce({ error: { message: 'timeout' }, count: null })
      .mockResolvedValueOnce({ error: null, count: 2 });

    const supabase = createMockSupabase(upsertMock);
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const records = Array.from({ length: 4 }, (_, i) =>
      makeCandleRecord({ timestamp_utc: `2023-01-02T${String(i * 4).padStart(2, '0')}:00:00.000Z` })
    );

    const result = await importCandles(supabase, records, 'EURUSD', { batchSize: 2 });

    // First batch of 2 fails → 2 errors
    // Second batch of 2 succeeds with count=2 → 2 inserted
    expect(result.errors).toBe(2);
    expect(result.inserted).toBe(2);
    expect(result.skipped).toBe(0);
    expect(consoleSpy).toHaveBeenCalledTimes(1);
    expect(consoleSpy.mock.calls[0][0]).toContain('Batch 1 error');

    consoleSpy.mockRestore();
  });

  it('should return zeros for empty records array', async () => {
    const upsertMock = vi.fn();
    const supabase = createMockSupabase(upsertMock);

    const result = await importCandles(supabase, [], 'EURUSD');

    expect(result).toEqual({ inserted: 0, skipped: 0, errors: 0 });
    expect(upsertMock).not.toHaveBeenCalled();
  });

  it('should default batch size to 500 when no options provided', async () => {
    const upsertMock = vi.fn().mockResolvedValue({ error: null, count: 500 });
    const supabase = createMockSupabase(upsertMock);

    // Create 501 records to force 2 batches with default size 500
    const records = Array.from({ length: 501 }, (_, i) =>
      makeCandleRecord({ timestamp_utc: `2023-01-${String(Math.floor(i / 6) + 2).padStart(2, '0')}T${String((i % 6) * 4).padStart(2, '0')}:00:00.000Z` })
    );

    await importCandles(supabase, records, 'EURUSD');

    expect(upsertMock).toHaveBeenCalledTimes(2);
    // First batch should have 500 rows
    expect(upsertMock.mock.calls[0][0]).toHaveLength(500);
    // Second batch should have 1 row
    expect(upsertMock.mock.calls[1][0]).toHaveLength(1);
  });
});
