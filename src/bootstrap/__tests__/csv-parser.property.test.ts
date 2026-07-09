import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';
import { writeFileSync, unlinkSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  parseDukascopyTimestamp,
  isHeaderRow,
  formatCandleToCSV,
  parseDukascopyCSV,
} from '../csv-parser.js';
import type { CandleRecord } from '../types.js';

// ─── Shared Generators ──────────────────────────────────────────────────────

/** Generate a positive finite number suitable for OHLCV values */
function arbPositiveNumber(): fc.Arbitrary<number> {
  return fc.double({ min: 0.00001, max: 999999, noNaN: true, noDefaultInfinity: true });
}

/** Generate a valid CandleRecord with positive OHLCV and valid ISO timestamp */
function arbCandleRecord(): fc.Arbitrary<CandleRecord> {
  return fc
    .record({
      year: fc.integer({ min: 2000, max: 2030 }),
      month: fc.integer({ min: 1, max: 12 }),
      day: fc.integer({ min: 1, max: 28 }),
      hour: fc.integer({ min: 0, max: 23 }),
      minute: fc.integer({ min: 0, max: 59 }),
      second: fc.integer({ min: 0, max: 59 }),
      millis: fc.integer({ min: 0, max: 999 }),
      open: arbPositiveNumber(),
      high: arbPositiveNumber(),
      low: arbPositiveNumber(),
      close: arbPositiveNumber(),
      volume: arbPositiveNumber(),
    })
    .map(({ year, month, day, hour, minute, second, millis, open, high, low, close, volume }) => {
      const date = new Date(Date.UTC(year, month - 1, day, hour, minute, second, millis));
      return {
        timestamp_utc: date.toISOString(),
        open,
        high,
        low,
        close,
        volume,
      };
    });
}

/** Generate valid date components for timestamp testing */
function arbDateComponents() {
  return fc.record({
    year: fc.integer({ min: 2000, max: 2030 }),
    month: fc.integer({ min: 1, max: 12 }),
    day: fc.integer({ min: 1, max: 28 }),
    hour: fc.integer({ min: 0, max: 23 }),
    minute: fc.integer({ min: 0, max: 59 }),
    second: fc.integer({ min: 0, max: 59 }),
    millis: fc.integer({ min: 0, max: 999 }),
  });
}

/** Generate a non-numeric string (alphabetic characters) */
function arbNonNumericString(): fc.Arbitrary<string> {
  return fc.stringMatching(/^[a-zA-Z]{1,10}$/);
}

/** Helper: write CSV content to a temp file and return the path */
function writeTempCSV(content: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'csv-parser-test-'));
  const filePath = join(dir, 'test.csv');
  writeFileSync(filePath, content, 'utf-8');
  return filePath;
}

/** Helper: clean up a temp file */
function cleanupTempFile(filePath: string): void {
  try {
    unlinkSync(filePath);
  } catch {
    // ignore cleanup errors
  }
}

// ─── Property 1: CSV Round-Trip ─────────────────────────────────────────────

// Feature: historical-data-bootstrap, Property 1: CSV Round-Trip
/**
 * For any valid CandleRecord, formatCandleToCSV then re-parsing produces
 * equivalent record.
 *
 * **Validates: Requirements 1.1, 1.8**
 */
describe('Property 1: CSV Round-Trip', () => {
  it('formatCandleToCSV then parseDukascopyCSV produces equivalent record', () => {
    fc.assert(
      fc.property(arbCandleRecord(), (record: CandleRecord) => {
        // Format the record to CSV
        const csvLine = formatCandleToCSV(record);

        // Write to a temp file and parse it back
        const filePath = writeTempCSV(csvLine);
        try {
          const parsed = parseDukascopyCSV(filePath);

          expect(parsed).toHaveLength(1);
          const result = parsed[0];

          // Timestamps should represent the same instant
          expect(new Date(result.timestamp_utc).getTime()).toBe(
            new Date(record.timestamp_utc).getTime(),
          );

          // OHLCV values should be equivalent within floating-point precision
          expect(result.open).toBeCloseTo(record.open, 10);
          expect(result.high).toBeCloseTo(record.high, 10);
          expect(result.low).toBeCloseTo(record.low, 10);
          expect(result.close).toBeCloseTo(record.close, 10);
          expect(result.volume).toBeCloseTo(record.volume, 10);
        } finally {
          cleanupTempFile(filePath);
        }
      }),
      { numRuns: 100 },
    );
  });
});

// ─── Property 2: Timestamp Parsing Correctness ──────────────────────────────

// Feature: historical-data-bootstrap, Property 2: Timestamp Parsing Correctness
/**
 * Dukascopy timestamp → ISO 8601 represents same instant; ISO 8601 input is idempotent.
 *
 * **Validates: Requirements 1.2, 1.3**
 */
describe('Property 2: Timestamp Parsing Correctness', () => {
  it('Dukascopy timestamp parsed to ISO 8601 represents the same instant', () => {
    fc.assert(
      fc.property(arbDateComponents(), ({ year, month, day, hour, minute, second, millis }) => {
        // Format as Dukascopy timestamp: "DD.MM.YYYY HH:MM:SS.mmm"
        const dd = String(day).padStart(2, '0');
        const mm = String(month).padStart(2, '0');
        const hh = String(hour).padStart(2, '0');
        const min = String(minute).padStart(2, '0');
        const ss = String(second).padStart(2, '0');
        const ms = String(millis).padStart(3, '0');
        const dukascopyTimestamp = `${dd}.${mm}.${year} ${hh}:${min}:${ss}.${ms}`;

        // Parse with parseDukascopyTimestamp
        const isoResult = parseDukascopyTimestamp(dukascopyTimestamp);

        // Verify the ISO result represents the same instant
        const expectedDate = new Date(
          Date.UTC(year, month - 1, day, hour, minute, second, millis),
        );
        const parsedDate = new Date(isoResult);

        expect(parsedDate.getTime()).toBe(expectedDate.getTime());
      }),
      { numRuns: 100 },
    );
  });

  it('ISO 8601 input is idempotent (passes through unchanged)', () => {
    fc.assert(
      fc.property(arbDateComponents(), ({ year, month, day, hour, minute, second, millis }) => {
        // Create an ISO 8601 timestamp
        const date = new Date(Date.UTC(year, month - 1, day, hour, minute, second, millis));
        const isoInput = date.toISOString();

        // Pass through parseDukascopyTimestamp
        const result = parseDukascopyTimestamp(isoInput);

        // Output should be identical to input
        expect(result).toBe(isoInput);
      }),
      { numRuns: 100 },
    );
  });
});

// ─── Property 3: Non-Numeric Value Rejection ────────────────────────────────

// Feature: historical-data-bootstrap, Property 3: Non-Numeric Value Rejection
/**
 * Any row with non-numeric OHLCV column is rejected with correct row/column identification.
 *
 * **Validates: Requirements 1.5**
 */
describe('Property 3: Non-Numeric Value Rejection', () => {
  it('a row with a non-numeric OHLCV column throws error identifying row number and column name', () => {
    const columnNames = ['open', 'high', 'low', 'close', 'volume'];

    fc.assert(
      fc.property(
        arbCandleRecord(),
        fc.integer({ min: 1, max: 5 }), // column index to corrupt (1=open, 2=high, 3=low, 4=close, 5=volume)
        arbNonNumericString(),
        (record: CandleRecord, colIndex: number, badValue: string) => {
          // Format the valid record to CSV
          const csvLine = formatCandleToCSV(record);
          const fields = csvLine.split(',');

          // Replace one OHLCV column with the non-numeric string
          fields[colIndex] = badValue;
          const corruptedLine = fields.join(',');

          // Write to a temp file
          const filePath = writeTempCSV(corruptedLine);
          try {
            // Attempt to parse — should throw
            expect(() => parseDukascopyCSV(filePath)).toThrow();

            try {
              parseDukascopyCSV(filePath);
            } catch (error: unknown) {
              const message = (error as Error).message;
              // Error should contain the row number
              expect(message).toContain('row 1');
              // Error should contain the correct column name
              expect(message).toContain(columnNames[colIndex - 1]);
            }
          } finally {
            cleanupTempFile(filePath);
          }
        },
      ),
      { numRuns: 100 },
    );
  });
});

// ─── Property 4: Header Row Detection ───────────────────────────────────────

// Feature: historical-data-bootstrap, Property 4: Header Row Detection
/**
 * Rows with non-numeric OHLC columns detected as headers; rows with numeric OHLC are not.
 *
 * **Validates: Requirements 1.7**
 */
describe('Property 4: Header Row Detection', () => {
  it('rows where ALL OHLC columns (indices 1-4) are non-numeric are detected as headers', () => {
    fc.assert(
      fc.property(
        arbNonNumericString(), // timestamp field (irrelevant)
        arbNonNumericString(), // open (non-numeric)
        arbNonNumericString(), // high (non-numeric)
        arbNonNumericString(), // low (non-numeric)
        arbNonNumericString(), // close (non-numeric)
        fc.string({ minLength: 1, maxLength: 10 }), // volume (can be anything for header detection since we only check 1-4)
        (timestamp, open, high, low, close, volume) => {
          const fields = [timestamp, open, high, low, close, volume];
          expect(isHeaderRow(fields)).toBe(true);
        },
      ),
      { numRuns: 100 },
    );
  });

  it('rows where ALL OHLC columns (indices 1-4) are valid numeric strings are NOT headers', () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 1, maxLength: 20 }), // timestamp field (irrelevant)
        fc.double({ min: 0.001, max: 999999, noNaN: true, noDefaultInfinity: true }),
        fc.double({ min: 0.001, max: 999999, noNaN: true, noDefaultInfinity: true }),
        fc.double({ min: 0.001, max: 999999, noNaN: true, noDefaultInfinity: true }),
        fc.double({ min: 0.001, max: 999999, noNaN: true, noDefaultInfinity: true }),
        fc.string({ minLength: 1, maxLength: 10 }), // volume (irrelevant for header detection)
        (timestamp, open, high, low, close, volume) => {
          const fields = [timestamp, String(open), String(high), String(low), String(close), volume];
          expect(isHeaderRow(fields)).toBe(false);
        },
      ),
      { numRuns: 100 },
    );
  });
});
