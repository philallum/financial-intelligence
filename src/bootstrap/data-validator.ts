/**
 * Data Validator for the historical data bootstrap pipeline.
 *
 * Validates candle records before database insertion by checking OHLC invariants
 * and detecting gaps in the expected forex 4H trading schedule.
 *
 * - OHLC violations abort the import (valid=false)
 * - Gaps produce warnings only (valid=true with gap info)
 */

import type {
  CandleRecord,
  ValidationResult,
  OHLCViolation,
  GapInfo,
} from './types.js';

/**
 * Check a single candle satisfies the OHLC invariant:
 *   high >= max(open, close) AND low <= min(open, close)
 *
 * @returns true if the invariant holds, false otherwise
 */
export function checkOHLCInvariant(candle: CandleRecord): boolean {
  return (
    candle.high >= Math.max(candle.open, candle.close) &&
    candle.low <= Math.min(candle.open, candle.close)
  );
}

/**
 * Compute expected 4H candle timestamps for forex trading hours.
 *
 * Forex hours are 24x5: Monday 00:00 UTC through Friday 20:00 UTC.
 * 4H candles occur at: 00:00, 04:00, 08:00, 12:00, 16:00, 20:00.
 * Saturday and Sunday are entirely skipped.
 *
 * @param start - Start of the date range (inclusive)
 * @param end - End of the date range (inclusive)
 * @returns Array of ISO 8601 timestamp strings for expected candles
 */
export function computeExpectedTimestamps(start: Date, end: Date): string[] {
  const timestamps: string[] = [];
  const current = new Date(start.getTime());

  // Normalize to the nearest 4H boundary at or after start
  current.setUTCMinutes(0, 0, 0);
  const hour = current.getUTCHours();
  const remainder = hour % 4;
  if (remainder !== 0) {
    current.setUTCHours(hour + (4 - remainder));
  }

  while (current <= end) {
    const dayOfWeek = current.getUTCDay(); // 0=Sun, 1=Mon, ..., 6=Sat

    if (dayOfWeek >= 1 && dayOfWeek <= 5) {
      // Monday through Friday
      if (dayOfWeek === 5) {
        // Friday: only up to 20:00 UTC
        if (current.getUTCHours() <= 20) {
          timestamps.push(current.toISOString());
        }
      } else {
        // Monday through Thursday: all 4H slots (00:00–20:00)
        timestamps.push(current.toISOString());
      }
    }

    // Advance by 4 hours
    current.setTime(current.getTime() + 4 * 60 * 60 * 1000);
  }

  return timestamps;
}

/**
 * Validate an array of candle records.
 *
 * 1. Checks OHLC invariants for all candles. If ANY violation found,
 *    sets valid=false and returns immediately with violations listed.
 * 2. If all pass OHLC check, computes expected timestamps for the date range,
 *    detects gaps (timestamps in expected but not in actual), sets valid=true.
 * 3. Reports first 10 gaps only for operator visibility.
 * 4. Reports totalCandles and expectedCandles counts.
 *
 * @param records - Array of candle records to validate
 * @param asset - Asset symbol (for logging context)
 * @returns ValidationResult with validity status, violations, and gap info
 */
export function validateCandles(
  records: CandleRecord[],
  asset: string
): ValidationResult {
  // Step 1: Check OHLC invariants
  const ohlcViolations: OHLCViolation[] = [];

  for (let i = 0; i < records.length; i++) {
    const candle = records[i];
    if (!checkOHLCInvariant(candle)) {
      // Determine which constraint was violated
      if (candle.high < Math.max(candle.open, candle.close)) {
        ohlcViolations.push({
          rowNumber: i + 1,
          timestamp: candle.timestamp_utc,
          constraint: 'high < max(open,close)',
        });
      }
      if (candle.low > Math.min(candle.open, candle.close)) {
        ohlcViolations.push({
          rowNumber: i + 1,
          timestamp: candle.timestamp_utc,
          constraint: 'low > min(open,close)',
        });
      }
    }
  }

  if (ohlcViolations.length > 0) {
    return {
      valid: false,
      totalCandles: records.length,
      expectedCandles: 0,
      ohlcViolations,
      gaps: [],
    };
  }

  // Step 2: Compute expected timestamps and detect gaps
  if (records.length === 0) {
    return {
      valid: true,
      totalCandles: 0,
      expectedCandles: 0,
      ohlcViolations: [],
      gaps: [],
    };
  }

  // Sort records by timestamp to determine date range
  const sortedRecords = [...records].sort(
    (a, b) =>
      new Date(a.timestamp_utc).getTime() -
      new Date(b.timestamp_utc).getTime()
  );

  const startDate = new Date(sortedRecords[0].timestamp_utc);
  const endDate = new Date(sortedRecords[sortedRecords.length - 1].timestamp_utc);

  const expectedTimestamps = computeExpectedTimestamps(startDate, endDate);

  // Build a set of actual timestamps for O(1) lookup
  const actualTimestampSet = new Set(
    records.map((r) => new Date(r.timestamp_utc).toISOString())
  );

  // Detect gaps: expected timestamps not present in actual data
  const allGaps: GapInfo[] = [];
  for (let i = 0; i < expectedTimestamps.length; i++) {
    const expected = expectedTimestamps[i];
    if (!actualTimestampSet.has(expected)) {
      // Find the previous timestamp in the expected sequence
      const previousTimestamp =
        i > 0 ? expectedTimestamps[i - 1] : sortedRecords[0].timestamp_utc;
      allGaps.push({
        expectedTimestamp: expected,
        previousTimestamp,
      });
    }
  }

  // Step 3: Report first 10 gaps only
  const reportedGaps = allGaps.slice(0, 10);

  return {
    valid: true,
    totalCandles: records.length,
    expectedCandles: expectedTimestamps.length,
    ohlcViolations: [],
    gaps: reportedGaps,
  };
}
