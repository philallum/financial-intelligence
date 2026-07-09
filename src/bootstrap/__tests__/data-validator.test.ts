import { describe, it, expect } from 'vitest';
import {
  checkOHLCInvariant,
  computeExpectedTimestamps,
  validateCandles,
} from '../data-validator.js';
import type { CandleRecord } from '../types.js';

describe('checkOHLCInvariant', () => {
  it('returns true for a valid candle where high >= max(open,close) and low <= min(open,close)', () => {
    const candle: CandleRecord = {
      timestamp_utc: '2020-01-06T00:00:00.000Z',
      open: 1.12,
      high: 1.15,
      low: 1.10,
      close: 1.13,
      volume: 1000,
    };
    expect(checkOHLCInvariant(candle)).toBe(true);
  });

  it('returns true when high equals max(open,close) and low equals min(open,close)', () => {
    const candle: CandleRecord = {
      timestamp_utc: '2020-01-06T04:00:00.000Z',
      open: 1.12,
      high: 1.13, // high == close == max(open,close)
      low: 1.12, // low == open == min(open,close)
      close: 1.13,
      volume: 500,
    };
    expect(checkOHLCInvariant(candle)).toBe(true);
  });

  it('returns false when high < max(open, close)', () => {
    const candle: CandleRecord = {
      timestamp_utc: '2020-01-06T08:00:00.000Z',
      open: 1.12,
      high: 1.11, // high < open
      low: 1.10,
      close: 1.13,
      volume: 200,
    };
    expect(checkOHLCInvariant(candle)).toBe(false);
  });

  it('returns false when low > min(open, close)', () => {
    const candle: CandleRecord = {
      timestamp_utc: '2020-01-06T12:00:00.000Z',
      open: 1.12,
      high: 1.15,
      low: 1.13, // low > open (min of open, close)
      close: 1.14,
      volume: 300,
    };
    expect(checkOHLCInvariant(candle)).toBe(false);
  });
});

describe('computeExpectedTimestamps', () => {
  it('generates 4H candle timestamps for a single Monday', () => {
    // Monday 2020-01-06
    const start = new Date('2020-01-06T00:00:00.000Z');
    const end = new Date('2020-01-06T20:00:00.000Z');
    const timestamps = computeExpectedTimestamps(start, end);

    expect(timestamps).toEqual([
      '2020-01-06T00:00:00.000Z',
      '2020-01-06T04:00:00.000Z',
      '2020-01-06T08:00:00.000Z',
      '2020-01-06T12:00:00.000Z',
      '2020-01-06T16:00:00.000Z',
      '2020-01-06T20:00:00.000Z',
    ]);
  });

  it('skips Saturday and Sunday', () => {
    // Friday 2020-01-10 20:00 to Monday 2020-01-13 00:00
    const start = new Date('2020-01-10T20:00:00.000Z');
    const end = new Date('2020-01-13T00:00:00.000Z');
    const timestamps = computeExpectedTimestamps(start, end);

    // Should include Friday 20:00 and Monday 00:00, no Saturday/Sunday
    expect(timestamps).toEqual([
      '2020-01-10T20:00:00.000Z',
      '2020-01-13T00:00:00.000Z',
    ]);
  });

  it('produces 30 candles for a complete trading week (Mon 00:00 to Fri 20:00)', () => {
    const start = new Date('2020-01-06T00:00:00.000Z'); // Monday
    const end = new Date('2020-01-10T20:00:00.000Z'); // Friday
    const timestamps = computeExpectedTimestamps(start, end);

    // 6 candles/day × 5 days = 30
    expect(timestamps).toHaveLength(30);
  });

  it('stops at Friday 20:00 and does not generate beyond', () => {
    // Friday 2020-01-10
    const start = new Date('2020-01-10T16:00:00.000Z');
    const end = new Date('2020-01-10T23:59:59.000Z');
    const timestamps = computeExpectedTimestamps(start, end);

    // Should only include 16:00 and 20:00 on Friday
    expect(timestamps).toEqual([
      '2020-01-10T16:00:00.000Z',
      '2020-01-10T20:00:00.000Z',
    ]);
  });

  it('returns empty array when start is on a weekend', () => {
    // Saturday 2020-01-11 to Sunday 2020-01-12
    const start = new Date('2020-01-11T00:00:00.000Z');
    const end = new Date('2020-01-12T20:00:00.000Z');
    const timestamps = computeExpectedTimestamps(start, end);

    expect(timestamps).toHaveLength(0);
  });
});

describe('validateCandles', () => {
  const validCandle = (timestamp: string): CandleRecord => ({
    timestamp_utc: timestamp,
    open: 1.12,
    high: 1.15,
    low: 1.10,
    close: 1.13,
    volume: 1000,
  });

  it('returns valid=true with no gaps when all expected candles are present', () => {
    // Single Monday, all 6 candles
    const candles: CandleRecord[] = [
      validCandle('2020-01-06T00:00:00.000Z'),
      validCandle('2020-01-06T04:00:00.000Z'),
      validCandle('2020-01-06T08:00:00.000Z'),
      validCandle('2020-01-06T12:00:00.000Z'),
      validCandle('2020-01-06T16:00:00.000Z'),
      validCandle('2020-01-06T20:00:00.000Z'),
    ];

    const result = validateCandles(candles, 'EURUSD');
    expect(result.valid).toBe(true);
    expect(result.totalCandles).toBe(6);
    expect(result.expectedCandles).toBe(6);
    expect(result.ohlcViolations).toHaveLength(0);
    expect(result.gaps).toHaveLength(0);
  });

  it('returns valid=false with violations when OHLC invariant is broken', () => {
    const candles: CandleRecord[] = [
      validCandle('2020-01-06T00:00:00.000Z'),
      {
        timestamp_utc: '2020-01-06T04:00:00.000Z',
        open: 1.12,
        high: 1.11, // violation: high < open
        low: 1.10,
        close: 1.13,
        volume: 500,
      },
    ];

    const result = validateCandles(candles, 'EURUSD');
    expect(result.valid).toBe(false);
    expect(result.ohlcViolations.length).toBeGreaterThan(0);
    expect(result.ohlcViolations[0].constraint).toBe('high < max(open,close)');
    expect(result.ohlcViolations[0].rowNumber).toBe(2);
  });

  it('returns valid=true with gaps when candles are missing', () => {
    // Missing the 04:00 and 08:00 candles
    const candles: CandleRecord[] = [
      validCandle('2020-01-06T00:00:00.000Z'),
      validCandle('2020-01-06T12:00:00.000Z'),
      validCandle('2020-01-06T16:00:00.000Z'),
      validCandle('2020-01-06T20:00:00.000Z'),
    ];

    const result = validateCandles(candles, 'EURUSD');
    expect(result.valid).toBe(true);
    expect(result.totalCandles).toBe(4);
    expect(result.expectedCandles).toBe(6);
    expect(result.gaps).toHaveLength(2);
    expect(result.gaps[0].expectedTimestamp).toBe('2020-01-06T04:00:00.000Z');
    expect(result.gaps[1].expectedTimestamp).toBe('2020-01-06T08:00:00.000Z');
  });

  it('reports at most 10 gaps', () => {
    // Full week but only provide first candle and last candle
    const candles: CandleRecord[] = [
      validCandle('2020-01-06T00:00:00.000Z'),
      validCandle('2020-01-10T20:00:00.000Z'),
    ];

    const result = validateCandles(candles, 'EURUSD');
    expect(result.valid).toBe(true);
    expect(result.gaps).toHaveLength(10); // capped at 10
    expect(result.expectedCandles).toBe(30);
  });

  it('handles empty records array gracefully', () => {
    const result = validateCandles([], 'EURUSD');
    expect(result.valid).toBe(true);
    expect(result.totalCandles).toBe(0);
    expect(result.expectedCandles).toBe(0);
    expect(result.gaps).toHaveLength(0);
  });
});
