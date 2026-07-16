/**
 * Dukascopy CSV Parser
 *
 * Parses Dukascopy-exported CSV files containing historical OHLC candle data
 * into structured CandleRecord arrays. Handles both Dukascopy timestamp format
 * ("DD.MM.YYYY HH:MM:SS.000") and ISO 8601 timestamps.
 *
 * @module csv-parser
 */

import { readFileSync, existsSync } from 'node:fs';
import type { CandleRecord } from './types.js';

/**
 * Parse a Dukascopy timestamp ("DD.MM.YYYY HH:MM:SS.000") into an ISO 8601 string.
 * Also handles Hitsdata format ("YYYY-MM-DD HH:MM") and full ISO 8601 timestamps.
 */
export function parseDukascopyTimestamp(raw: string): string {
  const trimmed = raw.trim();

  // Check if already a full ISO 8601 timestamp (with T separator or timezone)
  if (/^\d{4}-\d{2}-\d{2}T/.test(trimmed)) {
    return trimmed;
  }

  // Hitsdata format: "YYYY-MM-DD HH:MM" (no seconds) — parse explicitly as UTC
  const hitsdataMatch = trimmed.match(
    /^(\d{4})-(\d{2})-(\d{2})\s+(\d{2}):(\d{2})$/
  );
  if (hitsdataMatch) {
    const [, year, month, day, hours, minutes] = hitsdataMatch;
    const date = new Date(
      Date.UTC(Number(year), Number(month) - 1, Number(day), Number(hours), Number(minutes), 0, 0)
    );
    return date.toISOString();
  }

  // Hitsdata/generic format: "YYYY-MM-DD HH:MM:SS" (with seconds, no millis) — parse as UTC
  const isoLikeMatch = trimmed.match(
    /^(\d{4})-(\d{2})-(\d{2})\s+(\d{2}):(\d{2}):(\d{2})$/
  );
  if (isoLikeMatch) {
    const [, year, month, day, hours, minutes, seconds] = isoLikeMatch;
    const date = new Date(
      Date.UTC(Number(year), Number(month) - 1, Number(day), Number(hours), Number(minutes), Number(seconds), 0)
    );
    return date.toISOString();
  }

  // Dukascopy format: "DD.MM.YYYY HH:MM:SS.mmm"
  const match = trimmed.match(
    /^(\d{2})\.(\d{2})\.(\d{4})\s+(\d{2}):(\d{2}):(\d{2})\.(\d{3})$/
  );

  if (!match) {
    throw new Error(
      `Invalid timestamp format: "${raw}". Expected "DD.MM.YYYY HH:MM:SS.000" or ISO 8601.`
    );
  }

  const [, day, month, year, hours, minutes, seconds, millis] = match;
  const date = new Date(
    Date.UTC(
      Number(year),
      Number(month) - 1,
      Number(day),
      Number(hours),
      Number(minutes),
      Number(seconds),
      Number(millis)
    )
  );

  return date.toISOString();
}

/**
 * Detect whether a CSV row is a header by checking if the OHLC columns
 * (indices 1–4) contain non-numeric values.
 *
 * A row is considered a header if ALL four OHLC columns are non-numeric.
 * This distinguishes headers (e.g., "open,high,low,close") from data rows
 * with a single bad value (which should be reported as an error).
 */
export function isHeaderRow(fields: string[]): boolean {
  if (fields.length < 5) {
    return false;
  }

  // A header row has ALL OHLC columns as non-numeric
  for (let i = 1; i <= 4; i++) {
    const value = fields[i].trim();
    if (value !== '' && !isNaN(Number(value))) {
      return false;
    }
  }

  return true;
}

/**
 * Format a CandleRecord back to a Dukascopy-style CSV line for round-trip testing.
 * Output format: "DD.MM.YYYY HH:MM:SS.000,open,high,low,close,volume"
 */
export function formatCandleToCSV(record: CandleRecord): string {
  const date = new Date(record.timestamp_utc);

  const day = String(date.getUTCDate()).padStart(2, '0');
  const month = String(date.getUTCMonth() + 1).padStart(2, '0');
  const year = date.getUTCFullYear();
  const hours = String(date.getUTCHours()).padStart(2, '0');
  const minutes = String(date.getUTCMinutes()).padStart(2, '0');
  const seconds = String(date.getUTCSeconds()).padStart(2, '0');
  const millis = String(date.getUTCMilliseconds()).padStart(3, '0');

  const timestamp = `${day}.${month}.${year} ${hours}:${minutes}:${seconds}.${millis}`;

  return `${timestamp},${record.open},${record.high},${record.low},${record.close},${record.volume}`;
}

/**
 * Parse a Dukascopy CSV file into structured candle records.
 *
 * Handles both "DD.MM.YYYY HH:MM:SS.000" and ISO 8601 timestamp formats.
 * Auto-detects and skips header rows.
 *
 * @throws Error if file does not exist
 * @throws Error if file contains zero data rows
 * @throws Error if any row contains non-numeric OHLCV values (identifies row number and column)
 */
export function parseDukascopyCSV(filePath: string): CandleRecord[] {
  // Check file existence
  if (!existsSync(filePath)) {
    throw new Error(`File not found: "${filePath}". Please provide a valid CSV file path.`);
  }

  // Read file content
  const content = readFileSync(filePath, 'utf-8');

  // Split into lines, filter out empty trailing lines
  const lines = content.split(/\r?\n/).filter((line) => line.trim() !== '');

  if (lines.length === 0) {
    throw new Error(
      `Empty file: "${filePath}" contains no data rows. Please provide a CSV file with candle data.`
    );
  }

  const records: CandleRecord[] = [];
  const columnNames = ['open', 'high', 'low', 'close', 'volume'];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const fields = line.split(',');

    // Skip header rows
    if (isHeaderRow(fields)) {
      continue;
    }

    // We expect at least 6 fields: timestamp, open, high, low, close, volume
    if (fields.length < 6) {
      throw new Error(
        `Invalid row at line ${i + 1}: expected at least 6 columns, got ${fields.length}.`
      );
    }

    const rowNumber = i + 1;

    // Parse OHLCV values with validation
    const ohlcv: number[] = [];
    for (let col = 1; col <= 5; col++) {
      const raw = fields[col].trim();
      const value = Number(raw);

      if (raw === '' || isNaN(value)) {
        throw new Error(
          `Non-numeric value at row ${rowNumber}, column "${columnNames[col - 1]}": "${raw}". All OHLCV values must be numeric.`
        );
      }

      ohlcv.push(value);
    }

    // Parse timestamp
    const timestamp = parseDukascopyTimestamp(fields[0]);

    records.push({
      timestamp_utc: timestamp,
      open: ohlcv[0],
      high: ohlcv[1],
      low: ohlcv[2],
      close: ohlcv[3],
      volume: ohlcv[4],
    });
  }

  // Verify we have at least one data row
  if (records.length === 0) {
    throw new Error(
      `Empty file: "${filePath}" contains no data rows (only headers). Please provide a CSV file with candle data.`
    );
  }

  return records;
}
