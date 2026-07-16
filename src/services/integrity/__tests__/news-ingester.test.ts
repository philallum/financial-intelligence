import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { detectAssetId, computeRelevanceScore, ingestNews } from '../news-ingester.js';
import type { NewsIngestionConfig } from '../types.js';
import { RateLimitRegistry } from '../../ingestion/rate-limiter.js';

// Mock sentiment scorer to avoid Gemini calls in tests
vi.mock('../sentiment-scorer.js', () => ({
  scoreArticleSentiment: vi.fn().mockResolvedValue({ scored: 0, neutral_fallback: 0 }),
}));

describe('detectAssetId', () => {
  it('returns "eurusd" when both EUR and USD are mentioned', () => {
    expect(detectAssetId('EUR strengthens against USD')).toBe('eurusd');
  });

  it('returns "gbpusd" when both GBP and USD are mentioned', () => {
    expect(detectAssetId('GBP/USD pair falls sharply')).toBe('gbpusd');
  });

  it('returns "usdjpy" when both USD and JPY are mentioned', () => {
    expect(detectAssetId('USD JPY surges past 150')).toBe('usdjpy');
  });

  it('returns "forex" for a single AUD mention (single-currency fallback)', () => {
    expect(detectAssetId('Australian dollar AUD weakens')).toBe('forex');
  });

  it('returns "forex" when only USD is mentioned', () => {
    expect(detectAssetId('USD index reaches new highs')).toBe('forex');
  });

  it('returns "forex" when no currencies are mentioned', () => {
    expect(detectAssetId('Markets rally on positive data')).toBe('forex');
  });

  it('is case-insensitive for currency detection', () => {
    expect(detectAssetId('eur and usd trading sideways')).toBe('eurusd');
  });

  it('handles multiple pairs and returns first match', () => {
    // EUR, USD, GBP all mentioned — EUR/USD pair comes first in order
    expect(detectAssetId('EUR USD GBP all moving')).toBe('eurusd');
  });

  it('returns "gbpusd" when both GBP and USD are mentioned in different positions', () => {
    expect(detectAssetId('The GBP outlook with USD strength')).toBe('gbpusd');
  });

  it('returns "forex" when only "GBP" is mentioned (single-currency fallback)', () => {
    expect(detectAssetId('GBP weakens on Brexit news')).toBe('forex');
  });
});

describe('computeRelevanceScore', () => {
  it('returns 0.9 when direct pair name is mentioned (EUR/USD)', () => {
    expect(computeRelevanceScore('EUR/USD pair analysis')).toBe(0.9);
  });

  it('returns 0.8 when two or more currencies are mentioned without direct pair name', () => {
    expect(computeRelevanceScore('EUR weakens against USD today')).toBe(0.8);
  });

  it('returns 0.7 when strong keyword is present without currency', () => {
    expect(computeRelevanceScore('ECB rate decision due tomorrow')).toBe(0.7);
  });

  it('returns 0.5 when exactly one currency is mentioned', () => {
    expect(computeRelevanceScore('GBP outlook for next week')).toBe(0.5);
  });

  it('returns 0.3 when no currencies are mentioned', () => {
    expect(computeRelevanceScore('Forex market update')).toBe(0.3);
  });

  it('returns 0.9 when "GBP/USD" appears at start of text', () => {
    expect(computeRelevanceScore('GBP/USD trades higher today')).toBe(0.9);
  });

  it('returns 0.9 when "GBP/USD" appears in middle of text', () => {
    expect(computeRelevanceScore('The GBP/USD pair reached 1.27')).toBe(0.9);
  });

  it('returns 0.9 when "GBPUSD" appears in text', () => {
    expect(computeRelevanceScore('GBPUSD forecast bullish')).toBe(0.9);
  });

  it('returns 0.9 for "EUR/USD" (regression)', () => {
    expect(computeRelevanceScore('EUR/USD analysis weekly')).toBe(0.9);
  });

  it('returns 0.9 for "EURUSD" (regression)', () => {
    expect(computeRelevanceScore('EURUSD price action')).toBe(0.9);
  });
});

describe('ingestNews', () => {
  let registry: RateLimitRegistry;
  const config: NewsIngestionConfig = {
    maxArticlesPerSource: 50,
    lookbackHours: 24,
  };

  beforeEach(() => {
    registry = new RateLimitRegistry();
    registry.register('finnhub', { dailyLimit: Infinity, perMinuteLimit: 60 });
    registry.register('news_api', { dailyLimit: 100, perMinuteLimit: Infinity });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns empty result with errors when both APIs fail', async () => {
    // No API keys set → both should fail with env var errors
    const originalFinnhub = process.env.FINNHUB_API_KEY;
    const originalNewsApi = process.env.NEWS_API_KEY;
    delete process.env.FINNHUB_API_KEY;
    delete process.env.NEWS_API_KEY;

    const mockSupabase = {} as any;
    const result = await ingestNews(mockSupabase, registry, config);

    expect(result.totalIngested).toBe(0);
    expect(result.finnhubCount).toBe(0);
    expect(result.newsapiCount).toBe(0);
    expect(result.errors.length).toBe(2);
    expect(result.errors[0]).toContain('Finnhub');
    expect(result.errors[1]).toContain('NewsAPI');

    // Restore env
    if (originalFinnhub) process.env.FINNHUB_API_KEY = originalFinnhub;
    if (originalNewsApi) process.env.NEWS_API_KEY = originalNewsApi;
  });

  it('continues with NewsAPI when Finnhub fails (fail-forward)', async () => {
    const originalFinnhub = process.env.FINNHUB_API_KEY;
    delete process.env.FINNHUB_API_KEY;
    process.env.NEWS_API_KEY = 'test-key';

    // Mock fetch to return empty articles for NewsAPI
    const mockFetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ articles: [] }), { status: 200 })
    );

    const mockSupabase = {} as any;
    const result = await ingestNews(mockSupabase, registry, config);

    // Finnhub should have failed, NewsAPI should have been attempted
    expect(result.errors.length).toBe(1);
    expect(result.errors[0]).toContain('Finnhub');
    expect(result.newsapiCount).toBe(0); // empty articles

    // Restore
    if (originalFinnhub) process.env.FINNHUB_API_KEY = originalFinnhub;
    delete process.env.NEWS_API_KEY;
    mockFetch.mockRestore();
  });

  it('continues with Finnhub when NewsAPI fails (fail-forward)', async () => {
    process.env.FINNHUB_API_KEY = 'test-key';
    const originalNewsApi = process.env.NEWS_API_KEY;
    delete process.env.NEWS_API_KEY;

    // Mock fetch to return empty array for Finnhub
    const mockFetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify([]), { status: 200 })
    );

    const mockSupabase = {} as any;
    const result = await ingestNews(mockSupabase, registry, config);

    // NewsAPI should have failed, Finnhub should have been attempted
    expect(result.errors.length).toBe(1);
    expect(result.errors[0]).toContain('NewsAPI');
    expect(result.finnhubCount).toBe(0); // empty articles

    // Restore
    delete process.env.FINNHUB_API_KEY;
    if (originalNewsApi) process.env.NEWS_API_KEY = originalNewsApi;
    mockFetch.mockRestore();
  });

  it('stores fetched articles and returns correct counts', async () => {
    process.env.FINNHUB_API_KEY = 'test-key';
    process.env.NEWS_API_KEY = 'test-key';

    const finnhubArticles = [
      { headline: 'EUR USD rises', summary: 'Euro gains', url: 'https://finn.io/1', datetime: Math.floor(Date.now() / 1000), category: 'forex', source: 'Reuters' },
    ];
    const newsapiArticles = {
      articles: [
        { title: 'GBP weakens', description: 'Pound drops', url: 'https://news.io/1', publishedAt: new Date().toISOString(), source: { name: 'BBC' } },
      ],
    };

    let fetchCallCount = 0;
    const mockFetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const urlStr = typeof input === 'string' ? input : (input as Request).url;
      if (urlStr.includes('finnhub.io')) {
        return new Response(JSON.stringify(finnhubArticles), { status: 200 });
      }
      return new Response(JSON.stringify(newsapiArticles), { status: 200 });
    });

    // Mock supabase upsert
    const mockSelect = { data: [{ id: 'uuid-1' }], error: null };
    const mockUpsert = vi.fn().mockReturnValue({ select: vi.fn().mockReturnValue(mockSelect) });
    const mockSupabase = {
      from: vi.fn().mockReturnValue({ upsert: mockUpsert }),
    } as any;

    const result = await ingestNews(mockSupabase, registry, config);

    expect(result.finnhubCount).toBe(1);
    expect(result.newsapiCount).toBe(1);
    expect(result.totalIngested).toBe(2);
    expect(result.errors).toHaveLength(0);

    // Verify supabase.from was called with correct table
    expect(mockSupabase.from).toHaveBeenCalledWith('news_articles');

    // Restore
    delete process.env.FINNHUB_API_KEY;
    delete process.env.NEWS_API_KEY;
    mockFetch.mockRestore();
  });
});
