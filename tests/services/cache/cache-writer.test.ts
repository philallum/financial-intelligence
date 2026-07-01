/**
 * Tests for Cache Writer Service.
 *
 * Covers:
 * - TTL calculation for various timestamps within 4H windows
 * - Skip caching when TTL < 60 seconds
 * - Skip caching when batch not completed
 * - Correct upsert behavior
 * - Correct valid_from and valid_until timestamps
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { CacheWriter, computeCacheTTL } from '../../../src/services/cache/cache-writer.js';
import type { Forecast } from '../../../src/types/index.js';

// =============================================================================
// computeCacheTTL Tests
// =============================================================================

describe('computeCacheTTL', () => {
  it('returns ~4 hours TTL at start of a window (00:00 UTC)', () => {
    const time = new Date('2024-06-15T00:00:00.000Z');
    const { ttlSeconds, windowEnd } = computeCacheTTL(time);

    expect(windowEnd.toISOString()).toBe('2024-06-15T04:00:00.000Z');
    expect(ttlSeconds).toBe(4 * 60 * 60); // 14400 seconds
  });

  it('returns ~4 hours TTL at start of 04:00 window', () => {
    const time = new Date('2024-06-15T04:00:00.000Z');
    const { ttlSeconds, windowEnd } = computeCacheTTL(time);

    expect(windowEnd.toISOString()).toBe('2024-06-15T08:00:00.000Z');
    expect(ttlSeconds).toBe(4 * 60 * 60);
  });

  it('returns ~4 hours TTL at start of 20:00 window', () => {
    const time = new Date('2024-06-15T20:00:00.000Z');
    const { ttlSeconds, windowEnd } = computeCacheTTL(time);

    // Next boundary wraps to next day 00:00
    expect(windowEnd.toISOString()).toBe('2024-06-16T00:00:00.000Z');
    expect(ttlSeconds).toBe(4 * 60 * 60);
  });

  it('returns correct TTL 1 hour into a 4H window', () => {
    const time = new Date('2024-06-15T01:00:00.000Z');
    const { ttlSeconds, windowEnd } = computeCacheTTL(time);

    expect(windowEnd.toISOString()).toBe('2024-06-15T04:00:00.000Z');
    expect(ttlSeconds).toBe(3 * 60 * 60); // 3 hours remaining
  });

  it('returns correct TTL 2.5 hours into a 4H window', () => {
    const time = new Date('2024-06-15T06:30:00.000Z');
    const { ttlSeconds, windowEnd } = computeCacheTTL(time);

    expect(windowEnd.toISOString()).toBe('2024-06-15T08:00:00.000Z');
    expect(ttlSeconds).toBe(90 * 60); // 1.5 hours remaining
  });

  it('returns correct TTL 3 hours 59 minutes into a window', () => {
    const time = new Date('2024-06-15T03:59:00.000Z');
    const { ttlSeconds, windowEnd } = computeCacheTTL(time);

    expect(windowEnd.toISOString()).toBe('2024-06-15T04:00:00.000Z');
    expect(ttlSeconds).toBe(60); // exactly 60 seconds remaining
  });

  it('returns TTL < 60 near end of window', () => {
    const time = new Date('2024-06-15T03:59:30.000Z');
    const { ttlSeconds, windowEnd } = computeCacheTTL(time);

    expect(windowEnd.toISOString()).toBe('2024-06-15T04:00:00.000Z');
    expect(ttlSeconds).toBe(30); // 30 seconds remaining
  });

  it('returns correct TTL in 12:00-16:00 window', () => {
    const time = new Date('2024-06-15T14:00:00.000Z');
    const { ttlSeconds, windowEnd } = computeCacheTTL(time);

    expect(windowEnd.toISOString()).toBe('2024-06-15T16:00:00.000Z');
    expect(ttlSeconds).toBe(2 * 60 * 60); // 2 hours remaining
  });

  it('wraps correctly at end of day (23:59)', () => {
    const time = new Date('2024-06-15T23:00:00.000Z');
    const { ttlSeconds, windowEnd } = computeCacheTTL(time);

    expect(windowEnd.toISOString()).toBe('2024-06-16T00:00:00.000Z');
    expect(ttlSeconds).toBe(60 * 60); // 1 hour remaining
  });

  it('handles timestamps with sub-second precision', () => {
    const time = new Date('2024-06-15T07:59:59.500Z');
    const { ttlSeconds, windowEnd } = computeCacheTTL(time);

    expect(windowEnd.toISOString()).toBe('2024-06-15T08:00:00.000Z');
    // floor((500ms) / 1000) = 0 seconds
    expect(ttlSeconds).toBe(0);
  });

  it('returns 0 TTL when 1 second before boundary with milliseconds', () => {
    const time = new Date('2024-06-15T07:59:59.999Z');
    const { ttlSeconds, windowEnd } = computeCacheTTL(time);

    expect(windowEnd.toISOString()).toBe('2024-06-15T08:00:00.000Z');
    expect(ttlSeconds).toBe(0); // floor(1ms / 1000) = 0
  });
});

// =============================================================================
// CacheWriter Tests
// =============================================================================

describe('CacheWriter', () => {
  let mockSupabase: {
    from: ReturnType<typeof vi.fn>;
  };
  let mockUpsert: ReturnType<typeof vi.fn>;
  let cacheWriter: CacheWriter;

  const sampleForecast: Forecast = {
    fingerprint_id: '550e8400-e29b-41d4-a716-446655440000',
    direction_probabilities: { up: 0.55, down: 0.30, flat: 0.15 },
    expected_move_pips: 12.5,
    confidence_raw: 0.72,
    confidence_final: 0.65,
    engine_version: '1.0.0',
    batch_id: '660e8400-e29b-41d4-a716-446655440000',
  };

  beforeEach(() => {
    mockUpsert = vi.fn().mockResolvedValue({ error: null });
    mockSupabase = {
      from: vi.fn().mockReturnValue({
        upsert: mockUpsert,
      }),
    };
    cacheWriter = new CacheWriter(mockSupabase as any);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('batch completion guard', () => {
    it('skips caching when batch is not completed', async () => {
      const result = await cacheWriter.writeForecast('EURUSD', sampleForecast, false);

      expect(result.skipped).toBe(true);
      expect(result.reason).toBe('batch_not_completed');
      expect(mockSupabase.from).not.toHaveBeenCalled();
    });

    it('proceeds with caching when batch is completed', async () => {
      // Mock a time well within a window
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2024-06-15T01:00:00.000Z'));

      const result = await cacheWriter.writeForecast('EURUSD', sampleForecast, true);

      expect(result.skipped).toBe(false);
      expect(mockSupabase.from).toHaveBeenCalledWith('cached_forecasts');

      vi.useRealTimers();
    });
  });

  describe('TTL minimum threshold', () => {
    it('skips caching when TTL is below 60 seconds', async () => {
      vi.useFakeTimers();
      // Set time to 30 seconds before the next boundary
      vi.setSystemTime(new Date('2024-06-15T03:59:30.000Z'));

      const result = await cacheWriter.writeForecast('EURUSD', sampleForecast, true);

      expect(result.skipped).toBe(true);
      expect(result.reason).toBe('ttl_below_minimum');
      expect(mockSupabase.from).not.toHaveBeenCalled();

      vi.useRealTimers();
    });

    it('allows caching when TTL is exactly 60 seconds', async () => {
      vi.useFakeTimers();
      // Set time to exactly 60 seconds before the next boundary
      vi.setSystemTime(new Date('2024-06-15T03:59:00.000Z'));

      const result = await cacheWriter.writeForecast('EURUSD', sampleForecast, true);

      expect(result.skipped).toBe(false);
      expect(result.ttl_seconds).toBe(60);

      vi.useRealTimers();
    });

    it('skips caching when TTL is 0 seconds', async () => {
      vi.useFakeTimers();
      // Exactly at sub-second before boundary
      vi.setSystemTime(new Date('2024-06-15T03:59:59.500Z'));

      const result = await cacheWriter.writeForecast('EURUSD', sampleForecast, true);

      expect(result.skipped).toBe(true);
      expect(result.reason).toBe('ttl_below_minimum');

      vi.useRealTimers();
    });
  });

  describe('upsert behavior', () => {
    beforeEach(() => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2024-06-15T02:00:00.000Z'));
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it('upserts into cached_forecasts table with correct payload', async () => {
      await cacheWriter.writeForecast('EURUSD', sampleForecast, true);

      expect(mockSupabase.from).toHaveBeenCalledWith('cached_forecasts');
      expect(mockUpsert).toHaveBeenCalledWith(
        {
          asset: 'EURUSD',
          fingerprint_id: sampleForecast.fingerprint_id,
          payload: sampleForecast,
          batch_id: sampleForecast.batch_id,
          valid_from: '2024-06-15T02:00:00.000Z',
          valid_until: '2024-06-15T04:00:00.000Z',
        },
        { onConflict: 'asset' }
      );
    });

    it('uses onConflict: asset to overwrite existing entry', async () => {
      await cacheWriter.writeForecast('GBPUSD', sampleForecast, true);

      expect(mockUpsert).toHaveBeenCalledWith(
        expect.objectContaining({ asset: 'GBPUSD' }),
        { onConflict: 'asset' }
      );
    });

    it('stores the full forecast object as payload', async () => {
      await cacheWriter.writeForecast('EURUSD', sampleForecast, true);

      const upsertPayload = mockUpsert.mock.calls[0][0];
      expect(upsertPayload.payload).toEqual(sampleForecast);
    });
  });

  describe('valid_from and valid_until timestamps', () => {
    it('sets valid_from to current time', async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2024-06-15T10:30:00.000Z'));

      await cacheWriter.writeForecast('EURUSD', sampleForecast, true);

      const upsertPayload = mockUpsert.mock.calls[0][0];
      expect(upsertPayload.valid_from).toBe('2024-06-15T10:30:00.000Z');

      vi.useRealTimers();
    });

    it('sets valid_until to end of current 4H window', async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2024-06-15T10:30:00.000Z'));

      await cacheWriter.writeForecast('EURUSD', sampleForecast, true);

      const upsertPayload = mockUpsert.mock.calls[0][0];
      expect(upsertPayload.valid_until).toBe('2024-06-15T12:00:00.000Z');

      vi.useRealTimers();
    });

    it('wraps valid_until to next day for 20:00-00:00 window', async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2024-06-15T21:00:00.000Z'));

      await cacheWriter.writeForecast('EURUSD', sampleForecast, true);

      const upsertPayload = mockUpsert.mock.calls[0][0];
      expect(upsertPayload.valid_until).toBe('2024-06-16T00:00:00.000Z');

      vi.useRealTimers();
    });
  });

  describe('return values', () => {
    it('returns skipped: false with valid_until and ttl_seconds on success', async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2024-06-15T02:00:00.000Z'));

      const result = await cacheWriter.writeForecast('EURUSD', sampleForecast, true);

      expect(result).toEqual({
        skipped: false,
        valid_until: '2024-06-15T04:00:00.000Z',
        ttl_seconds: 2 * 60 * 60, // 7200 seconds
      });

      vi.useRealTimers();
    });

    it('returns correct TTL for mid-window writes', async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2024-06-15T13:30:00.000Z'));

      const result = await cacheWriter.writeForecast('EURUSD', sampleForecast, true);

      expect(result.skipped).toBe(false);
      expect(result.ttl_seconds).toBe(150 * 60); // 2.5 hours = 9000 seconds
      expect(result.valid_until).toBe('2024-06-15T16:00:00.000Z');

      vi.useRealTimers();
    });
  });

  describe('error handling', () => {
    it('throws when Supabase upsert returns an error', async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2024-06-15T02:00:00.000Z'));

      mockUpsert.mockResolvedValue({
        error: { message: 'Connection refused' },
      });

      await expect(
        cacheWriter.writeForecast('EURUSD', sampleForecast, true)
      ).rejects.toThrow('Failed to write cache for asset EURUSD: Connection refused');

      vi.useRealTimers();
    });
  });
});
