/**
 * News Risk Evaluator Property Tests
 *
 * Property 9: News risk flag correctness
 *
 * **Validates: Requirements 9.2, 9.3**
 */

import { describe, it, expect, vi } from 'vitest';
import * as fc from 'fast-check';
import { evaluateNewsRiskFromEvents, evaluateNewsRisk } from '../news-risk-evaluator.js';
import type { NewsRiskEvaluatorInput } from '../../types/macro.js';

// =============================================================================
// Generators
// =============================================================================

/**
 * Generates a random ISO-8601 UTC timestamp within a reasonable range.
 */
function arbIsoTimestamp(minMs: number, maxMs: number): fc.Arbitrary<string> {
  return fc
    .integer({ min: minMs, max: maxMs })
    .map((ms) => new Date(ms).toISOString());
}

/**
 * Generates a random event name.
 */
function arbEventName(): fc.Arbitrary<string> {
  return fc.oneof(
    fc.constant('US Non-Farm Payrolls'),
    fc.constant('ECB Rate Decision'),
    fc.constant('US CPI'),
    fc.constant('UK GDP'),
    fc.constant('Fed Interest Rate Decision'),
    fc.constant('BOJ Rate Decision'),
    fc.constant('Eurozone PMI'),
    fc.constant('US Retail Sales'),
    fc.string({ minLength: 3, maxLength: 30 }),
  );
}

/**
 * Generates a random currency code.
 */
function arbCurrency(): fc.Arbitrary<string> {
  return fc.constantFrom('USD', 'EUR', 'GBP', 'JPY', 'AUD', 'CAD', 'CHF', 'NZD');
}

/**
 * Generates a random impact level.
 */
function arbImpact(): fc.Arbitrary<'high' | 'medium' | 'low'> {
  return fc.constantFrom('high', 'medium', 'low') as fc.Arbitrary<'high' | 'medium' | 'low'>;
}

// =============================================================================
// Property 9: News risk flag correctness
// =============================================================================

describe('News Risk Evaluator Property Tests', () => {
  describe('Property 9: News risk flag correctness (pure logic)', () => {
    /**
     * **Validates: Requirements 9.2, 9.3**
     *
     * For any set of events that have already been filtered (high-impact,
     * matching currency, within 8-hour window), news_risk_flag SHALL equal
     * true if and only if the set is non-empty, and false if and only if
     * the set is empty.
     */
    it('flag = true iff events array is non-empty (pure helper)', () => {
      const baseMs = new Date('2024-06-01T12:00:00Z').getTime();

      fc.assert(
        fc.property(
          // Generate 0-20 events that are "already filtered" (within window)
          fc.array(
            fc.record({
              name: arbEventName(),
              event_date: arbIsoTimestamp(
                baseMs + 1000, // just after evaluation time
                baseMs + 8 * 60 * 60 * 1000, // up to 8 hours ahead
              ),
            }),
            { minLength: 0, maxLength: 20 },
          ),
          (events) => {
            const evaluationTime = new Date(baseMs).toISOString();
            const result = evaluateNewsRiskFromEvents(events, evaluationTime);

            if (events.length > 0) {
              // Flag must be true when events exist
              expect(result.news_risk_flag).toBe(true);
              // Triggering events must match event names
              expect(result.triggering_events).toHaveLength(events.length);
              // hours_to_nearest must be a finite positive number
              expect(result.hours_to_nearest).not.toBeNull();
              expect(result.hours_to_nearest!).toBeGreaterThan(0);
              expect(result.hours_to_nearest!).toBeLessThanOrEqual(8);
            } else {
              // Flag must be false when no events exist
              expect(result.news_risk_flag).toBe(false);
              expect(result.triggering_events).toHaveLength(0);
              expect(result.hours_to_nearest).toBeNull();
            }
          },
        ),
        { numRuns: 200 },
      );
    });

    /**
     * **Validates: Requirements 9.2**
     *
     * When at least one event is provided, the flag is always true.
     */
    it('flag = true when at least one event exists', () => {
      const baseMs = new Date('2024-06-01T12:00:00Z').getTime();

      fc.assert(
        fc.property(
          fc.array(
            fc.record({
              name: arbEventName(),
              event_date: arbIsoTimestamp(
                baseMs + 1000,
                baseMs + 8 * 60 * 60 * 1000,
              ),
            }),
            { minLength: 1, maxLength: 20 },
          ),
          (events) => {
            const evaluationTime = new Date(baseMs).toISOString();
            const result = evaluateNewsRiskFromEvents(events, evaluationTime);

            expect(result.news_risk_flag).toBe(true);
          },
        ),
        { numRuns: 200 },
      );
    });

    /**
     * **Validates: Requirements 9.3**
     *
     * When zero events are provided, the flag is always false.
     */
    it('flag = false when zero events exist', () => {
      fc.assert(
        fc.property(
          arbIsoTimestamp(
            new Date('2020-01-01T00:00:00Z').getTime(),
            new Date('2025-12-31T23:59:59Z').getTime(),
          ),
          (evaluationTime) => {
            const result = evaluateNewsRiskFromEvents([], evaluationTime);

            expect(result.news_risk_flag).toBe(false);
            expect(result.triggering_events).toHaveLength(0);
            expect(result.hours_to_nearest).toBeNull();
          },
        ),
        { numRuns: 200 },
      );
    });
  });

  describe('Property 9: News risk flag correctness (full function with mocked DB)', () => {
    /**
     * **Validates: Requirements 9.2, 9.3**
     *
     * For the full evaluateNewsRisk function: generate random events with
     * varying impact levels and currencies, mock the Supabase client to
     * simulate the query chain, and verify the flag matches whether any
     * high-impact events exist within the window for the given currencies.
     */
    it('flag matches presence of high-impact events within window for given currencies', () => {
      const baseMs = new Date('2024-06-01T12:00:00Z').getTime();
      const evaluationTime = new Date(baseMs).toISOString();
      const lookaheadHours = 8;
      const windowEndMs = baseMs + lookaheadHours * 60 * 60 * 1000;

      fc.assert(
        fc.asyncProperty(
          // Generate array of events with random impact levels and currencies
          fc.array(
            fc.record({
              name: arbEventName(),
              event_date: arbIsoTimestamp(
                baseMs - 2 * 60 * 60 * 1000, // some before window
                baseMs + 10 * 60 * 60 * 1000, // some after window
              ),
              impact: arbImpact(),
              currency: arbCurrency(),
            }),
            { minLength: 0, maxLength: 20 },
          ),
          // Generate random asset currencies to filter on
          fc.array(arbCurrency(), { minLength: 1, maxLength: 3 }),
          async (events, assetCurrencies) => {
            // Determine which events would pass the DB filter:
            // - impact = 'high'
            // - currency IN assetCurrencies
            // - event_date > evaluationTime
            // - event_date <= windowEnd
            const windowEnd = new Date(windowEndMs).toISOString();
            const filteredEvents = events.filter(
              (e) =>
                e.impact === 'high' &&
                assetCurrencies.includes(e.currency) &&
                e.event_date > evaluationTime &&
                e.event_date <= windowEnd,
            );

            // Sort by event_date ascending (as the query does)
            const sortedFiltered = [...filteredEvents].sort(
              (a, b) =>
                new Date(a.event_date).getTime() - new Date(b.event_date).getTime(),
            );

            // Mock the Supabase query builder chain
            const mockData = sortedFiltered.map((e) => ({
              name: e.name,
              event_date: e.event_date,
            }));

            const mockSupabase = {
              from: vi.fn().mockReturnValue({
                select: vi.fn().mockReturnValue({
                  eq: vi.fn().mockReturnValue({
                    in: vi.fn().mockReturnValue({
                      gt: vi.fn().mockReturnValue({
                        lte: vi.fn().mockReturnValue({
                          order: vi.fn().mockResolvedValue({
                            data: mockData,
                            error: null,
                          }),
                        }),
                      }),
                    }),
                  }),
                }),
              }),
            } as any;

            const input: NewsRiskEvaluatorInput = {
              evaluation_time: evaluationTime,
              asset_currencies: assetCurrencies,
              lookahead_hours: lookaheadHours,
            };

            const result = await evaluateNewsRisk(input, mockSupabase);

            // Property 9: flag = true iff filtered set is non-empty
            if (sortedFiltered.length > 0) {
              expect(result.news_risk_flag).toBe(true);
              expect(result.triggering_events.length).toBeGreaterThan(0);
              expect(result.hours_to_nearest).not.toBeNull();
              expect(result.hours_to_nearest!).toBeGreaterThan(0);
            } else {
              expect(result.news_risk_flag).toBe(false);
              expect(result.triggering_events).toHaveLength(0);
              expect(result.hours_to_nearest).toBeNull();
            }
          },
        ),
        { numRuns: 200 },
      );
    });
  });
});
