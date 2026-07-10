import { describe, it, expect } from 'vitest';
import {
  computeMacroContext,
  computeEventProximity,
  computeSurpriseFactor,
} from '../macro-context-engine.js';
import type { MacroContextEngineInput, EconomicEvent } from '../../types/index.js';

function makeEvent(overrides: Partial<EconomicEvent> = {}): EconomicEvent {
  return {
    id: 'evt-1',
    name: 'Test Event',
    event_date: '2024-01-01T12:00:00Z',
    impact: 'high',
    actual: 1.0,
    estimate: 1.0,
    previous: 0.5,
    currency: 'USD',
    ...overrides,
  };
}

describe('Macro Context Engine', () => {
  describe('computeMacroContext', () => {
    it('returns neutral vector when events array is empty (Req 8.1, 8.2)', () => {
      const input: MacroContextEngineInput = {
        events: [],
        reference_time: '2024-01-01T00:00:00Z',
        lookback_hours: 72,
        lookahead_hours: 24,
      };

      const result = computeMacroContext(input);

      expect(result.vector.event_proximity_pressure).toBe(0.5);
      expect(result.vector.aggregate_surprise_factor).toBe(0.5);
      expect(result.vector.rate_differential).toBe(0.5);
      expect(result.vector.high_impact_event_count).toBe(0.5);
      expect(result.vector.medium_impact_event_count).toBe(0.5);
      expect(result.vector.event_density).toBe(0.5);
      expect(result.vector.upcoming_event_intensity).toBe(0.5);
      expect(result.vector.composite_macro_state).toBe(0.5);
      expect(result.macro_state).toBe(0.5);
      expect(result.event_count).toBe(0);
    });

    it('excludes events with null actual from surprise computation but includes in counts (Req 8.3)', () => {
      const referenceTime = '2024-01-01T00:00:00Z';
      // Event with null actual — should be excluded from surprise but counted
      const input: MacroContextEngineInput = {
        events: [
          makeEvent({
            id: 'evt-null-actual',
            actual: null,
            estimate: 2.0,
            impact: 'high',
            event_date: '2023-12-31T20:00:00Z', // 4h before reference (past)
          }),
        ],
        reference_time: referenceTime,
        lookback_hours: 72,
        lookahead_hours: 24,
      };

      const result = computeMacroContext(input);

      // Event excluded from surprise → aggregate_surprise_factor should be neutral (0.5)
      expect(result.vector.aggregate_surprise_factor).toBe(0.5);
      // But included in counts
      expect(result.event_count).toBe(1);
      expect(result.vector.high_impact_event_count).toBeGreaterThan(0);
      expect(result.vector.event_density).toBeGreaterThan(0);
    });

    it('excludes events with null estimate from surprise computation but includes in counts (Req 8.4)', () => {
      const referenceTime = '2024-01-01T00:00:00Z';
      const input: MacroContextEngineInput = {
        events: [
          makeEvent({
            id: 'evt-null-estimate',
            actual: 2.0,
            estimate: null,
            impact: 'medium',
            event_date: '2023-12-31T20:00:00Z',
          }),
        ],
        reference_time: referenceTime,
        lookback_hours: 72,
        lookahead_hours: 24,
      };

      const result = computeMacroContext(input);

      // Event excluded from surprise → aggregate_surprise_factor should be neutral (0.5)
      expect(result.vector.aggregate_surprise_factor).toBe(0.5);
      // But included in counts
      expect(result.event_count).toBe(1);
      expect(result.vector.medium_impact_event_count).toBeGreaterThan(0);
      expect(result.vector.event_density).toBeGreaterThan(0);
    });

    it('uses absolute difference formula when estimate is 0 (Req 8.5)', () => {
      const referenceTime = '2024-01-01T00:00:00Z';
      const input: MacroContextEngineInput = {
        events: [
          makeEvent({
            id: 'evt-zero-estimate',
            actual: 0.5,
            estimate: 0,
            impact: 'high',
            event_date: '2023-12-31T20:00:00Z',
          }),
        ],
        reference_time: referenceTime,
        lookback_hours: 72,
        lookahead_hours: 24,
      };

      const result = computeMacroContext(input);

      // raw_surprise = clamp(0.5 - 0, -1, 1) = 0.5
      // mapped = (0.5 + 1) / 2 = 0.75
      expect(result.vector.aggregate_surprise_factor).toBeCloseTo(0.75, 5);
    });

    it('returns rate_differential = 0.5 when no rate decision events exist (Req 6.5)', () => {
      const referenceTime = '2024-01-01T00:00:00Z';
      const input: MacroContextEngineInput = {
        events: [
          makeEvent({
            id: 'evt-non-rate',
            name: 'CPI Release',
            actual: 3.2,
            estimate: 3.0,
            impact: 'high',
            event_date: '2023-12-31T20:00:00Z',
          }),
        ],
        reference_time: referenceTime,
        lookback_hours: 72,
        lookahead_hours: 24,
      };

      const result = computeMacroContext(input);

      expect(result.vector.rate_differential).toBe(0.5);
    });

    it('completes computation for 50 events in less than 2 seconds (Req 13.2)', () => {
      const referenceTime = '2024-01-01T00:00:00Z';
      const refMs = new Date(referenceTime).getTime();
      const events: EconomicEvent[] = [];

      for (let i = 0; i < 50; i++) {
        const hoursOffset = Math.random() * 96 - 72; // -72 to +24 hours
        const eventDate = new Date(refMs + hoursOffset * 3600000).toISOString();
        const impacts: Array<'high' | 'medium' | 'low'> = ['high', 'medium', 'low'];
        events.push(
          makeEvent({
            id: `perf-${i}`,
            name: `Event ${i}`,
            event_date: eventDate,
            impact: impacts[i % 3],
            actual: Math.random() * 10,
            estimate: Math.random() * 10,
            previous: Math.random() * 10,
          })
        );
      }

      const input: MacroContextEngineInput = {
        events,
        reference_time: referenceTime,
        lookback_hours: 72,
        lookahead_hours: 24,
      };

      const start = performance.now();
      const result = computeMacroContext(input);
      const elapsed = performance.now() - start;

      expect(elapsed).toBeLessThan(2000);
      expect(result.event_count).toBe(50);
      expect(result.vector.composite_macro_state).toBeGreaterThanOrEqual(0);
      expect(result.vector.composite_macro_state).toBeLessThanOrEqual(1);
    });

    it('computes rate_differential from rate decision event', () => {
      const referenceTime = '2024-01-01T00:00:00Z';
      const input: MacroContextEngineInput = {
        events: [
          makeEvent({
            id: 'rate-evt',
            name: 'Fed Rate Decision',
            actual: 5.5,
            previous: 5.0,
            estimate: 5.5,
            impact: 'high',
            event_date: '2023-12-31T20:00:00Z',
          }),
        ],
        reference_time: referenceTime,
        lookback_hours: 72,
        lookahead_hours: 24,
      };

      const result = computeMacroContext(input);

      // raw_diff = clamp((5.5 - 5.0) / 1.0, -1, 1) = 0.5
      // mapped = (0.5 + 1) / 2 = 0.75
      expect(result.vector.rate_differential).toBeCloseTo(0.75, 5);
    });

    it('computes composite_macro_state as correct weighted average of first 7 dimensions', () => {
      const referenceTime = '2024-01-01T00:00:00Z';
      // Use a single future high-impact event to get non-trivial values
      const input: MacroContextEngineInput = {
        events: [
          makeEvent({
            id: 'composite-evt',
            name: 'GDP Release',
            actual: 3.0,
            estimate: 2.0,
            previous: 2.5,
            impact: 'high',
            // 12h in the future → proximity = 1 - 12/24 = 0.5
            event_date: new Date(
              new Date(referenceTime).getTime() + 12 * 3600000
            ).toISOString(),
          }),
        ],
        reference_time: referenceTime,
        lookback_hours: 72,
        lookahead_hours: 24,
      };

      const result = computeMacroContext(input);

      // Verify composite is the weighted average of the other 7 dimensions
      const weights = {
        event_proximity_pressure: 0.25,
        aggregate_surprise_factor: 0.20,
        rate_differential: 0.15,
        high_impact_event_count: 0.15,
        medium_impact_event_count: 0.05,
        event_density: 0.05,
        upcoming_event_intensity: 0.15,
      };

      const expectedComposite =
        weights.event_proximity_pressure * result.vector.event_proximity_pressure +
        weights.aggregate_surprise_factor * result.vector.aggregate_surprise_factor +
        weights.rate_differential * result.vector.rate_differential +
        weights.high_impact_event_count * result.vector.high_impact_event_count +
        weights.medium_impact_event_count * result.vector.medium_impact_event_count +
        weights.event_density * result.vector.event_density +
        weights.upcoming_event_intensity * result.vector.upcoming_event_intensity;

      expect(result.vector.composite_macro_state).toBeCloseTo(expectedComposite, 5);
      expect(result.macro_state).toBeCloseTo(expectedComposite, 5);
    });
  });

  describe('computeEventProximity', () => {
    it('returns 1.0 when event is 0 hours away', () => {
      expect(computeEventProximity(0)).toBe(1.0);
    });

    it('returns 0.5 when event is 12 hours away', () => {
      expect(computeEventProximity(12)).toBe(0.5);
    });

    it('returns 0.0 when event is 24 hours away', () => {
      expect(computeEventProximity(24)).toBe(0.0);
    });

    it('returns 0.0 when event is more than 24 hours away (48h)', () => {
      expect(computeEventProximity(48)).toBe(0.0);
    });
  });

  describe('computeSurpriseFactor', () => {
    it('returns 1.0 when actual greatly exceeds estimate (actual=2, estimate=1)', () => {
      // raw = (2-1)/|1| = 1, clamped = 1, mapped = (1+1)/2 = 1.0
      expect(computeSurpriseFactor(2, 1)).toBe(1.0);
    });

    it('returns 0.5 when actual equals estimate (no surprise)', () => {
      // raw = (1-1)/|1| = 0, clamped = 0, mapped = (0+1)/2 = 0.5
      expect(computeSurpriseFactor(1, 1)).toBe(0.5);
    });

    it('returns 0.0 when actual greatly misses estimate (actual=0, estimate=1)', () => {
      // raw = (0-1)/|1| = -1, clamped = -1, mapped = (-1+1)/2 = 0.0
      expect(computeSurpriseFactor(0, 1)).toBe(0.0);
    });

    it('uses absolute difference when estimate is 0 (actual=0.5, estimate=0)', () => {
      // raw = clamp(0.5 - 0, -1, 1) = 0.5, mapped = (0.5+1)/2 = 0.75
      expect(computeSurpriseFactor(0.5, 0)).toBe(0.75);
    });
  });
});
