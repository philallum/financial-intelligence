/**
 * Gap Detector — Identifies missing 4H candle timestamps within a lookback window.
 *
 * Compares existing candle timestamps in raw_candles against the expected UTC 4H grid
 * and returns any missing entries sorted in ascending chronological order.
 *
 * Requirements: 2.1, 2.2, 2.3, 2.4, 2.5
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import type { GapDetectionInput, GapDetectionResult } from './types.js';

/** The six UTC hours that form the 4H candle grid. */
const GRID_HOURS = [0, 4, 8, 12, 16, 20] as const;

/**
 * Generate the expected UTC 4H grid timestamps between startTime and endTime (inclusive).
 *
 * For "24x7" assets, all 4H boundaries are included.
 * For "24x5" assets, timestamps falling within the weekend period
 * (Friday 21:00 UTC to Sunday 21:00 UTC) are excluded.
 *
 * @param startTime - Start of the time window (inclusive, snapped to grid)
 * @param endTime - End of the time window (inclusive)
 * @param marketHours - Market hours type (e.g. "24x5", "24x7")
 * @returns Array of ISO-8601 timestamps representing expected candle slots, sorted ascending
 */
export function generateExpectedGrid(
  startTime: Date,
  endTime: Date,
  marketHours: string
): string[] {
  const timestamps: string[] = [];
  const current = new Date(startTime.getTime());

  // Snap to the nearest 4H grid boundary at or after startTime
  current.setUTCMinutes(0, 0, 0);
  const hour = current.getUTCHours();
  const remainder = hour % 4;
  if (remainder !== 0) {
    current.setUTCHours(hour + (4 - remainder));
  }

  const is24x5 = marketHours === '24x5';

  while (current <= endTime) {
    const currentHour = current.getUTCHours();

    // Only emit timestamps on valid 4H grid hours
    if (GRID_HOURS.includes(currentHour as (typeof GRID_HOURS)[number])) {
      if (is24x5 && isInWeekendPeriod(current)) {
        // Skip weekend period for 24x5 assets
      } else {
        timestamps.push(current.toISOString());
      }
    }

    // Advance by 4 hours
    current.setTime(current.getTime() + 4 * 60 * 60 * 1000);
  }

  return timestamps;
}

/**
 * Determines whether a given UTC timestamp falls within the forex weekend period.
 *
 * The weekend period is defined as Friday 21:00 UTC (exclusive of trading)
 * through Sunday 21:00 UTC (exclusive — Sunday 21:00+ is not in the weekend).
 *
 * Since our grid only has 00:00, 04:00, 08:00, 12:00, 16:00, 20:00, the
 * practical exclusion is:
 * - Saturday: all grid times (00:00, 04:00, 08:00, 12:00, 16:00, 20:00)
 * - Sunday: 00:00, 04:00, 08:00, 12:00, 16:00, 20:00
 *
 * Friday 20:00 is the last valid grid slot before the weekend starts at 21:00.
 * Sunday 20:00 is still in the weekend (before 21:00), so it's excluded.
 * Monday 00:00 is the first valid slot after the weekend.
 *
 * More precisely: a timestamp T is in the weekend if:
 * - It's on Saturday (any time), OR
 * - It's on Sunday and before 21:00 UTC, OR
 * - It's on Friday at or after 21:00 UTC (but 21:00 is not a grid hour, so
 *   effectively Friday 20:00 is included and nothing after on Friday is a grid slot)
 *
 * Since the 4H grid never produces 21:00, Friday grid slots up to 20:00 are valid.
 */
function isInWeekendPeriod(date: Date): boolean {
  const dayOfWeek = date.getUTCDay(); // 0=Sun, 1=Mon, ..., 5=Fri, 6=Sat
  const hourUTC = date.getUTCHours();

  // Saturday: entirely in weekend
  if (dayOfWeek === 6) return true;

  // Sunday: in weekend until 21:00 UTC
  // Since grid hours are 0,4,8,12,16,20, all Sunday grid slots < 21:00 are excluded
  if (dayOfWeek === 0 && hourUTC < 21) return true;

  // Friday at or after 21:00 — but 21:00 is never a grid hour, so this won't
  // be reached in practice. Including for correctness.
  if (dayOfWeek === 5 && hourUTC >= 21) return true;

  return false;
}

/**
 * Detect missing candle timestamps for a given asset and timeframe.
 *
 * Queries existing timestamps from raw_candles within the lookback window,
 * generates the expected grid, and returns the difference sorted ascending.
 *
 * @param supabase - Supabase client instance
 * @param input - Gap detection parameters (asset, timeframe, lookbackHours, referenceTime)
 * @returns Gap detection result with missing timestamps and counts
 */
export async function detectGaps(
  supabase: SupabaseClient,
  input: GapDetectionInput
): Promise<GapDetectionResult> {
  const { asset, timeframe, lookbackHours, referenceTime } = input;

  // Calculate the lookback window
  const endTime = referenceTime;
  const startTime = new Date(endTime.getTime() - lookbackHours * 60 * 60 * 1000);

  // Generate expected grid
  const expectedGrid = generateExpectedGrid(startTime, endTime, asset.marketHours);

  // Query existing timestamps from raw_candles
  const existingTimestamps = await fetchExistingTimestamps(
    supabase,
    asset.symbol,
    timeframe,
    startTime,
    endTime
  );

  // Compute the difference: expected - existing
  const existingSet = new Set(existingTimestamps);
  const missingTimestamps = expectedGrid.filter(ts => !existingSet.has(ts));

  return {
    asset: asset.symbol,
    timeframe,
    missingTimestamps,
    existingCount: existingTimestamps.length,
    expectedCount: expectedGrid.length,
  };
}

/**
 * Fetch existing candle timestamps from raw_candles for the given window.
 *
 * Uses pagination to handle large result sets. Returns ISO-8601 strings.
 */
async function fetchExistingTimestamps(
  supabase: SupabaseClient,
  assetSymbol: string,
  timeframe: string,
  startTime: Date,
  endTime: Date
): Promise<string[]> {
  const timestamps: string[] = [];
  let offset = 0;
  const pageSize = 1000;

  while (true) {
    const { data, error } = await supabase
      .from('raw_candles')
      .select('timestamp_utc')
      .eq('asset', assetSymbol)
      .eq('timeframe', timeframe)
      .gte('timestamp_utc', startTime.toISOString())
      .lte('timestamp_utc', endTime.toISOString())
      .order('timestamp_utc', { ascending: true })
      .range(offset, offset + pageSize - 1);

    if (error) {
      throw new Error(
        `[GapDetector] Failed to query raw_candles for ${assetSymbol}/${timeframe}: ${error.message}`
      );
    }

    if (!data || data.length === 0) break;

    for (const row of data) {
      // Normalize to ISO string for consistent comparison
      timestamps.push(new Date(row.timestamp_utc).toISOString());
    }

    if (data.length < pageSize) break;
    offset += pageSize;
  }

  return timestamps;
}
