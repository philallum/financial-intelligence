import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fc from 'fast-check';
import { detectAssetId, computeRelevanceScore, ingestNews } from '../news-ingester.js';
import { RateLimitRegistry } from '../../ingestion/rate-limiter.js';
import type { NewsIngestionConfig } from '../types.js';

// Mock sentiment scorer to avoid Gemini calls in tests
vi.mock('../sentiment-scorer.js', () => ({
  scoreArticleSentiment: vi.fn().mockResolvedValue({ scored: 0, neutral_fallback: 0 }),
}));

/**
 * Property 4: News Article Deduplication
 * Validates: Requirements 4.3, 9.2
 *
 * For any news article with a given (source, url) pair, inserting it multiple
 * times SHALL result in exactly one row in news_articles — subsequent inserts
 * are silently skipped without error.
 */

// ─── Generators ──────────────────────────────────────────────────────────────

/** Generates a random non-empty headline */
const arbHeadline = fc.string({ minLength: 1, maxLength: 200 });

/** Generates a random summary */
const arbSummary = fc.string({ maxLength: 500 });

/** Generates arbitrary text for testing helper functions */
const arbText = fc.string({ minLength: 0, maxLength: 500 });

/** Generates text that may contain currency codes */
const arbTextWithCurrencies = fc.oneof(
  arbText,
  fc.constantFrom(
    'EUR/USD trading at 1.08',
    'GBP weakening against USD',
    'JPY hits record low',
    'AUD surges on jobs data',
    'Markets rally on data',
    'Forex analysis for NZD and CAD',
    'CHF and EUR both rising',
    'Central bank USD policy',
  ),
  // Mix random text with currency codes
  fc.tuple(arbText, fc.constantFrom('EUR', 'USD', 'GBP', 'JPY', 'AUD', 'NZD', 'CAD', 'CHF', ''))
    .map(([text, code]) => `${text} ${code} ${text}`),
);

/** Generates a Finnhub-style article */
const arbFinnhubArticle = fc.record({
  headline: arbHeadline,
  summary: arbSummary,
  url: fc.webUrl(),
  datetime: fc.integer({ min: 1600000000, max: 1900000000 }),
  category: fc.constantFrom('forex', 'economy', 'general'),
  source: fc.string({ minLength: 1, maxLength: 50 }),
});

/** Number of times to simulate duplicate insertion (2-5) */
const arbRepeatCount = fc.integer({ min: 2, max: 5 });

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('Property 4: News Article Deduplication', () => {
  let registry: RateLimitRegistry;
  const config: NewsIngestionConfig = {
    maxArticlesPerSource: 50,
    lookbackHours: 24,
  };

  beforeEach(() => {
    registry = new RateLimitRegistry();
    registry.register('finnhub', { dailyLimit: Infinity, perMinuteLimit: 60 });
    registry.register('news_api', { dailyLimit: 100, perMinuteLimit: Infinity });
    process.env.FINNHUB_API_KEY = 'test-finnhub-key';
    process.env.NEWS_API_KEY = 'test-newsapi-key';
  });

  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env.FINNHUB_API_KEY;
    delete process.env.NEWS_API_KEY;
  });

  /**
   * Validates: Requirements 4.3, 9.2
   *
   * For any set of Finnhub articles, the upsert call always specifies
   * onConflict: "source,url" and ignoreDuplicates: true, ensuring that
   * duplicate (source, url) pairs are silently skipped.
   */
  it('upsert is always called with onConflict "source,url" and ignoreDuplicates true for any articles', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(arbFinnhubArticle, { minLength: 1, maxLength: 10 }),
        async (articles) => {
          // Track upsert calls
          const upsertCalls: Array<{ rows: unknown; options: unknown }> = [];

          const mockFetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
            const urlStr = typeof input === 'string' ? input : (input as Request).url;
            if (urlStr.includes('finnhub.io')) {
              return new Response(JSON.stringify(articles), { status: 200 });
            }
            // NewsAPI returns empty
            return new Response(JSON.stringify({ articles: [] }), { status: 200 });
          });

          const mockSelect = vi.fn().mockReturnValue({
            data: articles.map((_, i) => ({ id: `id-${i}` })),
            error: null,
          });
          const mockUpsert = vi.fn().mockImplementation((rows, options) => {
            upsertCalls.push({ rows, options });
            return { select: mockSelect };
          });
          const mockSupabase = {
            from: vi.fn().mockReturnValue({ upsert: mockUpsert }),
          } as any;

          // Reset rate limiter
          registry.resetAll();
          await ingestNews(mockSupabase, registry, config);

          // Verify that every upsert call uses the deduplication constraint
          for (const call of upsertCalls) {
            const options = call.options as { onConflict: string; ignoreDuplicates: boolean };
            expect(options.onConflict).toBe('source,url');
            expect(options.ignoreDuplicates).toBe(true);
          }

          mockFetch.mockRestore();
        },
      ),
      { numRuns: 100 },
    );
  });

  /**
   * Validates: Requirements 4.3, 9.2
   *
   * For any article with (source, url), calling ingestNews multiple times
   * with the same article data results in the simulated database tracking only
   * one effective row per unique (source, url) — duplicates are skipped silently
   * without error.
   */
  it('inserting same articles multiple times results in dedup: duplicates skipped without error', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(arbFinnhubArticle, { minLength: 1, maxLength: 5 }),
        arbRepeatCount,
        async (articles, repeatCount) => {
          // Simulate a database that tracks unique (source, url) pairs
          const storedRows = new Map<string, unknown>();

          const mockFetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
            const urlStr = typeof input === 'string' ? input : (input as Request).url;
            if (urlStr.includes('finnhub.io')) {
              return new Response(JSON.stringify(articles), { status: 200 });
            }
            return new Response(JSON.stringify({ articles: [] }), { status: 200 });
          });

          const mockUpsert = vi.fn().mockImplementation((rows: Array<{ source: string; url: string }>, _options) => {
            // Simulate dedup: only "insert" rows not already stored
            const newRows: unknown[] = [];
            for (const row of rows) {
              const key = `${row.source}:${row.url}`;
              if (!storedRows.has(key)) {
                storedRows.set(key, row);
                newRows.push(row);
              }
            }
            return {
              select: () => ({ data: newRows.map((_, i) => ({ id: `id-${i}` })), error: null }),
            };
          });

          const mockSupabase = {
            from: vi.fn().mockReturnValue({ upsert: mockUpsert }),
          } as any;

          // Call ingestNews multiple times (simulating repeated ingestion)
          const allErrors: string[] = [];
          for (let i = 0; i < repeatCount; i++) {
            registry.resetAll();
            const result = await ingestNews(mockSupabase, registry, config);
            allErrors.push(...result.errors);
          }

          // After multiple insertions, the stored set should have exactly
          // as many unique (source, url) entries as distinct articles
          const uniqueUrls = new Set(articles.map((a) => `finnhub:${a.url}`));
          expect(storedRows.size).toBe(uniqueUrls.size);

          // No errors should have occurred from deduplication
          const dedupErrors = allErrors.filter(
            (e) => e.toLowerCase().includes('duplicate') || e.toLowerCase().includes('conflict'),
          );
          expect(dedupErrors).toHaveLength(0);

          mockFetch.mockRestore();
        },
      ),
      { numRuns: 100 },
    );
  });

  /**
   * Validates: Requirements 4.3, 9.2
   *
   * Verifies that detectAssetId always returns a consistent, deterministic
   * result for any given input text — calling it multiple times with the
   * same text always produces the same asset_id.
   */
  it('detectAssetId is deterministic: same input always produces same output', () => {
    fc.assert(
      fc.property(arbTextWithCurrencies, (text) => {
        const result1 = detectAssetId(text);
        const result2 = detectAssetId(text);
        const result3 = detectAssetId(text);

        expect(result1).toBe(result2);
        expect(result2).toBe(result3);
      }),
      { numRuns: 100 },
    );
  });

  /**
   * Validates: Requirements 4.3, 9.2
   *
   * Verifies that detectAssetId always returns a valid asset_id string
   * (one of the known currency pairs or "forex") for any arbitrary text input.
   */
  it('detectAssetId always returns a valid asset_id for any text', () => {
    const validAssetIds = [
      'eurusd', 'gbpusd', 'usdjpy', 'audusd', 'nzdusd',
      'usdcad', 'usdchf', 'eurgbp', 'eurjpy', 'gbpjpy', 'forex',
    ];

    fc.assert(
      fc.property(arbText, (text) => {
        const result = detectAssetId(text);
        expect(validAssetIds).toContain(result);
      }),
      { numRuns: 100 },
    );
  });

  /**
   * Validates: Requirements 4.3, 9.2
   *
   * Verifies that computeRelevanceScore always returns a value in {0.3, 0.5, 0.8}
   * and is deterministic for any input.
   */
  it('computeRelevanceScore always returns a value in [0.3, 0.9] and is deterministic', () => {
    fc.assert(
      fc.property(arbTextWithCurrencies, (text) => {
        const score = computeRelevanceScore(text);
        expect(score).toBeGreaterThanOrEqual(0.3);
        expect(score).toBeLessThanOrEqual(0.9);
        expect([0.3, 0.5, 0.7, 0.8, 0.9]).toContain(score);

        // Deterministic
        expect(computeRelevanceScore(text)).toBe(score);
      }),
      { numRuns: 100 },
    );
  });
});

// ─── Property 5 ──────────────────────────────────────────────────────────────

/**
 * Property 5: News Article Cap
 * Validates: Requirements 4.6
 *
 * For any news source (Finnhub or NewsAPI) in a single daily run, the number
 * of articles stored SHALL be at most 50 — even if the provider returns more
 * than 50 results.
 */

describe('Property 5: News Article Cap', () => {
  let registry: RateLimitRegistry;
  const config: NewsIngestionConfig = {
    maxArticlesPerSource: 50,
    lookbackHours: 24,
  };

  beforeEach(() => {
    registry = new RateLimitRegistry();
    registry.register('finnhub', { dailyLimit: Infinity, perMinuteLimit: 60 });
    registry.register('news_api', { dailyLimit: 100, perMinuteLimit: Infinity });

    process.env.FINNHUB_API_KEY = 'test-finnhub-key';
    process.env.NEWS_API_KEY = 'test-newsapi-key';
  });

  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env.FINNHUB_API_KEY;
    delete process.env.NEWS_API_KEY;
  });

  /**
   * Validates: Requirements 4.6
   *
   * For any number of articles (0–200) returned by Finnhub and NewsAPI,
   * the Supabase upsert is called with at most 50 articles per source.
   */
  it('articles stored per source per run ≤ 50, regardless of provider response size', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 0, max: 200 }),
        fc.integer({ min: 0, max: 200 }),
        async (finnhubCount, newsapiCount) => {
          // Generate arbitrary Finnhub articles
          const finnhubArticles = Array.from({ length: finnhubCount }, (_, i) => ({
            headline: `Finnhub headline ${i}`,
            summary: `Summary ${i}`,
            url: `https://finnhub.io/article/${i}`,
            datetime: Math.floor(Date.now() / 1000) - i * 60,
            category: 'forex',
            source: 'Reuters',
          }));

          // Generate arbitrary NewsAPI articles
          const newsapiArticles = Array.from({ length: newsapiCount }, (_, i) => ({
            title: `NewsAPI headline ${i}`,
            description: `Description ${i}`,
            url: `https://newsapi.org/article/${i}`,
            publishedAt: new Date(Date.now() - i * 60000).toISOString(),
            source: { name: 'BBC' },
          }));

          // Mock fetch to return the generated articles
          const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
            const urlStr = typeof input === 'string' ? input : (input as Request).url;
            if (urlStr.includes('finnhub.io')) {
              return new Response(JSON.stringify(finnhubArticles), { status: 200 });
            }
            return new Response(JSON.stringify({ articles: newsapiArticles }), { status: 200 });
          });

          // Track upsert calls to verify article count
          const upsertedRows: any[][] = [];
          const mockUpsert = vi.fn().mockImplementation((rows: any[]) => {
            upsertedRows.push(rows);
            return {
              select: vi.fn().mockReturnValue({
                data: rows.map((_, i) => ({ id: `id-${i}` })),
                error: null,
              }),
            };
          });
          const mockSupabase = {
            from: vi.fn().mockReturnValue({ upsert: mockUpsert }),
          } as any;

          registry.resetAll();
          await ingestNews(mockSupabase, registry, config);

          // Verify: each upsert call has at most 50 articles
          for (const rows of upsertedRows) {
            expect(rows.length).toBeLessThanOrEqual(50);
          }

          // Verify per-source: count all rows by source field
          const finnhubStored = upsertedRows
            .flat()
            .filter((row) => row.source === 'finnhub').length;
          const newsapiStored = upsertedRows
            .flat()
            .filter((row) => row.source === 'newsapi').length;

          expect(finnhubStored).toBeLessThanOrEqual(50);
          expect(newsapiStored).toBeLessThanOrEqual(50);

          // Also verify the expected counts based on input
          expect(finnhubStored).toBe(Math.min(finnhubCount, 50));
          expect(newsapiStored).toBe(Math.min(newsapiCount, 50));

          fetchSpy.mockRestore();
        },
      ),
      { numRuns: 100 },
    );
  });
});
