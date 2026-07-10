import { describe, it, expect } from 'vitest';
import {
  evaluateNewsRisk,
  evaluateNewsRiskFromEvents,
} from '../news-risk-evaluator.js';
import type { NewsRiskEvaluatorInput } from '../../types/index.js';
import type { SupabaseClient } from '@supabase/supabase-js';

// =============================================================================
// Helpers
// =============================================================================

/**
 * Creates a mock Supabase client where all builder methods return `this`
 * (chainable), and the final call resolves to `{ data, error }`.
 * The builder is PromiseLike (has `.then`) so it can be awaited directly.
 */
function createMockSupabase(result: { data: unknown; error: unknown }) {
  const builder = {
    select: () => builder,
    eq: () => builder,
    in: () => builder,
    gt: () => builder,
    lte: () => builder,
    order: () => builder,
    then: (resolve: (value: unknown) => void) => resolve(result),
  };
  return { from: () => builder } as unknown as SupabaseClient;
}

/**
 * Creates a mock Supabase client that throws an exception when awaited.
 */
function createThrowingSupabase(errorMessage: string) {
  const builder = {
    select: () => builder,
    eq: () => builder,
    in: () => builder,
    gt: () => builder,
    lte: () => builder,
    order: () => builder,
    then: () => {
      throw new Error(errorMessage);
    },
  };
  return { from: () => builder } as unknown as SupabaseClient;
}

function makeInput(overrides: Partial<NewsRiskEvaluatorInput> = {}): NewsRiskEvaluatorInput {
  return {
    evaluation_time: '2024-06-15T08:00:00Z',
    asset_currencies: ['USD', 'EUR'],
    lookahead_hours: 8,
    ...overrides,
  };
}

// =============================================================================
// Tests
// =============================================================================

describe('News Risk Evaluator', () => {
  describe('evaluateNewsRisk (with DB access)', () => {
    it('returns flag = true when high-impact event is 4h in future (Req 9.2)', async () => {
      const evaluationTime = '2024-06-15T08:00:00Z';
      const eventDate = '2024-06-15T12:00:00Z'; // 4h later

      const supabase = createMockSupabase({
        data: [{ name: 'FOMC Rate Decision', event_date: eventDate }],
        error: null,
      });

      const input = makeInput({ evaluation_time: evaluationTime });
      const result = await evaluateNewsRisk(input, supabase);

      expect(result.news_risk_flag).toBe(true);
      expect(result.triggering_events).toContain('FOMC Rate Decision');
      expect(result.hours_to_nearest).toBeCloseTo(4.0, 5);
    });

    it('returns flag = false when no data returned (Req 9.3)', async () => {
      const supabase = createMockSupabase({ data: [], error: null });

      const input = makeInput();
      const result = await evaluateNewsRisk(input, supabase);

      expect(result.news_risk_flag).toBe(false);
      expect(result.triggering_events).toHaveLength(0);
      expect(result.hours_to_nearest).toBeNull();
    });

    it('returns flag = false when only medium-impact events exist (query filters for high)', async () => {
      // The Supabase query filters `.eq('impact', 'high')` so medium-impact
      // events never reach the evaluator. Mock returns empty.
      const supabase = createMockSupabase({ data: [], error: null });

      const input = makeInput();
      const result = await evaluateNewsRisk(input, supabase);

      expect(result.news_risk_flag).toBe(false);
      expect(result.triggering_events).toHaveLength(0);
      expect(result.hours_to_nearest).toBeNull();
    });

    it('returns flag = false when currencies do not match (Req 9.6)', async () => {
      // USD event not flagged for GBPJPY — query uses `.in('currency', asset_currencies)`
      // so when asset_currencies = ['GBP', 'JPY'], a USD event would not be returned.
      const supabase = createMockSupabase({ data: [], error: null });

      const input = makeInput({ asset_currencies: ['GBP', 'JPY'] });
      const result = await evaluateNewsRisk(input, supabase);

      expect(result.news_risk_flag).toBe(false);
      expect(result.triggering_events).toHaveLength(0);
      expect(result.hours_to_nearest).toBeNull();
    });

    it('returns flag = true (conservative) on database error', async () => {
      const supabase = createMockSupabase({
        data: null,
        error: { message: 'connection failed' },
      });

      const input = makeInput();
      const result = await evaluateNewsRisk(input, supabase);

      expect(result.news_risk_flag).toBe(true);
      expect(result.triggering_events).toHaveLength(0);
      expect(result.hours_to_nearest).toBeNull();
    });

    it('returns flag = true (conservative) on unexpected exception', async () => {
      const supabase = createThrowingSupabase('network timeout');

      const input = makeInput();
      const result = await evaluateNewsRisk(input, supabase);

      expect(result.news_risk_flag).toBe(true);
      expect(result.triggering_events).toHaveLength(0);
      expect(result.hours_to_nearest).toBeNull();
    });

    it('returns flag = false when currency list is empty (early return, no DB query)', async () => {
      // With an empty currencies array the function should early-return
      // without even hitting the database.
      const supabase = createMockSupabase({
        data: [{ name: 'Should Not Be Reached', event_date: '2024-06-15T10:00:00Z' }],
        error: null,
      });

      const input = makeInput({ asset_currencies: [] });
      const result = await evaluateNewsRisk(input, supabase);

      expect(result.news_risk_flag).toBe(false);
      expect(result.triggering_events).toHaveLength(0);
      expect(result.hours_to_nearest).toBeNull();
    });
  });

  describe('evaluateNewsRiskFromEvents (pure logic)', () => {
    it('returns flag = false when events array is empty', () => {
      const result = evaluateNewsRiskFromEvents([], '2024-06-15T08:00:00Z');

      expect(result.news_risk_flag).toBe(false);
      expect(result.triggering_events).toHaveLength(0);
      expect(result.hours_to_nearest).toBeNull();
    });

    it('returns flag = true with correct hours_to_nearest when events are present', () => {
      const evaluationTime = '2024-06-15T08:00:00Z';
      const events = [
        { name: 'NFP Release', event_date: '2024-06-15T11:30:00Z' },     // 3.5h
        { name: 'FOMC Minutes', event_date: '2024-06-15T14:00:00Z' },    // 6h
      ];

      const result = evaluateNewsRiskFromEvents(events, evaluationTime);

      expect(result.news_risk_flag).toBe(true);
      expect(result.triggering_events).toEqual(['NFP Release', 'FOMC Minutes']);
      expect(result.hours_to_nearest).toBeCloseTo(3.5, 5);
    });

    it('completes computation for 500 events in less than 1 second (Req 13.5)', () => {
      const evaluationTime = '2024-06-15T08:00:00Z';
      const evalMs = new Date(evaluationTime).getTime();

      const events = Array.from({ length: 500 }, (_, i) => ({
        name: `Event ${i}`,
        event_date: new Date(evalMs + (i + 1) * 60000).toISOString(), // every minute
      }));

      const start = performance.now();
      const result = evaluateNewsRiskFromEvents(events, evaluationTime);
      const elapsed = performance.now() - start;

      expect(elapsed).toBeLessThan(1000);
      expect(result.news_risk_flag).toBe(true);
      expect(result.triggering_events).toHaveLength(500);
    });
  });
});
