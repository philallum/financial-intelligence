/**
 * Unit tests for csv-parser module.
 * Tests specific examples and edge cases for the CSV parsing pipeline.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  parseDukascopyTimestamp,
  isHeaderRow,
  formatCandleToCSV,
  parseDukascopyCSV,
} from '../csv-parser.js';
import type { CandleRecord } from '../types.js';

// ─── Helpers ─────────────────────────────────────────────────────────────────

function createTempDir(): string {
  const dir = join(tmpdir(), `csv-parser-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function writeTempCSV(dir: string, filename: string, content: string): string {
  const filePath = join(dir, filename);
  writeFileSync(filePath, content, 'utf-8');
  return filePath;
}

// ─── parseDukascopyTimestamp ─────────────────────────────────────────────────

describe('parseDukascopyTimestamp', () => {
  it('converts Dukascopy format to ISO 8601', () => {
    const result = parseDukascopyTimestamp('01.06.2020 08:00:00.000');
    expect(result).toBe('2020-06-01T08:00:00.000Z');
  });

  it('handles midnight correctly', () => {
    const result = parseDukascopyTimestamp('31.12.2021 00:00:00.000');
    expect(result).toBe('2021-12-31T00:00:00.000Z');
  });

  it('preserves milliseconds', () => {
    const result = parseDukascopyTimestamp('15.03.2022 12:30:45.123');
    expect(result).toBe('2022-03-15T12:30:45.123Z');
  });

  it('returns ISO 8601 timestamps unchanged', () => {
    const iso = '2020-06-01T08:00:00.000Z';
    expect(parseDukascopyTimestamp(iso)).toBe(iso);
  });

  it('returns ISO 8601 without Z unchanged', () => {
    const iso = '2020-06-01T08:00:00.000';
    expect(parseDukascopyTimestamp(iso)).toBe(iso);
  });

  it('throws on invalid format', () => {
    expect(() => parseDukascopyTimestamp('invalid')).toThrow('Invalid timestamp format');
  });
});

// ─── isHeaderRow ─────────────────────────────────────────────────────────────

describe('isHeaderRow', () => {
  it('detects header with text OHLC columns', () => {
    expect(isHeaderRow(['timestamp', 'open', 'high', 'low', 'close', 'volume'])).toBe(true);
  });

  it('detects header with uppercase labels', () => {
    expect(isHeaderRow(['Timestamp', 'Open', 'High', 'Low', 'Close', 'Volume'])).toBe(true);
  });

  it('returns false for numeric data rows', () => {
    expect(isHeaderRow(['01.06.2020 08:00:00.000', '1.1234', '1.1250', '1.1220', '1.1240', '1000'])).toBe(false);
  });

  it('returns false for rows with fewer than 5 fields', () => {
    expect(isHeaderRow(['just', 'three', 'fields'])).toBe(false);
  });

  it('returns false when only one OHLC column is non-numeric (malformed data, not header)', () => {
    expect(isHeaderRow(['ts', 'open', '1.5', '1.3', '1.4', '100'])).toBe(false);
  });

  it('detects header when all OHLC columns are non-numeric', () => {
    expect(isHeaderRow(['Date', 'Open', 'High', 'Low', 'Close', 'Vol'])).toBe(true);
  });
});

// ─── formatCandleToCSV ───────────────────────────────────────────────────────

describe('formatCandleToCSV', () => {
  it('formats a CandleRecord to Dukascopy CSV line', () => {
    const record: CandleRecord = {
      timestamp_utc: '2020-06-01T08:00:00.000Z',
      open: 1.1234,
      high: 1.125,
      low: 1.122,
      close: 1.124,
      volume: 1000,
    };

    const result = formatCandleToCSV(record);
    expect(result).toBe('01.06.2020 08:00:00.000,1.1234,1.125,1.122,1.124,1000');
  });

  it('handles volume of 0', () => {
    const record: CandleRecord = {
      timestamp_utc: '2021-01-04T00:00:00.000Z',
      open: 1.5,
      high: 1.6,
      low: 1.4,
      close: 1.55,
      volume: 0,
    };

    const result = formatCandleToCSV(record);
    expect(result).toContain(',0');
  });
});

// ─── parseDukascopyCSV ───────────────────────────────────────────────────────

describe('parseDukascopyCSV', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = createTempDir();
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('parses a valid Dukascopy CSV file', () => {
    const csv = [
      '01.06.2020 08:00:00.000,1.1234,1.1250,1.1220,1.1240,1000',
      '01.06.2020 12:00:00.000,1.1240,1.1260,1.1230,1.1255,1200',
    ].join('\n');

    const filePath = writeTempCSV(tempDir, 'valid.csv', csv);
    const records = parseDukascopyCSV(filePath);

    expect(records).toHaveLength(2);
    expect(records[0].timestamp_utc).toBe('2020-06-01T08:00:00.000Z');
    expect(records[0].open).toBe(1.1234);
    expect(records[0].high).toBe(1.125);
    expect(records[0].low).toBe(1.122);
    expect(records[0].close).toBe(1.124);
    expect(records[0].volume).toBe(1000);
  });

  it('auto-detects and skips header row', () => {
    const csv = [
      'timestamp,open,high,low,close,volume',
      '01.06.2020 08:00:00.000,1.1234,1.1250,1.1220,1.1240,1000',
    ].join('\n');

    const filePath = writeTempCSV(tempDir, 'with-header.csv', csv);
    const records = parseDukascopyCSV(filePath);

    expect(records).toHaveLength(1);
    expect(records[0].open).toBe(1.1234);
  });

  it('handles ISO 8601 timestamps', () => {
    const csv = '2020-06-01T08:00:00.000Z,1.1234,1.1250,1.1220,1.1240,1000\n';

    const filePath = writeTempCSV(tempDir, 'iso.csv', csv);
    const records = parseDukascopyCSV(filePath);

    expect(records).toHaveLength(1);
    expect(records[0].timestamp_utc).toBe('2020-06-01T08:00:00.000Z');
  });

  it('throws on missing file', () => {
    expect(() => parseDukascopyCSV('/nonexistent/path.csv')).toThrow('File not found');
  });

  it('throws on empty file', () => {
    const filePath = writeTempCSV(tempDir, 'empty.csv', '');
    expect(() => parseDukascopyCSV(filePath)).toThrow('Empty file');
  });

  it('throws on file with only headers', () => {
    const csv = 'timestamp,open,high,low,close,volume\n';
    const filePath = writeTempCSV(tempDir, 'headers-only.csv', csv);
    expect(() => parseDukascopyCSV(filePath)).toThrow('no data rows');
  });

  it('throws on non-numeric OHLCV values with row and column info', () => {
    const csv = [
      '01.06.2020 08:00:00.000,1.1234,abc,1.1220,1.1240,1000',
    ].join('\n');

    const filePath = writeTempCSV(tempDir, 'bad-value.csv', csv);

    expect(() => parseDukascopyCSV(filePath)).toThrow(/row 1.*column "high"/i);
  });

  it('identifies correct column name in error', () => {
    const csv = [
      '01.06.2020 08:00:00.000,1.1234,1.1250,1.1220,1.1240,bad',
    ].join('\n');

    const filePath = writeTempCSV(tempDir, 'bad-volume.csv', csv);

    expect(() => parseDukascopyCSV(filePath)).toThrow(/column "volume"/i);
  });

  it('handles Windows-style line endings', () => {
    const csv = '01.06.2020 08:00:00.000,1.1234,1.1250,1.1220,1.1240,1000\r\n01.06.2020 12:00:00.000,1.1240,1.1260,1.1230,1.1255,1200\r\n';

    const filePath = writeTempCSV(tempDir, 'crlf.csv', csv);
    const records = parseDukascopyCSV(filePath);

    expect(records).toHaveLength(2);
  });
});
