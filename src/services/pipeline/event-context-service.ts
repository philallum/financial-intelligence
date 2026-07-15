/**
 * Event Context Service
 *
 * Retrieves historical event impact summaries for upcoming high-impact economic events.
 * Used by the batch pipeline to enrich forecasts with event-driven context.
 *
 * Flow:
 *   1. Query economic_events for upcoming high-impact events within 8 hours
 *   2. For each upcoming event, query past instances of same event type (name)
 *   3. Join past event timestamps with market_outcomes via time proximity matching
 *   4. Compute EventImpactSummary: median_move_pips, direction_skew, vol_expansion_ratio
 *
 * Returns null if:
 *   - No upcoming high-impact events
 *   - < 3 historical instances with outcome data
 *   - Supabase query failures (gracefully handled)
 *
 * Requirements: 8.1, 8.2, 8.3, 8.4, 9.1, 9.2
 */

import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { env } from '../../config/env.js';

// =============================================================================
// Interfaces
// =============================================================================

/** Summary of historical impact for a given event type. */
export interface EventImpactSummary {
  /** The event type identifier (name from economic_events). */
  event_type: string;
  /** Statistical median of absolute net_return_pips from past event instances. */
  median_move_pips: number;
  /** Proportion of positive (up) moves: count(up) / total. Range: 0..1. */
  direction_skew: number;
  /** Volatility expansion ratio: mean abs move / overall mean abs move. */
  vol_expansion_ratio: number;
  /** Number of historical instances used in the computation. */
  instance_count: number;
}

// =============================================================================
// Constants
// =============================================================================

/** Lookahead window for upcoming events (8 hours in milliseconds). */
const LOOKAHEAD_MS = 8 * 60 * 60 * 1000;

/** Time proximity window for matching market_outcomes to event timestamps (4 hours in ms). */
const PROXIMITY_WINDOW_MS = 4 * 60 * 60 * 1000;

/** Minimum number of historical instances required to compute a summary. */
const MIN_HISTORICAL_INSTANCES = 3;

// =============================================================================
// Event Context Service
// =============================================================================

/**
 * Service that provides historical event impact context for upcoming high-impact events.
 */
export class EventContextService {
  private readonly supabase: SupabaseClient;

  constructor(supabaseClient?: SupabaseClient) {
    this.supabase =
      supabaseClient ??
      createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);
  }

  /**
   * Query upcoming high-impact events and compute historical impact summary.
   *
   * @param asset - The asset symbol (e.g., "EURUSD")
   * @param currentTime - The reference time for the query window
   * @returns EventImpactSummary if a relevant upcoming event is found with sufficient history, null otherwise
   */
  async getEventContext(asset: string, currentTime: Date): Promise<EventImpactSummary | null> {
    try {
      // Step 1: Find upcoming high-impact events within 8 hours
      const upcomingEvent = await this.findUpcomingHighImpactEvent(asset, currentTime);
      if (!upcomingEvent) {
        return null;
      }

      // Step 2: Query past instances of the same event type
      const pastEventDates = await this.findPastEventInstances(
        upcomingEvent.name,
        currentTime,
      );
      if (pastEventDates.length < MIN_HISTORICAL_INSTANCES) {
        console.log(
          `[EventContextService] Insufficient historical data for event "${upcomingEvent.name}": ` +
          `${pastEventDates.length} instances (need ${MIN_HISTORICAL_INSTANCES})`,
        );
        return null;
      }

      // Step 3: Match past event timestamps with market_outcomes via time proximity
      const outcomes = await this.matchOutcomesToEvents(pastEventDates, asset);
      if (outcomes.length < MIN_HISTORICAL_INSTANCES) {
        console.log(
          `[EventContextService] Insufficient matched outcomes for event "${upcomingEvent.name}": ` +
          `${outcomes.length} matched (need ${MIN_HISTORICAL_INSTANCES})`,
        );
        return null;
      }

      // Step 4: Compute the impact summary
      return this.computeImpactSummary(upcomingEvent.name, outcomes);
    } catch (error) {
      console.error(
        `[EventContextService] Unexpected error in getEventContext: ${error instanceof Error ? error.message : String(error)}`,
      );
      return null;
    }
  }

  /**
   * Find the nearest upcoming high-impact event within the 8-hour lookahead window.
   * Derives relevant currencies from the asset symbol.
   */
  private async findUpcomingHighImpactEvent(
    asset: string,
    currentTime: Date,
  ): Promise<{ name: string; event_date: string } | null> {
    const currencies = this.deriveCurrencies(asset);
    const windowEnd = new Date(currentTime.getTime() + LOOKAHEAD_MS).toISOString();

    const { data, error } = await this.supabase
      .from('economic_events')
      .select('name, event_date')
      .in('currency', currencies)
      .eq('impact', 'high')
      .gte('event_date', currentTime.toISOString())
      .lte('event_date', windowEnd)
      .order('event_date', { ascending: true })
      .limit(1)
      .maybeSingle();

    if (error) {
      console.error(
        `[EventContextService] Failed to query upcoming events: ${error.message}`,
      );
      return null;
    }

    return data as { name: string; event_date: string } | null;
  }

  /**
   * Find all past instances of the same event type (by name) before currentTime.
   */
  private async findPastEventInstances(
    eventName: string,
    currentTime: Date,
  ): Promise<string[]> {
    const { data, error } = await this.supabase
      .from('economic_events')
      .select('event_date')
      .eq('name', eventName)
      .lt('event_date', currentTime.toISOString())
      .order('event_date', { ascending: false });

    if (error) {
      console.error(
        `[EventContextService] Failed to query past event instances: ${error.message}`,
      );
      return [];
    }

    if (!data || data.length === 0) {
      return [];
    }

    return (data as Array<{ event_date: string }>).map((row) => row.event_date);
  }

  /**
   * Match past event timestamps with market_outcomes via time proximity.
   * For each past event date, find market outcomes within a 4-hour proximity window.
   */
  private async matchOutcomesToEvents(
    eventDates: string[],
    asset: string,
  ): Promise<number[]> {
    const netReturnPips: number[] = [];

    // Query market_outcomes for each event date within the proximity window.
    // Batch the queries to reduce round trips — query all outcomes for the asset
    // and filter by time proximity in application code if the dataset is small enough.
    // For robustness, query per-event to avoid loading excessive data.
    for (const eventDate of eventDates) {
      const eventTime = new Date(eventDate).getTime();
      const windowStart = new Date(eventTime - PROXIMITY_WINDOW_MS).toISOString();
      const windowEnd = new Date(eventTime + PROXIMITY_WINDOW_MS).toISOString();

      const { data, error } = await this.supabase
        .from('market_outcomes')
        .select('net_return_pips')
        .eq('asset', asset)
        .gte('timestamp_utc', windowStart)
        .lte('timestamp_utc', windowEnd)
        .order('timestamp_utc', { ascending: false })
        .limit(1)
        .maybeSingle();

      if (error) {
        console.warn(
          `[EventContextService] Failed to query market_outcomes for event at ${eventDate}: ${error.message}`,
        );
        continue;
      }

      if (data && typeof (data as { net_return_pips: number }).net_return_pips === 'number') {
        netReturnPips.push((data as { net_return_pips: number }).net_return_pips);
      }
    }

    return netReturnPips;
  }

  /**
   * Compute the EventImpactSummary from matched outcome data.
   *
   * - median_move_pips: statistical median of abs(net_return_pips)
   * - direction_skew: proportion of positive moves (count where pips > 0 / total)
   * - vol_expansion_ratio: mean abs(pips) / overall median abs(pips)
   *   (approximates post-event volatility expansion; ratio > 1 = volatility expansion)
   */
  private computeImpactSummary(eventType: string, outcomes: number[]): EventImpactSummary {
    const absMoves = outcomes.map((v) => Math.abs(v));
    const medianMovePips = this.computeMedian(absMoves);

    // Direction skew: proportion of positive (up) moves
    const upCount = outcomes.filter((v) => v > 0).length;
    const directionSkew = upCount / outcomes.length;

    // Vol expansion ratio: mean abs move / median abs move
    // If median is 0 (all moves are 0), default ratio to 1.0
    const meanAbsMove = absMoves.reduce((sum, v) => sum + v, 0) / absMoves.length;
    const volExpansionRatio = medianMovePips > 0 ? meanAbsMove / medianMovePips : 1.0;

    return {
      event_type: eventType,
      median_move_pips: medianMovePips,
      direction_skew: directionSkew,
      vol_expansion_ratio: volExpansionRatio,
      instance_count: outcomes.length,
    };
  }

  /**
   * Compute the statistical median of an array of numbers.
   */
  private computeMedian(values: number[]): number {
    if (values.length === 0) return 0;

    const sorted = [...values].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);

    if (sorted.length % 2 === 0) {
      return (sorted[mid - 1]! + sorted[mid]!) / 2;
    }
    return sorted[mid]!;
  }

  /**
   * Derive relevant currencies from an asset symbol.
   * e.g., "EURUSD" → ["EUR", "USD"], "XAUUSD" → ["XAU", "USD"]
   */
  private deriveCurrencies(asset: string): string[] {
    const upper = asset.toUpperCase();
    if (upper.length >= 6) {
      return [upper.slice(0, 3), upper.slice(3, 6)];
    }
    return [upper];
  }
}
