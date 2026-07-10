/**
 * Type definitions for the Macro Context Engine and News Risk Evaluator.
 *
 * These types define the data contracts for economic event processing,
 * macro context vector generation, and news risk evaluation.
 */

/** An economic calendar event from the economic_events table. */
export interface EconomicEvent {
  readonly id: string;
  readonly name: string;
  readonly event_date: string;             // ISO-8601 UTC
  readonly impact: 'high' | 'medium' | 'low';
  readonly actual: number | null;
  readonly estimate: number | null;
  readonly previous: number | null;
  readonly currency: string;               // e.g. "USD", "EUR"
}

/** Input to the Macro Context Engine. */
export interface MacroContextEngineInput {
  readonly events: readonly EconomicEvent[];
  readonly reference_time: string;         // ISO-8601 UTC (4H candle boundary)
  readonly lookback_hours: number;         // default 72 (backward)
  readonly lookahead_hours: number;        // default 24 (forward)
}

/** 8-dimensional macro vector for L4 fingerprint layer. */
export interface MacroVector {
  /** Proximity pressure from nearest high-impact event. */
  readonly event_proximity_pressure: number;
  /** Weighted mean of surprise factors from recent events. */
  readonly aggregate_surprise_factor: number;
  /** Rate differential from recent rate decisions. */
  readonly rate_differential: number;
  /** High-impact event count normalised (count / 5, clamped [0,1]). */
  readonly high_impact_event_count: number;
  /** Medium-impact event count normalised (count / 10, clamped [0,1]). */
  readonly medium_impact_event_count: number;
  /** Total event density normalised (count / 20, clamped [0,1]). */
  readonly event_density: number;
  /** Weighted upcoming event intensity (next 24h). */
  readonly upcoming_event_intensity: number;
  /** Weighted average of all dimensions. */
  readonly composite_macro_state: number;
}

/** Output from the Macro Context Engine. */
export interface MacroContextEngineOutput {
  readonly vector: MacroVector;
  readonly macro_state: number;            // [0, 1], 6 decimal places
  readonly event_count: number;
  readonly engine_version: string;
}

/** Input to the News Risk Evaluator. */
export interface NewsRiskEvaluatorInput {
  readonly evaluation_time: string;        // ISO-8601 UTC
  readonly asset_currencies: readonly string[]; // e.g. ["USD", "EUR"]
  readonly lookahead_hours: number;        // default 8
}

/** Output from the News Risk Evaluator. */
export interface NewsRiskEvaluatorOutput {
  readonly news_risk_flag: boolean;
  readonly triggering_events: readonly string[]; // event names that triggered flag
  readonly hours_to_nearest: number | null;
}
