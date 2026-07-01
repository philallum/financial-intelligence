/**
 * Cache Writer Service for the Financial Intelligence Platform.
 *
 * Writes forecast results to the `cached_forecasts` table with TTL based on
 * the remaining time in the current 4H UTC grid window.
 *
 * Requirements: 6.1, 6.2, 6.3, 6.4, 6.5, 6.6, 6.7
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import type { Forecast } from '../../types/index.js';
import { UTC_GRID_BOUNDARIES, CACHE_MIN_TTL_SECONDS } from '../../config/constants.js';

// =============================================================================
// Types
// =============================================================================

export interface CacheWriteResult {
  skipped: boolean;
  reason?: 'ttl_below_minimum' | 'batch_not_completed';
  valid_until?: string;
  ttl_seconds?: number;
}

export interface CacheTTLResult {
  ttlSeconds: number;
  windowEnd: Date;
}

// =============================================================================
// Utility: TTL Computation
// =============================================================================

/**
 * Computes the remaining TTL (in seconds) for a cache entry based on the
 * current position within a 4H UTC grid window.
 *
 * The window end is the next UTC grid boundary after the given time.
 * Grid boundaries: 00:00, 04:00, 08:00, 12:00, 16:00, 20:00 UTC.
 */
export function computeCacheTTL(currentTime: Date): CacheTTLResult {
  const currentHour = currentTime.getUTCHours();
  const currentMinutes = currentTime.getUTCMinutes();
  const currentSeconds = currentTime.getUTCSeconds();
  const currentMilliseconds = currentTime.getUTCMilliseconds();

  // Find the next grid boundary after the current hour
  let nextBoundaryHour: number | undefined;
  for (const boundary of UTC_GRID_BOUNDARIES) {
    if (boundary > currentHour) {
      nextBoundaryHour = boundary;
      break;
    }
  }

  // If no boundary found after the current hour, wrap to next day's first boundary (00:00)
  const windowEnd = new Date(currentTime);
  if (nextBoundaryHour === undefined) {
    // Next boundary is 00:00 of the next day
    windowEnd.setUTCDate(windowEnd.getUTCDate() + 1);
    windowEnd.setUTCHours(0, 0, 0, 0);
  } else {
    windowEnd.setUTCHours(nextBoundaryHour, 0, 0, 0);
  }

  // Also handle the case where current time is exactly on a boundary
  // In that case, we're at the START of a new window, so next boundary is +4h
  if (
    currentMinutes === 0 &&
    currentSeconds === 0 &&
    currentMilliseconds === 0 &&
    UTC_GRID_BOUNDARIES.includes(currentHour as typeof UTC_GRID_BOUNDARIES[number])
  ) {
    // We're exactly on a boundary — the window end is the NEXT boundary
    // This is already handled correctly by the loop above since `boundary > currentHour`
    // won't match the current hour. But if currentHour is 20, nextBoundaryHour is undefined
    // and we already wrap to next day. For other hours the logic is correct.
    // No adjustment needed.
  }

  const ttlSeconds = Math.floor((windowEnd.getTime() - currentTime.getTime()) / 1000);

  return { ttlSeconds, windowEnd };
}

// =============================================================================
// CacheWriter Class
// =============================================================================

/**
 * Writes forecast results into the `cached_forecasts` table with computed TTL.
 *
 * - One active cached forecast per asset (keyed by asset, upserted).
 * - TTL = remaining time in the current 4H window.
 * - Skips caching if TTL < CACHE_MIN_TTL_SECONDS (60s).
 * - Skips caching if batch is not yet confirmed completed (Req 6.7).
 */
export class CacheWriter {
  private readonly supabase: SupabaseClient;

  constructor(supabase: SupabaseClient) {
    this.supabase = supabase;
  }

  /**
   * Write a forecast to the cache for a given asset.
   *
   * @param asset - The asset identifier (e.g., "EURUSD")
   * @param forecast - The forecast to cache
   * @param batchCompleted - Whether the batch has been confirmed completed
   * @returns CacheWriteResult indicating success or skip reason
   */
  async writeForecast(
    asset: string,
    forecast: Forecast,
    batchCompleted: boolean
  ): Promise<CacheWriteResult> {
    // Req 6.7: Only write after batch completion is confirmed
    if (!batchCompleted) {
      return { skipped: true, reason: 'batch_not_completed' };
    }

    const now = new Date();
    const { ttlSeconds, windowEnd } = computeCacheTTL(now);

    // Req 6.2: Skip caching if remaining TTL is below minimum threshold
    if (ttlSeconds < CACHE_MIN_TTL_SECONDS) {
      return { skipped: true, reason: 'ttl_below_minimum' };
    }

    const validFrom = now.toISOString();
    const validUntil = windowEnd.toISOString();

    // Req 6.3, 6.4, 6.5, 6.6: Upsert keyed by asset — one active cache per asset
    const { error } = await this.supabase.from('cached_forecasts').upsert(
      {
        asset,
        fingerprint_id: forecast.fingerprint_id,
        payload: forecast,
        batch_id: forecast.batch_id,
        valid_from: validFrom,
        valid_until: validUntil,
      },
      { onConflict: 'asset' }
    );

    if (error) {
      throw new Error(`Failed to write cache for asset ${asset}: ${error.message}`);
    }

    return {
      skipped: false,
      valid_until: validUntil,
      ttl_seconds: ttlSeconds,
    };
  }
}
