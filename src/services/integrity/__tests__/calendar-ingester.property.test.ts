import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fc from 'fast-check';
import { classifyEventImpact, ingestCalendar, parseCalendarCsv } from '../calendar-ingester.js';
import { RateLimitRegistry } from '../../ingestion/rate-limiter.js';

/**
 * Property 7: Event Impact Classification
 * Validates: Requirements 5.4
 *
 * For any economic event name:
 * - Containing NFP, Non-Farm, CPI, GDP, or Rate Decision (case-insensitive) → "high"
 * - Containing PMI or Retail Sales (case-insensitive), but no high-impact keyword → "medium"
 * - Not containing any of the above keywords → "low"
 */

const HIGH_IMPACT_KEYWORDS = ['nfp', 'non-farm', 'cpi', 'gdp', 'rate decision'];
const MEDIUM_IMPACT_KEYWORDS = ['pmi', 'retail sales'];
const ALL_KEYWORDS = [...HIGH_IMPACT_KEYWORDS, ...MEDIUM_IMPACT_KEYWORDS];

/**
 * Randomly capitalize characters in a string to test case-insensitivity.
 */
const arbRandomCase = (keyword: string): fc.Arbitrary<string> =>
  fc.array(fc.boolean(), { minLength: keyword.length, maxLength: keyword.length }).map(
    (flags) => keyword.split('').map((ch, i) => (flags[i] ? ch.toUpperCase() : ch.toLowerCase())).join(''),
  );

/**
 * Generates a safe padding string that does not accidentally contain any keywords.
 */
const arbSafePadding = fc.string({
  minLength: 0,
  maxLength: 15,
  unit: fc.constantFrom(...'abxyz0123456789 _-.!@#'.split('')),
}).filter((s) => {
  const lower = s.toLowerCase();
  return !ALL_KEYWORDS.some((kw) => lower.includes(kw));
});

/**
 * Generates an event name that contains a high-impact keyword with random casing
 * and arbitrary safe prefix/suffix.
 */
const arbHighImpactName = fc.tuple(
  arbSafePadding,
  fc.constantFrom(...HIGH_IMPACT_KEYWORDS).chain(arbRandomCase),
  arbSafePadding,
).map(([prefix, keyword, suffix]) => `${prefix}${keyword}${suffix}`);

/**
 * Generates an event name that contains a medium-impact keyword with random casing
 * and arbitrary safe prefix/suffix, but does NOT contain any high-impact keyword.
 */
const arbMediumImpactName = fc.tuple(
  arbSafePadding,
  fc.constantFrom(...MEDIUM_IMPACT_KEYWORDS).chain(arbRandomCase),
  arbSafePadding,
).map(([prefix, keyword, suffix]) => `${prefix}${keyword}${suffix}`)
  .filter((name) => {
    const lower = name.toLowerCase();
    return !HIGH_IMPACT_KEYWORDS.some((kw) => lower.includes(kw));
  });

/**
 * Generates an event name that does NOT contain any high or medium impact keyword.
 */
const arbLowImpactName = fc.string({
  minLength: 0,
  maxLength: 40,
  unit: fc.constantFrom(...'abxyz0123456789 _-.!@#'.split('')),
}).filter((s) => {
  const lower = s.toLowerCase();
  return !ALL_KEYWORDS.some((kw) => lower.includes(kw));
});

describe('Property 7: Event Impact Classification', () => {
  /**
   * Validates: Requirements 5.4
   * Names containing high-impact keywords (NFP, Non-Farm, CPI, GDP, Rate Decision)
   * always return "high", regardless of casing.
   */
  it('names containing high-impact keywords return "high"', () => {
    fc.assert(
      fc.property(arbHighImpactName, (eventName) => {
        expect(classifyEventImpact(eventName)).toBe('high');
      }),
      { numRuns: 100 },
    );
  });

  /**
   * Validates: Requirements 5.4
   * Names containing medium-impact keywords (PMI, Retail Sales) but no high-impact
   * keyword always return "medium", regardless of casing.
   */
  it('names containing medium-impact keywords (without high-impact) return "medium"', () => {
    fc.assert(
      fc.property(arbMediumImpactName, (eventName) => {
        expect(classifyEventImpact(eventName)).toBe('medium');
      }),
      { numRuns: 100 },
    );
  });

  /**
   * Validates: Requirements 5.4
   * Names that do not contain any high or medium impact keyword return "low".
   */
  it('names without any impact keywords return "low"', () => {
    fc.assert(
      fc.property(arbLowImpactName, (eventName) => {
        expect(classifyEventImpact(eventName)).toBe('low');
      }),
      { numRuns: 100 },
    );
  });
});


/**
 * Property 6: Economic Event Selective Upsert
 * Validates: Requirements 5.3, 9.3
 *
 * For any economic event with a given (name, event_date) pair, re-inserting with a
 * different actual value SHALL update only the actual column — all other columns
 * (estimate, previous, impact, currency) SHALL remain unchanged.
 *
 * This test verifies:
 * 1. The upsert uses onConflict: 'name,event_date' with ignoreDuplicates: true (skips existing rows)
 * 2. The update call only passes { actual: event.actual } — proving only actual is modified
 * 3. parseCalendarCsv correctly uses classifyEventImpact for impact classification
 */

/** Generates a random event name (safe characters, no commas or newlines). */
const arbEventName = fc.string({ minLength: 1, maxLength: 30, unit: fc.constantFrom(...'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789 -'.split('')) })
  .filter((s) => s.trim().length > 0);

/** Generates a random numeric value or null. */
const arbNumericOrNull = fc.oneof(fc.double({ min: -1000, max: 1000, noNaN: true }), fc.constant(null));

/** Generates a random currency code (3-letter uppercase). */
const arbCurrency = fc.string({ minLength: 3, maxLength: 3, unit: fc.constantFrom(...'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('')) });

/** Generates an arbitrary economic event for CSV data with today's date to pass date filter. */
const arbEconomicEventCsv = fc.record({
  name: arbEventName,
  actual: fc.double({ min: -1000, max: 1000, noNaN: true }),
  estimate: arbNumericOrNull,
  previous: arbNumericOrNull,
  currency: arbCurrency,
});

/**
 * Creates a mock Supabase client that tracks upsert and update operations.
 * Returns the mock client plus arrays for inspecting captured calls.
 */
function createTrackingSupabaseMock() {
  const upsertCalls: { data: unknown; options: unknown }[] = [];
  const updateCalls: { data: unknown }[] = [];

  const mockSupabase = {
    from: (_table: string) => ({
      upsert: (data: unknown, options: unknown) => {
        upsertCalls.push({ data, options });
        return {
          select: (_cols: string) => ({
            data: Array.isArray(data) ? data : [data],
            error: null,
          }),
        };
      },
      update: (data: unknown) => {
        updateCalls.push({ data });
        return {
          eq: (_col1: string, _val1: unknown) => ({
            eq: (_col2: string, _val2: unknown) => ({
              data: null,
              error: null,
            }),
          }),
        };
      },
    }),
  } as any;

  return { mockSupabase, upsertCalls, updateCalls };
}

describe('Property 6: Economic Event Selective Upsert', () => {
  let originalFetch: typeof globalThis.fetch;
  let originalEnv: string | undefined;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    originalEnv = process.env.ALPHA_VANTAGE_API_KEY;
    process.env.ALPHA_VANTAGE_API_KEY = 'test-key';
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    process.env.ALPHA_VANTAGE_API_KEY = originalEnv;
    vi.restoreAllMocks();
  });

  /**
   * Validates: Requirements 5.3, 9.3
   * For any event with a non-null actual, the update call only modifies the actual column.
   * The upsert uses ignoreDuplicates: true (not overwriting), and the separate update
   * call passes only { actual: event.actual }.
   */
  it('re-insert with different actual updates only actual column via selective update', async () => {
    await fc.assert(
      fc.asyncProperty(arbEconomicEventCsv, async (event) => {
        const { mockSupabase, upsertCalls, updateCalls } = createTrackingSupabaseMock();

        // Use today's date so the event passes the date range filter
        const today = new Date();
        today.setUTCHours(0, 0, 0, 0);
        const eventDate = today.toISOString().split('T')[0];

        const csvText = [
          'timestamp,name,actual,estimate,previous,currency',
          `${eventDate},${event.name},${event.actual},${event.estimate ?? ''},${event.previous ?? ''},${event.currency}`,
        ].join('\n');

        // Mock fetch to return the CSV
        globalThis.fetch = vi.fn().mockResolvedValue({
          ok: true,
          text: () => Promise.resolve(csvText),
        } as unknown as Response);

        // Create rate limit registry that allows requests
        const rateLimits = new RateLimitRegistry();
        rateLimits.register('alpha_vantage', { dailyLimit: 25, perMinuteLimit: 5 });

        // Execute ingestCalendar
        await ingestCalendar(mockSupabase, rateLimits, {
          forwardDays: 7,
          backwardDays: 1,
        });

        // Verify the upsert used ignoreDuplicates: true and onConflict: 'name,event_date'
        expect(upsertCalls.length).toBeGreaterThanOrEqual(1);
        for (const call of upsertCalls) {
          const opts = call.options as { onConflict?: string; ignoreDuplicates?: boolean };
          expect(opts.onConflict).toBe('name,event_date');
          expect(opts.ignoreDuplicates).toBe(true);
        }

        // The event has a non-null actual (generated as fc.double), so verify
        // update call only touches 'actual'
        expect(updateCalls.length).toBeGreaterThanOrEqual(1);
        for (const updateCall of updateCalls) {
          // The update payload must ONLY contain { actual: <value> }
          const payload = updateCall.data as Record<string, unknown>;
          const keys = Object.keys(payload);
          expect(keys).toEqual(['actual']);
          // No other columns (estimate, previous, impact, currency) should be present
          expect(payload).not.toHaveProperty('estimate');
          expect(payload).not.toHaveProperty('previous');
          expect(payload).not.toHaveProperty('impact');
          expect(payload).not.toHaveProperty('currency');
          expect(payload).not.toHaveProperty('name');
          expect(payload).not.toHaveProperty('event_date');
        }
      }),
      { numRuns: 100 },
    );
  });

  /**
   * Validates: Requirements 5.3, 9.3
   * parseCalendarCsv correctly uses classifyEventImpact for impact classification
   * on any arbitrary CSV input.
   */
  it('parseCalendarCsv uses classifyEventImpact for impact classification on any input', () => {
    fc.assert(
      fc.property(
        fc.array(arbEconomicEventCsv, { minLength: 1, maxLength: 10 }),
        (events) => {
          const header = 'timestamp,name,actual,estimate,previous,currency';
          const rows = events.map((e) =>
            `2024-06-15,${e.name},${e.actual ?? ''},${e.estimate ?? ''},${e.previous ?? ''},${e.currency}`
          );
          const csvText = [header, ...rows].join('\n');

          const parsed = parseCalendarCsv(csvText);

          // Each parsed event's impact must match classifyEventImpact(name)
          for (const parsedEvent of parsed) {
            const expectedImpact = classifyEventImpact(parsedEvent.name);
            expect(parsedEvent.impact).toBe(expectedImpact);
          }
        },
      ),
      { numRuns: 100 },
    );
  });
});
