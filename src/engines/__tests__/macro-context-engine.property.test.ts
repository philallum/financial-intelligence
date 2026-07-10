/**
 * Macro Context Engine Property Tests
 *
 * Property 5: Macro output vector invariant
 * Property 6: Event proximity is bounded and monotonically decreasing
 * Property 7: Surprise factor is bounded
 * Property 8: Macro order-independence
 *
 * **Validates: Requirements 5.4, 5.5, 6.1, 6.2, 6.3, 7.1, 7.2, 7.3, 7.4, 7.5, 7.6, 8.5, 12.2, 12.6**
 */

import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';
import { computeEventProximity, computeMacroContext, computeSurpriseFactor } from '../macro-context-engine.js';
import { mapToUnitInterval, roundTo6 } from '../sentiment-engine.js';
import type { MacroContextEngineInput, EconomicEvent } from '../../types/index.js';

// =============================================================================
// Helpers (Property 5)
// =============================================================================

/**
 * Checks whether a number is rounded to exactly 6 decimal places.
 */
function isRoundedTo6(value: number): boolean {
  return value === Math.round(value * 1_000_000) / 1_000_000;
}

/**
 * The 8 expected dimension keys of the MacroVector.
 */
const VECTOR_DIMENSIONS = [
  'event_proximity_pressure',
  'aggregate_surprise_factor',
  'rate_differential',
  'high_impact_event_count',
  'medium_impact_event_count',
  'event_density',
  'upcoming_event_intensity',
  'composite_macro_state',
] as const;

/**
 * Composite weights for the first 7 dimensions (must sum to 1.0).
 */
const COMPOSITE_WEIGHTS = [0.25, 0.20, 0.15, 0.15, 0.05, 0.05, 0.15] as const;

// =============================================================================
// Generators (Property 5)
// =============================================================================

/**
 * Generates a random ISO-8601 UTC timestamp within a reasonable range
 * (2020-01-01 to 2025-12-31).
 */
function arbIsoTimestamp(): fc.Arbitrary<string> {
  const minMs = new Date('2020-01-01T00:00:00Z').getTime();
  const maxMs = new Date('2025-12-31T23:59:59Z').getTime();
  return fc
    .integer({ min: minMs, max: maxMs })
    .map((ms) => new Date(ms).toISOString());
}

/**
 * Generates a random EconomicEvent with valid field ranges.
 */
function arbEconomicEventP5(): fc.Arbitrary<EconomicEvent> {
  return fc.record({
    id: fc.string({ minLength: 1, maxLength: 36 }),
    name: fc.oneof(
      fc.string({ minLength: 1, maxLength: 50 }),
      fc.constant('US rate decision'),
      fc.constant('ECB interest rate'),
      fc.string({ minLength: 1, maxLength: 30 }).map((s) => s + ' rate decision'),
      fc.string({ minLength: 1, maxLength: 30 }).map((s) => s + ' interest rate'),
    ),
    event_date: arbIsoTimestamp(),
    impact: fc.constantFrom('high', 'medium', 'low') as fc.Arbitrary<'high' | 'medium' | 'low'>,
    actual: fc.option(
      fc.double({ min: -100, max: 100, noNaN: true, noDefaultInfinity: true }),
      { nil: null }
    ),
    estimate: fc.option(
      fc.oneof(
        fc.double({ min: -100, max: 100, noNaN: true, noDefaultInfinity: true }),
        fc.constant(0),
      ),
      { nil: null }
    ),
    previous: fc.option(
      fc.double({ min: -100, max: 100, noNaN: true, noDefaultInfinity: true }),
      { nil: null }
    ),
    currency: fc.constantFrom('USD', 'EUR', 'GBP', 'JPY'),
  });
}

/**
 * Generates a valid MacroContextEngineInput with random events (0–50),
 * random reference_time, and default lookback/lookahead hours.
 */
function arbMacroInput(): fc.Arbitrary<MacroContextEngineInput> {
  return fc.record({
    events: fc.array(arbEconomicEventP5(), { minLength: 0, maxLength: 50 }),
    reference_time: arbIsoTimestamp(),
    lookback_hours: fc.constant(72),
    lookahead_hours: fc.constant(24),
  });
}

// =============================================================================
// Generators (Property 8)
// =============================================================================

/**
 * Generates a random EconomicEvent with a distinct event_date based on an index offset.
 * Using index-based offsets ensures all events have unique timestamps, avoiding
 * sort-stability ambiguity in the rate_differential computation.
 */
function arbEconomicEvent(baseMs: number, index: number): fc.Arbitrary<EconomicEvent> {
  // Each event gets a unique timestamp offset by index * 1 hour
  const eventDateMs = baseMs + index * 3600000;

  return fc.record({
    id: fc.uuid(),
    name: fc.oneof(
      fc.constant('CPI Release'),
      fc.constant('GDP Growth'),
      fc.constant('Employment Change'),
      fc.constant('Trade Balance'),
      fc.constant('PMI Manufacturing'),
      fc.constant('rate decision announcement'),
      fc.constant('interest rate decision'),
      fc.constant('Retail Sales'),
    ),
    event_date: fc.constant(new Date(eventDateMs).toISOString()),
    impact: fc.oneof(
      fc.constant('high' as const),
      fc.constant('medium' as const),
      fc.constant('low' as const),
    ),
    actual: fc.oneof(
      fc.constant(null),
      fc.double({ min: -5, max: 5, noNaN: true, noDefaultInfinity: true }),
      fc.constant(0),
    ),
    estimate: fc.oneof(
      fc.constant(null),
      fc.double({ min: -5, max: 5, noNaN: true, noDefaultInfinity: true }),
      fc.constant(0),
    ),
    previous: fc.oneof(
      fc.constant(null),
      fc.double({ min: -5, max: 5, noNaN: true, noDefaultInfinity: true }),
      fc.constant(0),
    ),
    currency: fc.oneof(
      fc.constant('USD'),
      fc.constant('EUR'),
      fc.constant('GBP'),
      fc.constant('JPY'),
    ),
  });
}

/**
 * Generates an array of EconomicEvents with distinct event_date values.
 * The base timestamp is fixed, and each event is offset by its index.
 */
function arbEconomicEventArray(minLen: number, maxLen: number): fc.Arbitrary<EconomicEvent[]> {
  const baseMs = new Date('2024-06-01T00:00:00Z').getTime();

  return fc.integer({ min: minLen, max: maxLen }).chain((count) => {
    const arbitraries: fc.Arbitrary<EconomicEvent>[] = [];
    for (let i = 0; i < count; i++) {
      arbitraries.push(arbEconomicEvent(baseMs, i));
    }
    return arbitraries.length === 0
      ? fc.constant([] as EconomicEvent[])
      : fc.tuple(...(arbitraries as [fc.Arbitrary<EconomicEvent>, ...fc.Arbitrary<EconomicEvent>[]])).map(
          (events) => events as EconomicEvent[]
        );
  });
}

/**
 * Deterministic shuffle: reverses the array.
 * This guarantees a different order for arrays with length >= 2
 * while being fully deterministic (no RNG involved).
 */
function deterministicShuffle<T>(arr: T[]): T[] {
  return [...arr].reverse();
}

// =============================================================================
// Helpers
// =============================================================================

/**
 * Clamps a value to the range [min, max].
 */
function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

// =============================================================================
// Property 7: Surprise factor is bounded
// =============================================================================

describe('Macro Context Engine Property Tests', () => {
  // ===========================================================================
  // Property 5: Macro output vector invariant
  // ===========================================================================
  describe('Property 5: Macro output vector invariant', () => {
    /**
     * **Validates: Requirements 5.4, 5.5, 7.1, 7.2, 7.3, 7.4, 7.5, 7.6, 12.6**
     *
     * For any valid MacroContextEngineInput (including empty event arrays),
     * the MacroContextEngineOutput SHALL have a vector with exactly 8 dimensions
     * where every dimension value is in [0, 1] and rounded to exactly 6 decimal places.
     */
    it('output vector has exactly 8 dimensions, all in [0, 1], rounded to 6dp', () => {
      fc.assert(
        fc.property(arbMacroInput(), (input) => {
          const output = computeMacroContext(input);
          const vector = output.vector;

          // Vector has exactly 8 dimensions
          const keys = Object.keys(vector);
          expect(keys).toHaveLength(8);
          expect(keys.sort()).toEqual([...VECTOR_DIMENSIONS].sort());

          // All dimensions in [0, 1] and rounded to 6 decimal places
          for (const dim of VECTOR_DIMENSIONS) {
            const value = vector[dim];
            expect(value).toBeGreaterThanOrEqual(0);
            expect(value).toBeLessThanOrEqual(1);
            expect(isRoundedTo6(value)).toBe(true);
          }
        }),
        { numRuns: 200 }
      );
    });

    /**
     * **Validates: Requirements 5.4, 5.5, 12.6**
     *
     * The macro_state scalar is in [0, 1] and rounded to 6 decimal places.
     */
    it('macro_state is in [0, 1] and rounded to 6 decimal places', () => {
      fc.assert(
        fc.property(arbMacroInput(), (input) => {
          const output = computeMacroContext(input);

          expect(output.macro_state).toBeGreaterThanOrEqual(0);
          expect(output.macro_state).toBeLessThanOrEqual(1);
          expect(isRoundedTo6(output.macro_state)).toBe(true);
        }),
        { numRuns: 200 }
      );
    });

    /**
     * **Validates: Requirements 7.1, 7.2, 7.3, 7.4, 7.5, 7.6**
     *
     * composite_macro_state equals the weighted average of the first 7 dimensions
     * with weights [0.25, 0.20, 0.15, 0.15, 0.05, 0.05, 0.15] (sum = 1.0).
     */
    it('composite_macro_state equals weighted average of first 7 dimensions', () => {
      fc.assert(
        fc.property(arbMacroInput(), (input) => {
          const output = computeMacroContext(input);
          const vector = output.vector;

          // Get the first 7 dimension values (excluding composite_macro_state)
          const firstSevenDims = [
            vector.event_proximity_pressure,
            vector.aggregate_surprise_factor,
            vector.rate_differential,
            vector.high_impact_event_count,
            vector.medium_impact_event_count,
            vector.event_density,
            vector.upcoming_event_intensity,
          ];

          // Compute expected weighted sum from the rounded dimension values.
          // Note: The implementation computes composite from unrounded intermediates,
          // then rounds once. Recomputing from already-rounded values can introduce
          // up to ±0.000001 discrepancy, so we use a tolerance-based comparison.
          let weightedSum = 0;
          for (let i = 0; i < 7; i++) {
            weightedSum += firstSevenDims[i] * COMPOSITE_WEIGHTS[i];
          }

          const expectedComposite = roundTo6(weightedSum);

          expect(Math.abs(vector.composite_macro_state - expectedComposite)).toBeLessThanOrEqual(0.000002);
        }),
        { numRuns: 200 }
      );
    });
  });

  // ===========================================================================
  // Property 6: Event proximity is bounded and monotonically decreasing
  // ===========================================================================
  describe('Property 6: Event proximity is bounded and monotonically decreasing', () => {
    /**
     * **Validates: Requirements 6.1**
     *
     * computeEventProximity always returns a value in [0, 1] for any
     * non-negative input.
     */
    it('always returns value in [0, 1] for any non-negative input', () => {
      fc.assert(
        fc.property(
          fc.double({ min: 0, max: 1000, noNaN: true, noDefaultInfinity: true }),
          (hoursToEvent) => {
            const result = computeEventProximity(hoursToEvent);
            expect(result).toBeGreaterThanOrEqual(0);
            expect(result).toBeLessThanOrEqual(1);
          }
        ),
        { numRuns: 200 }
      );
    });

    /**
     * **Validates: Requirements 6.1**
     *
     * Monotonicity: for any h1 < h2 (both non-negative),
     * computeEventProximity(h1) >= computeEventProximity(h2).
     * Closer events produce higher pressure.
     */
    it('is monotonically decreasing: result(h1) >= result(h2) for h1 < h2', () => {
      fc.assert(
        fc.property(
          fc.double({ min: 0, max: 1000, noNaN: true, noDefaultInfinity: true }),
          fc.double({ min: 0, max: 1000, noNaN: true, noDefaultInfinity: true }),
          (a, b) => {
            // Ensure h1 < h2
            const h1 = Math.min(a, b);
            const h2 = Math.max(a, b);

            const r1 = computeEventProximity(h1);
            const r2 = computeEventProximity(h2);

            expect(r1).toBeGreaterThanOrEqual(r2);
          }
        ),
        { numRuns: 200 }
      );
    });

    /**
     * **Validates: Requirements 6.1**
     *
     * Boundary: hours > 24 always returns exactly 0.
     * Events more than 24 hours away contribute zero proximity pressure.
     */
    it('returns exactly 0 for hours > 24', () => {
      fc.assert(
        fc.property(
          fc.double({ min: 24.000001, max: 10000, noNaN: true, noDefaultInfinity: true }),
          (hoursToEvent) => {
            const result = computeEventProximity(hoursToEvent);
            expect(result).toBe(0);
          }
        ),
        { numRuns: 200 }
      );
    });

    /**
     * **Validates: Requirements 6.1**
     *
     * Boundary: hours = 0 returns exactly 1.
     * An event happening right now produces maximum proximity pressure.
     */
    it('returns exactly 1 for hours = 0', () => {
      const result = computeEventProximity(0);
      expect(result).toBe(1);
    });
  });

  // ===========================================================================
  // Property 7: Surprise factor is bounded
  // ===========================================================================
  describe('Property 7: Surprise factor is bounded', () => {
    /**
     * **Validates: Requirements 6.2, 8.5**
     *
     * For any actual/estimate pair (including estimate = 0),
     * computeSurpriseFactor(actual, estimate) SHALL return a value in [0, 1].
     */
    it('result always in [0, 1] for any actual/estimate combination', () => {
      const arbEstimate = fc.oneof(
        fc.constant(0),
        fc.double({ min: -1000, max: 1000, noNaN: true, noDefaultInfinity: true })
      );
      const arbActual = fc.double({ min: -1000, max: 1000, noNaN: true, noDefaultInfinity: true });

      fc.assert(
        fc.property(arbActual, arbEstimate, (actual, estimate) => {
          const result = computeSurpriseFactor(actual, estimate);

          expect(result).toBeGreaterThanOrEqual(0);
          expect(result).toBeLessThanOrEqual(1);
        }),
        { numRuns: 500 }
      );
    });

    /**
     * **Validates: Requirements 6.2**
     *
     * When estimate ≠ 0, the formula matches:
     * mapToUnitInterval(clamp((actual - estimate) / |estimate|, -1, 1))
     */
    it('when estimate ≠ 0, formula matches (actual - estimate) / |estimate| clamped and mapped', () => {
      const arbNonZeroEstimate = fc.double({ min: -1000, max: 1000, noNaN: true, noDefaultInfinity: true })
        .filter((v) => v !== 0);
      const arbActual = fc.double({ min: -1000, max: 1000, noNaN: true, noDefaultInfinity: true });

      fc.assert(
        fc.property(arbActual, arbNonZeroEstimate, (actual, estimate) => {
          const result = computeSurpriseFactor(actual, estimate);
          const expected = mapToUnitInterval(clamp((actual - estimate) / Math.abs(estimate), -1, 1));

          expect(result).toBe(expected);
        }),
        { numRuns: 500 }
      );
    });

    /**
     * **Validates: Requirements 8.5**
     *
     * When estimate = 0, the formula matches:
     * mapToUnitInterval(clamp(actual - estimate, -1, 1))
     */
    it('when estimate = 0, formula matches absolute difference clamped and mapped', () => {
      const arbActual = fc.double({ min: -1000, max: 1000, noNaN: true, noDefaultInfinity: true });

      fc.assert(
        fc.property(arbActual, (actual) => {
          const result = computeSurpriseFactor(actual, 0);
          const expected = mapToUnitInterval(clamp(actual - 0, -1, 1));

          expect(result).toBe(expected);
        }),
        { numRuns: 500 }
      );
    });

    /**
     * **Validates: Requirements 6.2, 8.5**
     *
     * When actual = estimate (no surprise), the result should be 0.5 (neutral).
     */
    it('result = 0.5 when actual = estimate (no surprise)', () => {
      const arbValue = fc.oneof(
        fc.constant(0),
        fc.double({ min: -1000, max: 1000, noNaN: true, noDefaultInfinity: true })
      );

      fc.assert(
        fc.property(arbValue, (value) => {
          const result = computeSurpriseFactor(value, value);

          expect(result).toBe(0.5);
        }),
        { numRuns: 200 }
      );
    });
  });

  // ===========================================================================
  // Property 8: Macro order-independence
  // ===========================================================================
  describe('Property 8: Macro order-independence', () => {
    /**
     * **Validates: Requirements 6.3, 12.2**
     *
     * For any set of EconomicEvent records and any permutation of that set,
     * computeMacroContext SHALL produce bit-identical output. The aggregation
     * logic (weighted mean, counts, filters) is commutative — the order events
     * appear in the input array does not affect any output dimension.
     *
     * Events are generated with distinct event_date values to avoid sort-stability
     * ambiguity in the rate_differential computation (which sorts by event_date DESC).
     */
    it('should produce bit-identical output regardless of event order (reversed)', () => {
      const referenceTime = '2024-06-01T12:00:00.000Z';

      fc.assert(
        fc.property(
          arbEconomicEventArray(1, 20),
          (events) => {
            const shuffled = deterministicShuffle(events);

            const input1: MacroContextEngineInput = {
              events,
              reference_time: referenceTime,
              lookback_hours: 72,
              lookahead_hours: 24,
            };

            const input2: MacroContextEngineInput = {
              events: shuffled,
              reference_time: referenceTime,
              lookback_hours: 72,
              lookahead_hours: 24,
            };

            const output1 = computeMacroContext(input1);
            const output2 = computeMacroContext(input2);

            // Assert bit-identical output for both permutations
            expect(output1).toEqual(output2);
          }
        ),
        { numRuns: 200 }
      );
    });

    it('should produce bit-identical output for index-swapped permutation', () => {
      const referenceTime = '2024-06-01T12:00:00.000Z';

      fc.assert(
        fc.property(
          arbEconomicEventArray(2, 20),
          (events) => {
            // Deterministic shuffle: swap adjacent pairs
            const swapped = [...events];
            for (let i = 0; i < swapped.length - 1; i += 2) {
              [swapped[i], swapped[i + 1]] = [swapped[i + 1], swapped[i]];
            }

            const input1: MacroContextEngineInput = {
              events,
              reference_time: referenceTime,
              lookback_hours: 72,
              lookahead_hours: 24,
            };

            const input2: MacroContextEngineInput = {
              events: swapped,
              reference_time: referenceTime,
              lookback_hours: 72,
              lookahead_hours: 24,
            };

            const output1 = computeMacroContext(input1);
            const output2 = computeMacroContext(input2);

            // Assert all vector dimensions are bit-identical
            expect(output1.vector.event_proximity_pressure).toBe(output2.vector.event_proximity_pressure);
            expect(output1.vector.aggregate_surprise_factor).toBe(output2.vector.aggregate_surprise_factor);
            expect(output1.vector.rate_differential).toBe(output2.vector.rate_differential);
            expect(output1.vector.high_impact_event_count).toBe(output2.vector.high_impact_event_count);
            expect(output1.vector.medium_impact_event_count).toBe(output2.vector.medium_impact_event_count);
            expect(output1.vector.event_density).toBe(output2.vector.event_density);
            expect(output1.vector.upcoming_event_intensity).toBe(output2.vector.upcoming_event_intensity);
            expect(output1.vector.composite_macro_state).toBe(output2.vector.composite_macro_state);

            // Assert scalar state is bit-identical
            expect(output1.macro_state).toBe(output2.macro_state);
            expect(output1.event_count).toBe(output2.event_count);
          }
        ),
        { numRuns: 200 }
      );
    });
  });
});
