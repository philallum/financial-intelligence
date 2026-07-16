/**
 * Sparkline Ordering Module — Testable pure function for chronological candle sorting.
 *
 * Extracts the sparkline sorting logic from the dashboard so it can be
 * validated via property-based tests without requiring a DOM.
 */

// =============================================================================
// Types
// =============================================================================

export interface Candle {
  timestamp_utc: string;
  close: number;
}

// =============================================================================
// Sparkline Ordering
// =============================================================================

/**
 * Sorts candles by timestamp_utc ascending (chronological order)
 * and returns the close prices in that order.
 * Returns empty array if fewer than 2 candles provided.
 */
export function getChronologicalCloses(candles: Candle[]): number[] {
  if (!candles || candles.length < 2) return [];
  const sorted = [...candles].sort(
    (a, b) => new Date(a.timestamp_utc).getTime() - new Date(b.timestamp_utc).getTime(),
  );
  return sorted.map(c => c.close);
}
