/**
 * Tests for Data Ingestion Service.
 *
 * Covers:
 * - Provider registry and fallback chain
 * - UTC 4H grid resampling
 * - Sunday candle merging (Option A: merge into Monday open)
 * - Error handling when all providers fail
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  ProviderRegistry,
  IngestionService,
  IngestionError,
  snapToUTC4HGrid,
  isValidGridBoundary,
  isSunday,
  getNextMondayOpen,
  mergeSundayIntoMonday,
  type DataProvider,
  type RawCandleData,
} from '../../../src/services/ingestion/ingestion-service.js';

// =============================================================================
// UTC 4H Grid Resampling Tests
// =============================================================================

describe('snapToUTC4HGrid', () => {
  it('snaps timestamps to the nearest preceding 4H boundary', () => {
    expect(snapToUTC4HGrid('2024-06-15T00:00:00.000Z')).toBe('2024-06-15T00:00:00.000Z');
    expect(snapToUTC4HGrid('2024-06-15T03:59:59.999Z')).toBe('2024-06-15T00:00:00.000Z');
    expect(snapToUTC4HGrid('2024-06-15T04:00:00.000Z')).toBe('2024-06-15T04:00:00.000Z');
    expect(snapToUTC4HGrid('2024-06-15T07:30:00.000Z')).toBe('2024-06-15T04:00:00.000Z');
    expect(snapToUTC4HGrid('2024-06-15T08:00:00.000Z')).toBe('2024-06-15T08:00:00.000Z');
    expect(snapToUTC4HGrid('2024-06-15T11:59:59.000Z')).toBe('2024-06-15T08:00:00.000Z');
    expect(snapToUTC4HGrid('2024-06-15T12:00:00.000Z')).toBe('2024-06-15T12:00:00.000Z');
    expect(snapToUTC4HGrid('2024-06-15T16:00:00.000Z')).toBe('2024-06-15T16:00:00.000Z');
    expect(snapToUTC4HGrid('2024-06-15T20:00:00.000Z')).toBe('2024-06-15T20:00:00.000Z');
    expect(snapToUTC4HGrid('2024-06-15T23:59:59.999Z')).toBe('2024-06-15T20:00:00.000Z');
  });

  it('handles Date objects', () => {
    const date = new Date('2024-06-15T06:30:00.000Z');
    expect(snapToUTC4HGrid(date)).toBe('2024-06-15T04:00:00.000Z');
  });
});

describe('isValidGridBoundary', () => {
  it('returns true for valid 4H grid boundaries', () => {
    expect(isValidGridBoundary('2024-06-15T00:00:00.000Z')).toBe(true);
    expect(isValidGridBoundary('2024-06-15T04:00:00.000Z')).toBe(true);
    expect(isValidGridBoundary('2024-06-15T08:00:00.000Z')).toBe(true);
    expect(isValidGridBoundary('2024-06-15T12:00:00.000Z')).toBe(true);
    expect(isValidGridBoundary('2024-06-15T16:00:00.000Z')).toBe(true);
    expect(isValidGridBoundary('2024-06-15T20:00:00.000Z')).toBe(true);
  });

  it('returns false for non-grid timestamps', () => {
    expect(isValidGridBoundary('2024-06-15T01:00:00.000Z')).toBe(false);
    expect(isValidGridBoundary('2024-06-15T04:01:00.000Z')).toBe(false);
    expect(isValidGridBoundary('2024-06-15T08:00:01.000Z')).toBe(false);
    expect(isValidGridBoundary('2024-06-15T12:00:00.001Z')).toBe(false);
  });
});

// =============================================================================
// Sunday Candle Merging Tests
// =============================================================================

describe('isSunday', () => {
  it('correctly identifies Sundays', () => {
    // 2024-06-16 is a Sunday
    expect(isSunday('2024-06-16T00:00:00.000Z')).toBe(true);
    expect(isSunday('2024-06-16T20:00:00.000Z')).toBe(true);
  });

  it('returns false for non-Sundays', () => {
    // 2024-06-17 is a Monday
    expect(isSunday('2024-06-17T00:00:00.000Z')).toBe(false);
    // 2024-06-15 is a Saturday
    expect(isSunday('2024-06-15T00:00:00.000Z')).toBe(false);
  });
});

describe('getNextMondayOpen', () => {
  it('returns Monday 00:00 UTC from Sunday', () => {
    // 2024-06-16 is Sunday → 2024-06-17 is Monday
    expect(getNextMondayOpen('2024-06-16T00:00:00.000Z')).toBe('2024-06-17T00:00:00.000Z');
    expect(getNextMondayOpen('2024-06-16T20:00:00.000Z')).toBe('2024-06-17T00:00:00.000Z');
  });
});

describe('mergeSundayIntoMonday', () => {
  const sundayCandle: RawCandleData = {
    timestamp: '2024-06-16T20:00:00.000Z',
    open: 1.085,
    high: 1.092,
    low: 1.083,
    close: 1.09,
    volume: 1000,
  };

  it('uses Sunday candle as Monday open when no Monday candle exists', () => {
    const result = mergeSundayIntoMonday(sundayCandle);
    expect(result.timestamp).toBe('2024-06-17T00:00:00.000Z');
    expect(result.open).toBe(1.085);
    expect(result.high).toBe(1.092);
    expect(result.low).toBe(1.083);
    expect(result.close).toBe(1.09);
    expect(result.volume).toBe(1000);
  });

  it('merges Sunday and Monday candles correctly', () => {
    const mondayCandle: RawCandleData = {
      timestamp: '2024-06-17T00:00:00.000Z',
      open: 1.089,
      high: 1.095,
      low: 1.084,
      close: 1.093,
      volume: 2000,
    };

    const result = mergeSundayIntoMonday(sundayCandle, mondayCandle);
    expect(result.timestamp).toBe('2024-06-17T00:00:00.000Z');
    expect(result.open).toBe(1.085); // Sunday's open
    expect(result.high).toBe(1.095); // max(Sunday.high, Monday.high)
    expect(result.low).toBe(1.083); // min(Sunday.low, Monday.low)
    expect(result.close).toBe(1.093); // Monday's close
    expect(result.volume).toBe(3000); // sum
  });

  it('handles missing volume gracefully', () => {
    const sundayNoVolume: RawCandleData = {
      timestamp: '2024-06-16T20:00:00.000Z',
      open: 1.085,
      high: 1.092,
      low: 1.083,
      close: 1.09,
    };

    const mondayWithVolume: RawCandleData = {
      timestamp: '2024-06-17T00:00:00.000Z',
      open: 1.089,
      high: 1.095,
      low: 1.084,
      close: 1.093,
      volume: 2000,
    };

    const result = mergeSundayIntoMonday(sundayNoVolume, mondayWithVolume);
    expect(result.volume).toBe(2000); // Monday's volume since Sunday is undefined
  });
});

// =============================================================================
// Provider Registry Tests
// =============================================================================

describe('ProviderRegistry', () => {
  function createMockProvider(
    name: string,
    tier: 'primary' | 'fallback' | 'emergency',
    shouldFail: boolean = false,
    data?: RawCandleData
  ): DataProvider {
    return {
      name,
      tier,
      fetch: vi.fn().mockImplementation(async () => {
        if (shouldFail) {
          throw new Error(`${name} failed`);
        }
        return (
          data ?? {
            timestamp: '2024-06-15T08:00:00.000Z',
            open: 1.085,
            high: 1.092,
            low: 1.083,
            close: 1.09,
            volume: 1500,
          }
        );
      }),
    };
  }

  it('throws if no providers are supplied', () => {
    expect(() => new ProviderRegistry([])).toThrow(
      'ProviderRegistry requires at least one provider'
    );
  });

  it('returns data from the primary provider on success', async () => {
    const primary = createMockProvider('TwelveData', 'primary');
    const fallback = createMockProvider('MassiveAPI', 'fallback');
    const emergency = createMockProvider('YahooFinance', 'emergency');

    const registry = new ProviderRegistry([primary, fallback, emergency]);
    const result = await registry.fetchWithFallback('EURUSD', '4H', '2024-06-15T08:00:00.000Z');

    expect(result.data.open).toBe(1.085);
    expect(result.attempts).toHaveLength(1);
    expect(result.attempts[0]!.provider).toBe('TwelveData');
    expect(result.attempts[0]!.success).toBe(true);
    expect(primary.fetch).toHaveBeenCalledOnce();
    expect(fallback.fetch).not.toHaveBeenCalled();
    expect(emergency.fetch).not.toHaveBeenCalled();
  });

  it('falls back to secondary provider when primary fails', async () => {
    const primary = createMockProvider('TwelveData', 'primary', true);
    const fallback = createMockProvider('MassiveAPI', 'fallback');
    const emergency = createMockProvider('YahooFinance', 'emergency');

    const registry = new ProviderRegistry([primary, fallback, emergency]);
    const result = await registry.fetchWithFallback('EURUSD', '4H', '2024-06-15T08:00:00.000Z');

    expect(result.data.open).toBe(1.085);
    expect(result.attempts).toHaveLength(2);
    expect(result.attempts[0]!.success).toBe(false);
    expect(result.attempts[1]!.success).toBe(true);
    expect(result.attempts[1]!.provider).toBe('MassiveAPI');
  });

  it('falls back to emergency provider when primary and fallback fail', async () => {
    const primary = createMockProvider('TwelveData', 'primary', true);
    const fallback = createMockProvider('MassiveAPI', 'fallback', true);
    const emergency = createMockProvider('YahooFinance', 'emergency');

    const registry = new ProviderRegistry([primary, fallback, emergency]);
    const result = await registry.fetchWithFallback('EURUSD', '4H', '2024-06-15T08:00:00.000Z');

    expect(result.data.open).toBe(1.085);
    expect(result.attempts).toHaveLength(3);
    expect(result.attempts[0]!.success).toBe(false);
    expect(result.attempts[1]!.success).toBe(false);
    expect(result.attempts[2]!.success).toBe(true);
    expect(result.attempts[2]!.provider).toBe('YahooFinance');
  });

  it('throws IngestionError when all providers fail', async () => {
    const primary = createMockProvider('TwelveData', 'primary', true);
    const fallback = createMockProvider('MassiveAPI', 'fallback', true);
    const emergency = createMockProvider('YahooFinance', 'emergency', true);

    const registry = new ProviderRegistry([primary, fallback, emergency]);

    await expect(
      registry.fetchWithFallback('EURUSD', '4H', '2024-06-15T08:00:00.000Z')
    ).rejects.toThrow(IngestionError);

    try {
      await registry.fetchWithFallback('EURUSD', '4H', '2024-06-15T08:00:00.000Z');
    } catch (error) {
      expect(error).toBeInstanceOf(IngestionError);
      const ingestionError = error as IngestionError;
      expect(ingestionError.attempts).toHaveLength(3);
      expect(ingestionError.attempts.every((a) => !a.success)).toBe(true);
    }
  });

  it('records attempt durations', async () => {
    const primary = createMockProvider('TwelveData', 'primary');
    const registry = new ProviderRegistry([primary]);
    const result = await registry.fetchWithFallback('EURUSD', '4H', '2024-06-15T08:00:00.000Z');

    expect(result.attempts[0]!.durationMs).toBeGreaterThanOrEqual(0);
  });
});

// =============================================================================
// Ingestion Service Tests
// =============================================================================

describe('IngestionService', () => {
  let mockSupabase: {
    from: ReturnType<typeof vi.fn>;
  };

  let mockInsert: ReturnType<typeof vi.fn>;
  let mockUpsert: ReturnType<typeof vi.fn>;
  let mockSelect: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    mockInsert = vi.fn().mockResolvedValue({ error: null });
    mockUpsert = vi.fn().mockResolvedValue({ error: null });
    mockSelect = vi.fn().mockReturnValue({
      eq: vi.fn().mockReturnValue({
        eq: vi.fn().mockReturnValue({
          eq: vi.fn().mockReturnValue({
            maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null }),
          }),
        }),
      }),
    });

    mockSupabase = {
      from: vi.fn().mockReturnValue({
        insert: mockInsert,
        upsert: mockUpsert,
        select: mockSelect,
      }),
    };
  });

  function createMockProvider(
    name: string,
    tier: 'primary' | 'fallback' | 'emergency',
    shouldFail: boolean = false,
    data?: RawCandleData
  ): DataProvider {
    return {
      name,
      tier,
      fetch: vi.fn().mockImplementation(async () => {
        if (shouldFail) throw new Error(`${name} failed`);
        return (
          data ?? {
            timestamp: '2024-06-15T08:00:00.000Z',
            open: 1.085,
            high: 1.092,
            low: 1.083,
            close: 1.09,
            volume: 1500,
          }
        );
      }),
    };
  }

  it('ingests a candle and stores it to raw_candles', async () => {
    const primary = createMockProvider('TwelveData', 'primary');
    const registry = new ProviderRegistry([primary]);
    const service = new IngestionService(registry, mockSupabase as any);

    const result = await service.ingest({
      asset: 'EURUSD',
      timeframe: '4H',
      candle_boundary: '2024-06-15T08:00:00.000Z',
    });

    expect(result).not.toBeNull();
    expect(result!.asset).toBe('EURUSD');
    expect(result!.timestamp_utc).toBe('2024-06-15T08:00:00.000Z');
    expect(result!.ohlc.open).toBe(1.085);
    expect(result!.ohlc.high).toBe(1.092);
    expect(result!.ohlc.low).toBe(1.083);
    expect(result!.ohlc.close).toBe(1.09);
    expect(result!.volume).toBe(1500);
    expect(result!.ingestion_time).toBeDefined();
    expect(mockSupabase.from).toHaveBeenCalledWith('raw_candles');
    expect(mockUpsert).toHaveBeenCalled();
  });

  it('snaps non-boundary timestamps to the grid', async () => {
    const primary = createMockProvider('TwelveData', 'primary');
    const registry = new ProviderRegistry([primary]);
    const service = new IngestionService(registry, mockSupabase as any);

    const result = await service.ingest({
      asset: 'EURUSD',
      timeframe: '4H',
      candle_boundary: '2024-06-15T09:30:00.000Z',
    });

    expect(result).not.toBeNull();
    expect(result!.timestamp_utc).toBe('2024-06-15T08:00:00.000Z');
  });

  it('returns null and logs gap when all providers fail', async () => {
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const primary = createMockProvider('TwelveData', 'primary', true);
    const fallback = createMockProvider('MassiveAPI', 'fallback', true);
    const emergency = createMockProvider('YahooFinance', 'emergency', true);

    const registry = new ProviderRegistry([primary, fallback, emergency]);
    const service = new IngestionService(registry, mockSupabase as any);

    const result = await service.ingest({
      asset: 'EURUSD',
      timeframe: '4H',
      candle_boundary: '2024-06-15T08:00:00.000Z',
    });

    expect(result).toBeNull();
    expect(consoleErrorSpy).toHaveBeenCalledWith(
      expect.stringContaining('DATA GAP'),
      expect.objectContaining({ asset: 'EURUSD', boundary: '2024-06-15T08:00:00.000Z' })
    );

    consoleErrorSpy.mockRestore();
  });

  it('handles Sunday candle by merging into Monday open', async () => {
    // 2024-06-16 is Sunday
    const sundayData: RawCandleData = {
      timestamp: '2024-06-16T20:00:00.000Z',
      open: 1.085,
      high: 1.092,
      low: 1.083,
      close: 1.09,
      volume: 1000,
    };

    const primary = createMockProvider('TwelveData', 'primary', false, sundayData);
    const registry = new ProviderRegistry([primary]);

    // Mock select to return no existing Monday candle
    const mockSelectChain = {
      eq: vi.fn().mockReturnValue({
        eq: vi.fn().mockReturnValue({
          eq: vi.fn().mockReturnValue({
            maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null }),
          }),
        }),
      }),
    };

    const mockFromFn = vi.fn().mockReturnValue({
      insert: mockInsert,
      upsert: mockUpsert,
      select: vi.fn().mockReturnValue(mockSelectChain),
    });

    const supabaseMock = { from: mockFromFn };

    const service = new IngestionService(registry, supabaseMock as any);

    const result = await service.ingest({
      asset: 'EURUSD',
      timeframe: '4H',
      candle_boundary: '2024-06-16T20:00:00.000Z',
    });

    expect(result).not.toBeNull();
    // Should be merged into Monday
    expect(result!.timestamp_utc).toBe('2024-06-17T00:00:00.000Z');
    expect(result!.ohlc.open).toBe(1.085);
  });

  it('uses fallback provider when primary fails', async () => {
    const primary = createMockProvider('TwelveData', 'primary', true);
    const fallback = createMockProvider('MassiveAPI', 'fallback', false, {
      timestamp: '2024-06-15T08:00:00.000Z',
      open: 1.086,
      high: 1.093,
      low: 1.084,
      close: 1.091,
      volume: 2000,
    });
    const registry = new ProviderRegistry([primary, fallback]);
    const service = new IngestionService(registry, mockSupabase as any);

    const result = await service.ingest({
      asset: 'EURUSD',
      timeframe: '4H',
      candle_boundary: '2024-06-15T08:00:00.000Z',
    });

    expect(result).not.toBeNull();
    expect(result!.ohlc.open).toBe(1.086);
    expect(result!.ohlc.close).toBe(1.091);
  });
});
