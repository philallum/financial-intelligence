/**
 * Macro Context Engine — pure computational module.
 *
 * Consumes economic calendar events and produces an 8-dimensional macro vector
 * (L4 fingerprint layer) plus a scalar macro_state. Pure function: no I/O,
 * no randomness, deterministic.
 */

import type {
  EconomicEvent,
  MacroContextEngineInput,
  MacroContextEngineOutput,
  MacroVector,
} from '../types/index.js';

import { roundTo6, mapToUnitInterval } from './sentiment-engine.js';

/** Impact weight mapping for weighted aggregation. */
const IMPACT_WEIGHTS: Record<EconomicEvent['impact'], number> = {
  high: 3,
  medium: 2,
  low: 1,
};

/** Composite dimension weights (must sum to 1.0). */
const COMPOSITE_WEIGHTS = {
  event_proximity_pressure: 0.25,
  aggregate_surprise_factor: 0.20,
  rate_differential: 0.15,
  high_impact_event_count: 0.15,
  medium_impact_event_count: 0.05,
  event_density: 0.05,
  upcoming_event_intensity: 0.15,
} as const;

/**
 * Clamps a value to the range [min, max].
 */
function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

/**
 * Computes event proximity pressure for the nearest high-impact event.
 * Formula: 1 - (hours_to_event / 24), clamped [0, 1].
 *
 * Events more than 24 hours away produce 0 pressure.
 * Events at 0 hours produce maximum pressure of 1.
 *
 * @param hours_to_event - Non-negative hours until the event occurs
 * @returns A value in [0, 1] representing proximity pressure
 */
export function computeEventProximity(hours_to_event: number): number {
  return clamp(1 - hours_to_event / 24, 0, 1);
}

/**
 * Computes surprise factor for a single event.
 * Formula: (actual - estimate) / |estimate|, clamped [-1, 1], mapped to [0, 1].
 * Special case: if estimate === 0, uses clamp(actual - estimate, -1, 1) mapped to [0, 1].
 *
 * @param actual - The actual released value
 * @param estimate - The consensus estimate
 * @returns A value in [0, 1] representing the mapped surprise factor
 */
export function computeSurpriseFactor(actual: number, estimate: number): number {
  let rawSurprise: number;

  if (estimate === 0) {
    rawSurprise = clamp(actual - estimate, -1, 1);
  } else {
    rawSurprise = clamp((actual - estimate) / Math.abs(estimate), -1, 1);
  }

  return mapToUnitInterval(rawSurprise);
}

/**
 * Checks if an event name matches rate decision patterns.
 * Matches "rate decision" or "interest rate" (case-insensitive).
 */
function isRateDecisionEvent(name: string): boolean {
  const lower = name.toLowerCase();
  return lower.includes('rate decision') || lower.includes('interest rate');
}

/**
 * Computes the macro context vector and scalar state from economic events.
 * Pure function: no I/O, no randomness, deterministic.
 *
 * @param input - The macro context engine input containing events and reference time
 * @returns The macro context engine output with 8-dimensional vector and scalar state
 */
export function computeMacroContext(input: MacroContextEngineInput): MacroContextEngineOutput {
  const events = input.events;
  const referenceMs = new Date(input.reference_time).getTime();

  // If no events, return neutral vector (all dimensions = 0.5)
  if (events.length === 0) {
    const neutralVector: MacroVector = {
      event_proximity_pressure: 0.5,
      aggregate_surprise_factor: 0.5,
      rate_differential: 0.5,
      high_impact_event_count: 0.5,
      medium_impact_event_count: 0.5,
      event_density: 0.5,
      upcoming_event_intensity: 0.5,
      composite_macro_state: 0.5,
    };
    return {
      vector: neutralVector,
      macro_state: 0.5,
      event_count: 0,
      engine_version: '1.0.0',
    };
  }

  // ─── Dimension 1: Event Proximity Pressure ────────────────────────────────
  const futureHigh = events.filter(
    (e) => e.impact === 'high' && new Date(e.event_date).getTime() > referenceMs
  );

  let eventProximityPressure: number;
  if (futureHigh.length > 0) {
    const nearest = futureHigh.reduce((min, e) => {
      const eMs = new Date(e.event_date).getTime();
      const minMs = new Date(min.event_date).getTime();
      return eMs < minMs ? e : min;
    });
    const hoursTo = (new Date(nearest.event_date).getTime() - referenceMs) / 3600000;
    eventProximityPressure = computeEventProximity(hoursTo);
  } else {
    eventProximityPressure = 0.0;
  }

  // ─── Dimension 2: Aggregate Surprise Factor ───────────────────────────────
  const surpriseEvents = events.filter(
    (e) => e.actual != null && e.estimate != null
  );

  let aggregateSurpriseFactor: number;
  if (surpriseEvents.length > 0) {
    let weightedSum = 0;
    let totalWeight = 0;

    for (const event of surpriseEvents) {
      const mappedSurprise = computeSurpriseFactor(event.actual!, event.estimate!);
      const impactWeight = IMPACT_WEIGHTS[event.impact];
      weightedSum += mappedSurprise * impactWeight;
      totalWeight += impactWeight;
    }

    aggregateSurpriseFactor = weightedSum / totalWeight;
  } else {
    aggregateSurpriseFactor = 0.5; // neutral
  }

  // ─── Dimension 3: Rate Differential ───────────────────────────────────────
  const rateEvents = events
    .filter(
      (e) =>
        isRateDecisionEvent(e.name) &&
        e.actual != null &&
        e.previous != null
    )
    .sort(
      (a, b) =>
        new Date(b.event_date).getTime() - new Date(a.event_date).getTime()
    );

  let rateDifferential: number;
  if (rateEvents.length > 0) {
    const latest = rateEvents[0];
    const rawDiff = clamp((latest.actual! - latest.previous!) / 1.0, -1, 1);
    rateDifferential = mapToUnitInterval(rawDiff);
  } else {
    rateDifferential = 0.5;
  }

  // ─── Dimensions 4-7: Event counts and density ─────────────────────────────
  const highImpactEventCount = clamp(
    events.filter((e) => e.impact === 'high').length / 5,
    0,
    1
  );

  const mediumImpactEventCount = clamp(
    events.filter((e) => e.impact === 'medium').length / 10,
    0,
    1
  );

  const eventDensity = clamp(events.length / 20, 0, 1);

  // Upcoming 24h intensity
  const twentyFourHoursMs = 24 * 3600000;
  const upcoming24h = events.filter((e) => {
    const eventMs = new Date(e.event_date).getTime();
    return eventMs > referenceMs && eventMs <= referenceMs + twentyFourHoursMs;
  });

  const intensitySum = upcoming24h.reduce(
    (sum, e) => sum + IMPACT_WEIGHTS[e.impact],
    0
  );
  const upcomingEventIntensity = clamp(intensitySum / 15, 0, 1);

  // ─── Dimension 8: Composite (weighted average of dims 1-7) ────────────────
  const compositeMacroState =
    COMPOSITE_WEIGHTS.event_proximity_pressure * eventProximityPressure +
    COMPOSITE_WEIGHTS.aggregate_surprise_factor * aggregateSurpriseFactor +
    COMPOSITE_WEIGHTS.rate_differential * rateDifferential +
    COMPOSITE_WEIGHTS.high_impact_event_count * highImpactEventCount +
    COMPOSITE_WEIGHTS.medium_impact_event_count * mediumImpactEventCount +
    COMPOSITE_WEIGHTS.event_density * eventDensity +
    COMPOSITE_WEIGHTS.upcoming_event_intensity * upcomingEventIntensity;

  // Round all values to 6 decimal places
  const vector: MacroVector = {
    event_proximity_pressure: roundTo6(eventProximityPressure),
    aggregate_surprise_factor: roundTo6(aggregateSurpriseFactor),
    rate_differential: roundTo6(rateDifferential),
    high_impact_event_count: roundTo6(highImpactEventCount),
    medium_impact_event_count: roundTo6(mediumImpactEventCount),
    event_density: roundTo6(eventDensity),
    upcoming_event_intensity: roundTo6(upcomingEventIntensity),
    composite_macro_state: roundTo6(compositeMacroState),
  };

  return {
    vector,
    macro_state: roundTo6(compositeMacroState),
    event_count: events.length,
    engine_version: '1.0.0',
  };
}
