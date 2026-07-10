/**
 * News Risk Evaluator
 *
 * Evaluates proximity of upcoming high-impact economic events and produces
 * a boolean flag indicating whether trading should be discouraged.
 *
 * Unlike the Sentiment and Macro Context engines, this component performs
 * a database query at API request time (Runtime Layer). It queries the
 * economic_events table for high-impact events within the lookahead window.
 *
 * Error handling follows a conservative approach: if any failure occurs
 * (database error, timeout), the flag defaults to true (block trading).
 *
 * Requirements: 9.1, 9.2, 9.3, 9.6, 13.5
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import type {
  NewsRiskEvaluatorInput,
  NewsRiskEvaluatorOutput,
} from '../types/macro.js';

// =============================================================================
// Types
// =============================================================================

/** Subset of EconomicEvent returned by the news risk query. */
interface NewsRiskEvent {
  readonly name: string;
  readonly event_date: string;
}

// =============================================================================
// Pure Logic Helper (exported for property testing)
// =============================================================================

/**
 * Computes the news risk evaluation result from a pre-fetched array of events.
 * Pure function: no I/O, no randomness, deterministic.
 *
 * @param events - High-impact events within the lookahead window (already filtered)
 * @param evaluationTime - ISO-8601 UTC evaluation timestamp
 * @returns NewsRiskEvaluatorOutput
 */
export function evaluateNewsRiskFromEvents(
  events: readonly NewsRiskEvent[],
  evaluationTime: string,
): NewsRiskEvaluatorOutput {
  if (events.length === 0) {
    return {
      news_risk_flag: false,
      triggering_events: [],
      hours_to_nearest: null,
    };
  }

  const evalMs = new Date(evaluationTime).getTime();
  const triggering_events = events.map((e) => e.name);

  // Compute hours to nearest event
  let minHours = Infinity;
  for (const event of events) {
    const eventMs = new Date(event.event_date).getTime();
    const hoursToEvent = (eventMs - evalMs) / (1000 * 60 * 60);
    if (hoursToEvent < minHours) {
      minHours = hoursToEvent;
    }
  }

  return {
    news_risk_flag: true,
    triggering_events,
    hours_to_nearest: minHours === Infinity ? null : minHours,
  };
}

// =============================================================================
// Public API (with database access)
// =============================================================================

/**
 * Evaluates whether a high-impact event is within the risk window.
 * Queries the economic_events table for high-impact events within the
 * configured lookahead window, filtered by currency relevance.
 *
 * Conservative error handling:
 * - Database query failure → flag = true (block trading)
 * - Empty currency list → flag = false (no currencies to check)
 *
 * @param input - News risk evaluator input (evaluation_time, asset_currencies, lookahead_hours)
 * @param supabase - Supabase client for database access
 * @returns Promise<NewsRiskEvaluatorOutput>
 */
export async function evaluateNewsRisk(
  input: NewsRiskEvaluatorInput,
  supabase: SupabaseClient,
): Promise<NewsRiskEvaluatorOutput> {
  // Early return for empty currency list — no currencies to check
  if (input.asset_currencies.length === 0) {
    return {
      news_risk_flag: false,
      triggering_events: [],
      hours_to_nearest: null,
    };
  }

  try {
    const evaluationTime = input.evaluation_time;
    const lookaheadMs = input.lookahead_hours * 60 * 60 * 1000;
    const windowEnd = new Date(
      new Date(evaluationTime).getTime() + lookaheadMs,
    ).toISOString();

    const { data, error } = await supabase
      .from('economic_events')
      .select('name, event_date')
      .eq('impact', 'high')
      .in('currency', input.asset_currencies as unknown as string[])
      .gt('event_date', evaluationTime)
      .lte('event_date', windowEnd)
      .order('event_date', { ascending: true });

    if (error) {
      // Conservative: database error → block trading
      console.warn(JSON.stringify({
        engine_name: 'news_risk',
        severity: 'error',
        detail: `Database query failed: ${error.message}`,
      }));
      return {
        news_risk_flag: true,
        triggering_events: [],
        hours_to_nearest: null,
      };
    }

    const events: NewsRiskEvent[] = (data ?? []) as NewsRiskEvent[];
    return evaluateNewsRiskFromEvents(events, evaluationTime);
  } catch (err: unknown) {
    // Conservative: any unexpected error → block trading
    const message = err instanceof Error ? err.message : String(err);
    console.warn(JSON.stringify({
      engine_name: 'news_risk',
      severity: 'error',
      detail: `Unexpected error during news risk evaluation: ${message}`,
    }));
    return {
      news_risk_flag: true,
      triggering_events: [],
      hours_to_nearest: null,
    };
  }
}
