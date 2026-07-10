import { describe, it, expect, vi } from 'vitest';
import { generateExpectedGrid, detectGaps } from '../gap-detector.js';
import type { GapDetectionInput } from '../types.js';
import type { ResearchAsset } from '../../../config/research-assets.js';
import { AssetClass, AssetStatus } from '../../../config/research-assets.js';

// ─── generateExpectedGrid Tests ──────────────────────────────────────────────

describe('generateExpectedGrid', () => {
  describe('basic grid generation', () => {
    it('generates 6 timestamps per full day for 24x7 assets', () => {
      const start = new Date('2024-01-15T00:00:00.000Z'); // Monday
      const end = new Date('2024-01-15T20:00:00.000Z');
      const grid = generateExpectedGrid(start, end, '24x7');

      expect(grid).toEqual([
        '2024-01-15T00:00:00.000Z',
        '2024-01-15T04:00:00.000Z',
        '2024-01-15T08:00:00.000Z',
        '2024-01-15T12:00:00.000Z',
        '2024-01-15T16:00:00.000Z',
        '2024-01-15T20:00:00.000Z',
      ]);
    });

    it('produces timestamps only on 4H boundaries', () => {
      const start = new Date('2024-01-15T00:00:00.000Z');
      const end = new Date('2024-01-16T20:00:00.000Z');
      const grid = generateExpectedGrid(start, end, '24x7');

      for (const ts of grid) {
        const date = new Date(ts);
        expect(date.getUTCHours() % 4).toBe(0);
        expect(date.getUTCMinutes()).toBe(0);
        expect(date.getUTCSeconds()).toBe(0);
      }
    });

    it('snaps startTime to next 4H boundary when not aligned', () => {
      const start = new Date('2024-01-15T01:30:00.000Z');
      const end = new Date('2024-01-15T08:00:00.000Z');
      const grid = generateExpectedGrid(start, end, '24x7');

      expect(grid[0]).toBe('2024-01-15T04:00:00.000Z');
    });

    it('includes endTime when it falls on a grid boundary', () => {
      const start = new Date('2024-01-15T16:00:00.000Z');
      const end = new Date('2024-01-15T20:00:00.000Z');
      const grid = generateExpectedGrid(start, end, '24x7');

      expect(grid).toContain('2024-01-15T20:00:00.000Z');
    });

    it('returns empty array when startTime is after endTime', () => {
      const start = new Date('2024-01-16T00:00:00.000Z');
      const end = new Date('2024-01-15T20:00:00.000Z');
      const grid = generateExpectedGrid(start, end, '24x7');

      expect(grid).toEqual([]);
    });

    it('returns single timestamp when start equals end on grid boundary', () => {
      const start = new Date('2024-01-15T08:00:00.000Z');
      const end = new Date('2024-01-15T08:00:00.000Z');
      const grid = generateExpectedGrid(start, end, '24x7');

      expect(grid).toEqual(['2024-01-15T08:00:00.000Z']);
    });
  });

  describe('24x5 weekend exclusion', () => {
    it('excludes Saturday timestamps for 24x5 assets', () => {
      // Saturday 2024-01-13
      const start = new Date('2024-01-13T00:00:00.000Z');
      const end = new Date('2024-01-13T20:00:00.000Z');
      const grid = generateExpectedGrid(start, end, '24x5');

      expect(grid).toEqual([]);
    });

    it('excludes Sunday timestamps before 21:00 UTC for 24x5 assets', () => {
      // Sunday 2024-01-14
      const start = new Date('2024-01-14T00:00:00.000Z');
      const end = new Date('2024-01-14T20:00:00.000Z');
      const grid = generateExpectedGrid(start, end, '24x5');

      expect(grid).toEqual([]);
    });

    it('includes Friday 20:00 UTC (last valid slot before weekend)', () => {
      // Friday 2024-01-12
      const start = new Date('2024-01-12T16:00:00.000Z');
      const end = new Date('2024-01-12T20:00:00.000Z');
      const grid = generateExpectedGrid(start, end, '24x5');

      expect(grid).toContain('2024-01-12T20:00:00.000Z');
    });

    it('includes Monday 00:00 UTC (first valid slot after weekend)', () => {
      // Monday 2024-01-15
      const start = new Date('2024-01-14T20:00:00.000Z');
      const end = new Date('2024-01-15T04:00:00.000Z');
      const grid = generateExpectedGrid(start, end, '24x5');

      expect(grid).toContain('2024-01-15T00:00:00.000Z');
    });

    it('spans a full weekend correctly for 24x5', () => {
      // Friday 20:00 through Monday 00:00
      const start = new Date('2024-01-12T20:00:00.000Z'); // Friday
      const end = new Date('2024-01-15T00:00:00.000Z'); // Monday
      const grid = generateExpectedGrid(start, end, '24x5');

      // Only Friday 20:00 and Monday 00:00 should be present
      expect(grid).toEqual([
        '2024-01-12T20:00:00.000Z',
        '2024-01-15T00:00:00.000Z',
      ]);
    });

    it('does not exclude weekends for 24x7 assets', () => {
      // Saturday 2024-01-13
      const start = new Date('2024-01-13T00:00:00.000Z');
      const end = new Date('2024-01-13T20:00:00.000Z');
      const grid = generateExpectedGrid(start, end, '24x7');

      expect(grid.length).toBe(6);
    });
  });

  describe('72-hour lookback scenarios', () => {
    it('generates correct grid for a 72h window on a weekday (24x7)', () => {
      const end = new Date('2024-01-17T00:00:00.000Z'); // Wednesday
      const start = new Date(end.getTime() - 72 * 60 * 60 * 1000); // Sunday
      const grid = generateExpectedGrid(start, end, '24x7');

      // 3 full days = 18 slots + 1 for the end boundary
      expect(grid.length).toBe(19);
    });

    it('generates fewer timestamps for 24x5 when window includes weekend', () => {
      const end = new Date('2024-01-15T00:00:00.000Z'); // Monday 00:00
      const start = new Date(end.getTime() - 72 * 60 * 60 * 1000); // Friday 00:00
      const grid24x5 = generateExpectedGrid(start, end, '24x5');
      const grid24x7 = generateExpectedGrid(start, end, '24x7');

      expect(grid24x5.length).toBeLessThan(grid24x7.length);
    });
  });
});

// ─── detectGaps Tests ────────────────────────────────────────────────────────

describe('detectGaps', () => {
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

  function createMockSupabase(timestamps: string[]) {
    const data = timestamps.map(ts => ({ timestamp_utc: ts }));
    const mockQuery = {
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      gte: vi.fn().mockReturnThis(),
      lte: vi.fn().mockReturnThis(),
      order: vi.fn().mockReturnThis(),
      range: vi.fn().mockResolvedValue({ data, error: null }),
    };
    return { from: vi.fn().mockReturnValue(mockQuery) } as any;
  }

  it('returns missing timestamps when some candles exist', async () => {
    const referenceTime = new Date('2024-01-15T12:00:00.000Z'); // Monday
    const asset = makeAsset({ marketHours: '24x7' });

    // Simulate existing candles: only 00:00 and 08:00 exist in the last 12 hours
    const existing = [
      '2024-01-15T00:00:00.000Z',
      '2024-01-15T08:00:00.000Z',
    ];
    const supabase = createMockSupabase(existing);

    const input: GapDetectionInput = {
      asset,
      timeframe: '4H',
      lookbackHours: 12,
      referenceTime,
    };

    const result = await detectGaps(supabase, input);

    expect(result.missingTimestamps).toContain('2024-01-15T04:00:00.000Z');
    expect(result.missingTimestamps).toContain('2024-01-15T12:00:00.000Z');
    expect(result.missingTimestamps).not.toContain('2024-01-15T00:00:00.000Z');
    expect(result.missingTimestamps).not.toContain('2024-01-15T08:00:00.000Z');
    expect(result.asset).toBe('EURUSD');
    expect(result.timeframe).toBe('4H');
  });

  it('returns empty missingTimestamps when all candles exist', async () => {
    // Use a 12h lookback so the window is 08:00–20:00 on the same day
    const referenceTime = new Date('2024-01-15T20:00:00.000Z'); // Monday
    const asset = makeAsset({ marketHours: '24x7' });

    // Expected grid for 08:00–20:00: 08:00, 12:00, 16:00, 20:00
    const existing = [
      '2024-01-15T08:00:00.000Z',
      '2024-01-15T12:00:00.000Z',
      '2024-01-15T16:00:00.000Z',
      '2024-01-15T20:00:00.000Z',
    ];
    const supabase = createMockSupabase(existing);

    const input: GapDetectionInput = {
      asset,
      timeframe: '4H',
      lookbackHours: 12,
      referenceTime,
    };

    const result = await detectGaps(supabase, input);

    expect(result.missingTimestamps).toEqual([]);
    expect(result.existingCount).toBe(4);
  });

  it('returns all expected timestamps when table is empty', async () => {
    const referenceTime = new Date('2024-01-15T20:00:00.000Z');
    const asset = makeAsset({ marketHours: '24x7' });

    const supabase = createMockSupabase([]);

    const input: GapDetectionInput = {
      asset,
      timeframe: '4H',
      lookbackHours: 24,
      referenceTime,
    };

    const result = await detectGaps(supabase, input);

    expect(result.missingTimestamps.length).toBeGreaterThan(0);
    expect(result.existingCount).toBe(0);
    expect(result.expectedCount).toBe(result.missingTimestamps.length);
  });

  it('results are sorted ascending', async () => {
    const referenceTime = new Date('2024-01-15T20:00:00.000Z');
    const asset = makeAsset({ marketHours: '24x7' });

    const supabase = createMockSupabase([]);

    const input: GapDetectionInput = {
      asset,
      timeframe: '4H',
      lookbackHours: 48,
      referenceTime,
    };

    const result = await detectGaps(supabase, input);

    for (let i = 1; i < result.missingTimestamps.length; i++) {
      expect(
        new Date(result.missingTimestamps[i]).getTime()
      ).toBeGreaterThan(
        new Date(result.missingTimestamps[i - 1]).getTime()
      );
    }
  });

  it('throws when supabase query fails', async () => {
    const referenceTime = new Date('2024-01-15T12:00:00.000Z');
    const asset = makeAsset();

    const mockQuery = {
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      gte: vi.fn().mockReturnThis(),
      lte: vi.fn().mockReturnThis(),
      order: vi.fn().mockReturnThis(),
      range: vi.fn().mockResolvedValue({
        data: null,
        error: { message: 'connection refused' },
      }),
    };
    const supabase = { from: vi.fn().mockReturnValue(mockQuery) } as any;

    const input: GapDetectionInput = {
      asset,
      timeframe: '4H',
      lookbackHours: 12,
      referenceTime,
    };

    await expect(detectGaps(supabase, input)).rejects.toThrow('connection refused');
  });

  it('reports correct counts', async () => {
    const referenceTime = new Date('2024-01-15T20:00:00.000Z');
    const asset = makeAsset({ marketHours: '24x7' });

    const existing = [
      '2024-01-15T00:00:00.000Z',
      '2024-01-15T04:00:00.000Z',
      '2024-01-15T12:00:00.000Z',
    ];
    const supabase = createMockSupabase(existing);

    const input: GapDetectionInput = {
      asset,
      timeframe: '4H',
      lookbackHours: 24,
      referenceTime,
    };

    const result = await detectGaps(supabase, input);

    expect(result.existingCount).toBe(3);
    expect(result.expectedCount).toBeGreaterThan(3);
    expect(result.missingTimestamps.length).toBe(result.expectedCount - result.existingCount);
  });
});
