import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fc from 'fast-check';
import { backfillCandles } from '../candle-backfiller.js';
import { RateLimitRegistry } from '../../ingestion/rate-limiter.js';
import { AssetClass, AssetStatus } from '../../../config/research-assets.js';
import type { ResearchAsset } from '../../../config/research-assets.js';
import type { BackfillInput } from '../types.js';

// ─── Mock env module to provide fake API keys ────────────────────────────────

vi.mock('../../../config/env.js', () => ({
  env: {
    TWELVE_DATA_API_KEY: 'fake-twelve-data-key',
    MASSIVE_API_KEY: 'fake-massive-api-key',
    ALPHA_VANTAGE_API_KEY: 'fake-alpha-vantage-key',
    FINNHUB_API_KEY: 'fake-finnhub-key',
    NEWS_API_KEY: 'fake-news-api-key',
    GCP_PROJECT_ID: 'fake-project',
    GCP_LOCATION: 'us-central1',
    GEMINI_MODEL: 'gemini-2.5-flash',
    SUPABASE_URL: 'https://fake.supabase.co',
    SUPABASE_ANON_KEY: 'fake-anon-key',
    SUPABASE_SERVICE_ROLE_KEY: 'fake-service-role-key',
    RAPIDAPI_PROXY_SECRET: 'fake-secret',
    PORT: 8080,
    NODE_ENV: 'test',
  },
}));

// ─── Constants ───────────────────────────────────────────────────────────────

/** The strict provider ordering that must be enforced. */
const PROVIDER_ORDER = ['twelve_data', 'massive_api', 'yahoo_finance'] as const;

/** A minimal test asset for generating BackfillInput. */
const TEST_ASSET: ResearchAsset = {
  id: 'eurusd',
  symbol: 'EURUSD',
  assetClass: AssetClass.FOREX,
  status: AssetStatus.ACTIVE,
  processingPriority: 1,
  pipSize: 0.0001,
  pricePrecision: 5,
  marketHours: '24x5',
  supportedTimeframes: ['4h'],
  providers: { twelveData: 'EUR/USD', massive: 'EUR/USD', yahoo: 'EURUSD=X' },
  engines: {
    fingerprint: true,
    similarity: true,
    confidence: true,
    tradeability: true,
    sentiment: true,
    macro: true,
  },
};

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Creates a rate limit registry with all three backfill providers registered with generous limits. */
function createTestRegistry(): RateLimitRegistry {
  const registry = new RateLimitRegistry();
  registry.register('twelve_data', { dailyLimit: 10000, perMinuteLimit: 1000 });
  registry.register('massive_api', { dailyLimit: 10000, perMinuteLimit: 1000 });
  registry.register('yahoo_finance', { dailyLimit: 10000, perMinuteLimit: 1000 });
  return registry;
}

/** Create a fake Supabase client that always succeeds on upsert. */
function createFakeSupabase() {
  return {
    from: () => ({
      upsert: () => Promise.resolve({ error: null }),
    }),
  } as any;
}

/**
 * Identifies which provider a fetch URL belongs to.
 * Returns the provider name or null if unrecognized.
 */
function identifyProvider(url: string): string | null {
  if (url.includes('twelvedata.com')) return 'twelve_data';
  if (url.includes('massiveapi.com')) return 'massive_api';
  if (url.includes('finance.yahoo.com')) return 'yahoo_finance';
  return null;
}

/**
 * Creates a successful JSON response for a given provider.
 */
function createSuccessResponse(provider: string): Response {
  let body: any;
  switch (provider) {
    case 'twelve_data':
      body = {
        status: 'ok',
        values: [{ open: '1.1000', high: '1.1050', low: '1.0950', close: '1.1020', volume: '1000' }],
      };
      break;
    case 'massive_api':
      body = {
        candles: [{ open: 1.1, high: 1.105, low: 1.095, close: 1.102, volume: 1000 }],
      };
      break;
    case 'yahoo_finance':
      body = {
        chart: {
          result: [{
            indicators: {
              quote: [{ open: [1.1], high: [1.105], low: [1.095], close: [1.102], volume: [1000] }],
            },
          }],
        },
      };
      break;
  }
  return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
}

/**
 * Creates a failure response (HTTP 500).
 */
function createFailureResponse(): Response {
  return new Response('Internal Server Error', { status: 500, statusText: 'Internal Server Error' });
}

// ─── Generators ──────────────────────────────────────────────────────────────

/**
 * Generates a failure pattern for 3 providers.
 * Each element is true = provider fails, false = provider succeeds.
 */
const arbFailurePattern = fc.tuple(fc.boolean(), fc.boolean(), fc.boolean());

/**
 * Generates a valid ISO-8601 timestamp for a 4H candle.
 * Uses integer offsets from a known-good base date to avoid platform-specific Date edge cases.
 */
const arbTimestamp = fc.integer({ min: 0, max: 730 }).map((dayOffset) => {
  // Start from a known-good date and offset by days, then pick a 4H slot
  const base = new Date('2023-01-02T00:00:00.000Z');
  base.setUTCDate(base.getUTCDate() + dayOffset);
  const hourSlot = (dayOffset % 6) * 4; // 0, 4, 8, 12, 16, 20
  base.setUTCHours(hourSlot, 0, 0, 0);
  return base.toISOString();
});

// ─── Tests ───────────────────────────────────────────────────────────────────

/**
 * Property 2: Provider Fallback Ordering
 * Validates: Requirements 3.2
 *
 * For any candle fetch attempt where the primary provider fails, the system SHALL
 * attempt providers in strict order (Twelve Data → Massive API → Yahoo Finance),
 * advancing to the next only after the current provider fails or times out, and
 * SHALL stop at the first successful response.
 */
describe('Property 2: Provider Fallback Ordering', () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, 'fetch');
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('providers are attempted in strict order and stop at first success', async () => {
    await fc.assert(
      fc.asyncProperty(
        arbFailurePattern,
        arbTimestamp,
        async (failurePattern, timestamp) => {
          const [twelveFails, massiveFails, yahooFails] = failurePattern;

          // Track the order of provider calls
          const calledProviders: string[] = [];

          fetchSpy.mockImplementation(async (input: RequestInfo | URL, _init?: RequestInit) => {
            const url = typeof input === 'string' ? input : input.toString();
            const provider = identifyProvider(url);

            if (provider) {
              calledProviders.push(provider);
            }

            // Simulate success or failure based on the pattern
            if (provider === 'twelve_data') {
              return twelveFails ? createFailureResponse() : createSuccessResponse('twelve_data');
            }
            if (provider === 'massive_api') {
              return massiveFails ? createFailureResponse() : createSuccessResponse('massive_api');
            }
            if (provider === 'yahoo_finance') {
              return yahooFails ? createFailureResponse() : createSuccessResponse('yahoo_finance');
            }

            return createFailureResponse();
          });

          const registry = createTestRegistry();
          const supabase = createFakeSupabase();
          const input: BackfillInput = {
            asset: TEST_ASSET,
            timeframe: '4h',
            missingTimestamps: [timestamp],
          };

          await backfillCandles(supabase, registry, input);

          // ─── Assertions ─────────────────────────────────────────────────

          // 1. Providers are called in strict order (indices are monotonically increasing)
          for (let i = 1; i < calledProviders.length; i++) {
            const prevIdx = PROVIDER_ORDER.indexOf(calledProviders[i - 1] as any);
            const currIdx = PROVIDER_ORDER.indexOf(calledProviders[i] as any);
            expect(currIdx).toBeGreaterThan(prevIdx);
          }

          // 2. First provider is always twelve_data (it's always attempted first)
          expect(calledProviders[0]).toBe('twelve_data');

          // 3. If a provider succeeds, no further providers are attempted
          if (!twelveFails) {
            // twelve_data succeeded → only twelve_data called
            expect(calledProviders).toEqual(['twelve_data']);
          } else if (!massiveFails) {
            // twelve_data failed, massive_api succeeded → two providers called
            expect(calledProviders).toEqual(['twelve_data', 'massive_api']);
          } else if (!yahooFails) {
            // both failed, yahoo succeeded → all three in order
            expect(calledProviders).toEqual(['twelve_data', 'massive_api', 'yahoo_finance']);
          } else {
            // All providers fail → all three attempted in order
            expect(calledProviders).toEqual(['twelve_data', 'massive_api', 'yahoo_finance']);
          }
        }
      ),
      { numRuns: 100 }
    );
  });
});


// ─── Property 3: Candle Upsert Idempotence ───────────────────────────────────

/**
 * Property 3: Candle Upsert Idempotence
 * Validates: Requirements 1.5, 3.4, 9.1
 *
 * For any set of candle records and any number of repeated insertions, the final
 * state of raw_candles SHALL be identical to the state after a single insertion —
 * existing records are never overwritten, and no duplicates are created.
 *
 * Since backfillCandles uses:
 *   supabase.from('raw_candles').upsert(record, {
 *     onConflict: 'asset,timeframe,timestamp_utc',
 *     ignoreDuplicates: true,
 *   })
 *
 * The idempotence is guaranteed by the upsert configuration. This property test
 * verifies that for ANY arbitrary input (asset, timestamps, repetitions), the
 * upsert is ALWAYS called with `ignoreDuplicates: true`.
 */
describe('Property 3: Candle Upsert Idempotence', () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, 'fetch');
    // All fetches succeed with Twelve Data response
    fetchSpy.mockImplementation(async () => createSuccessResponse('twelve_data'));
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  /**
   * Validates: Requirements 1.5, 3.4, 9.1
   *
   * For any arbitrary set of missing timestamps and any number of repeated
   * backfill invocations, EVERY upsert call uses `ignoreDuplicates: true` on
   * conflict `asset,timeframe,timestamp_utc`. This guarantees that:
   * - Existing records are never overwritten
   * - No duplicates are created
   * - Final state = single insertion state
   */
  it('upsert always uses ignoreDuplicates: true regardless of input or repetition count', async () => {
    /** Generates 1–8 distinct timestamps aligned to 4H grid */
    const arbTimestamps = fc
      .array(
        fc.integer({ min: 0, max: 500 }).map(offset => {
          const base = new Date('2024-01-01T00:00:00.000Z');
          base.setUTCHours(base.getUTCHours() + offset * 4);
          return base.toISOString();
        }),
        { minLength: 1, maxLength: 8 },
      )
      .map(timestamps => [...new Set(timestamps)])
      .filter(arr => arr.length > 0);

    /** Generates a repeat count (2–5 simulated re-runs) */
    const arbRepeatCount = fc.integer({ min: 2, max: 5 });

    await fc.assert(
      fc.asyncProperty(
        arbTimestamps,
        arbRepeatCount,
        async (missingTimestamps, repeatCount) => {
          // Track all upsert calls with their options
          const upsertCalls: Array<{ record: any; options: any }> = [];
          const mockSupabase = {
            from: () => ({
              upsert: (record: any, options: any) => {
                upsertCalls.push({ record, options });
                return Promise.resolve({ error: null });
              },
            }),
          } as any;

          const registry = createTestRegistry();
          const input: BackfillInput = {
            asset: TEST_ASSET,
            timeframe: '4h',
            missingTimestamps,
          };

          // Call backfillCandles multiple times (simulating repeated job runs)
          for (let i = 0; i < repeatCount; i++) {
            await backfillCandles(mockSupabase, registry, input);
          }

          // Total expected upsert calls = timestamps × repetitions
          const expectedCalls = missingTimestamps.length * repeatCount;
          expect(upsertCalls.length).toBe(expectedCalls);

          // EVERY upsert call must use ignoreDuplicates: true
          for (const call of upsertCalls) {
            expect(call.options).toEqual(
              expect.objectContaining({
                onConflict: 'asset,timeframe,timestamp_utc',
                ignoreDuplicates: true,
              }),
            );

            // Verify the record has the correct conflict key fields
            expect(call.record.asset).toBe(TEST_ASSET.symbol);
            expect(call.record.timeframe).toBe('4h');
            expect(typeof call.record.timestamp_utc).toBe('string');
          }
        },
      ),
      { numRuns: 100 },
    );
  });

  /**
   * Validates: Requirements 1.5, 3.4, 9.1
   *
   * For any arbitrary input, a single invocation of backfillCandles always uses
   * the idempotent upsert configuration — existing records would never be
   * overwritten for any generated input.
   */
  it('single invocation always uses idempotent upsert config for any input', async () => {
    /** Generates a ResearchAsset with arbitrary symbol */
    const arbAsset: fc.Arbitrary<ResearchAsset> = fc
      .stringMatching(/^[A-Z]{3,6}$/)
      .map(symbol => ({
        ...TEST_ASSET,
        id: symbol.toLowerCase(),
        symbol,
      }));

    /** Generates 1–10 distinct timestamps */
    const arbTimestamps = fc
      .array(
        fc.integer({ min: 0, max: 1000 }).map(offset => {
          const base = new Date('2023-01-01T00:00:00.000Z');
          base.setUTCHours(base.getUTCHours() + offset * 4);
          return base.toISOString();
        }),
        { minLength: 1, maxLength: 10 },
      )
      .map(timestamps => [...new Set(timestamps)])
      .filter(arr => arr.length > 0);

    await fc.assert(
      fc.asyncProperty(
        arbAsset,
        arbTimestamps,
        async (asset, missingTimestamps) => {
          const upsertCalls: Array<{ record: any; options: any }> = [];
          const mockSupabase = {
            from: () => ({
              upsert: (record: any, options: any) => {
                upsertCalls.push({ record, options });
                return Promise.resolve({ error: null });
              },
            }),
          } as any;

          const registry = createTestRegistry();
          const input: BackfillInput = {
            asset,
            timeframe: '4h',
            missingTimestamps,
          };

          await backfillCandles(mockSupabase, registry, input);

          // Every upsert must have the idempotent config
          expect(upsertCalls.length).toBe(missingTimestamps.length);

          for (const call of upsertCalls) {
            // Verify conflict key is correct
            expect(call.options.onConflict).toBe('asset,timeframe,timestamp_utc');

            // Verify ignoreDuplicates guarantees no overwrite
            expect(call.options.ignoreDuplicates).toBe(true);

            // Verify record uses the correct asset symbol
            expect(call.record.asset).toBe(asset.symbol);
            expect(call.record.timeframe).toBe('4h');
          }
        },
      ),
      { numRuns: 100 },
    );
  });
});
