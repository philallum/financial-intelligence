/**
 * Tests for the sentiment data fetcher.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
  fetchSentimentData,
  computeSentimentBias,
  classifyEventImpact,
  parseAlphaVantageCalendarCSV,
} from '@/services/ingestion/sentiment-fetcher.js';
import type { SentimentFetcherOptions, NewsArticle } from '@/services/ingestion/sentiment-fetcher.js';
import { createDefaultRegistry, type RateLimitRegistry } from '@/services/ingestion/rate-limiter.js';

// =============================================================================
// Helpers
// =============================================================================

function createMockFetch(responses: Map<string, Response | Error>): typeof fetch {
  return (async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input.toString();

    for (const [pattern, response] of responses) {
      if (url.includes(pattern)) {
        if (response instanceof Error) throw response;
        return response;
      }
    }

    return new Response(JSON.stringify({ error: 'Not mocked' }), { status: 404 });
  }) as typeof fetch;
}

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function textResponse(text: string, status = 200): Response {
  return new Response(text, {
    status,
    headers: { 'Content-Type': 'text/plain' },
  });
}

function createFinnhubNewsResponse() {
  return [
    {
      category: 'forex',
      datetime: Math.floor(Date.now() / 1000) - 3600,
      headline: 'EUR/USD rallies on ECB signals',
      id: 1,
      image: '',
      related: 'EURUSD',
      source: 'Reuters',
      summary: 'The euro surged against the dollar following hawkish comments.',
      url: 'https://example.com/1',
    },
    {
      category: 'forex',
      datetime: Math.floor(Date.now() / 1000) - 7200,
      headline: 'Dollar weakens amid recession fears',
      id: 2,
      image: '',
      related: 'DXY',
      source: 'Bloomberg',
      summary: 'Fear of recession drives the dollar lower against major currencies.',
      url: 'https://example.com/2',
    },
  ];
}

function createNewsAPIResponse() {
  return {
    status: 'ok',
    totalResults: 2,
    articles: [
      {
        source: { id: 'reuters', name: 'Reuters' },
        author: 'John Doe',
        title: 'Federal Reserve signals rate hold',
        description: 'The Fed maintains a strong stance on interest rates.',
        url: 'https://example.com/3',
        publishedAt: new Date(Date.now() - 1800000).toISOString(),
        content: null,
      },
      {
        source: { id: 'cnbc', name: 'CNBC' },
        author: 'Jane Smith',
        title: 'Market shows bullish sentiment on growth data',
        description: 'Strong GDP growth drives optimism in currency markets.',
        url: 'https://example.com/4',
        publishedAt: new Date(Date.now() - 3600000).toISOString(),
        content: null,
      },
    ],
  };
}

function createAlphaVantageCalendarCSV() {
  const today = new Date().toISOString().split('T')[0];
  return `timestamp,name,impact,actual,estimate,previous,currency
${today},Nonfarm Payrolls,high,200K,180K,175K,USD
${today},PMI Manufacturing,medium,51.2,50.8,50.5,USD
${today},Consumer Confidence,medium,102.5,101.0,100.8,USD`;
}

// =============================================================================
// Tests
// =============================================================================

describe('fetchSentimentData', () => {
  let registry: RateLimitRegistry;
  let defaultOptions: SentimentFetcherOptions;

  beforeEach(() => {
    registry = createDefaultRegistry();
    defaultOptions = {
      finnhubApiKey: 'test-finnhub-key',
      newsApiKey: 'test-newsapi-key',
      alphaVantageApiKey: 'test-av-key',
      rateLimitRegistry: registry,
      timeoutMs: 5000,
    };
  });

  it('fetches all sentiment data successfully', async () => {
    const responses = new Map<string, Response>([
      ['finnhub.io', jsonResponse(createFinnhubNewsResponse())],
      ['newsapi.org', jsonResponse(createNewsAPIResponse())],
      ['ECONOMIC_CALENDAR', textResponse(createAlphaVantageCalendarCSV())],
    ]);

    const result = await fetchSentimentData({
      ...defaultOptions,
      fetchFn: createMockFetch(responses),
    });

    expect(result.data.news_articles.length).toBeGreaterThan(0);
    expect(result.data.news_count).toBe(4); // 2 from Finnhub + 2 from NewsAPI
    expect(result.data.economic_events.length).toBeGreaterThan(0);
    expect(result.data.high_impact_event_count).toBe(1); // Nonfarm Payrolls
    expect(result.data.overall_sentiment_bias).toBeDefined();
    expect(result.data.fetch_timestamp_utc).toBeDefined();
    expect(result.errors).toHaveLength(0);
    expect(result.fetch_time_ms).toBeGreaterThanOrEqual(0);
  });

  it('handles Finnhub failure gracefully', async () => {
    const responses = new Map<string, Response>([
      ['finnhub.io', jsonResponse({}, 500)],
      ['newsapi.org', jsonResponse(createNewsAPIResponse())],
      ['ECONOMIC_CALENDAR', textResponse(createAlphaVantageCalendarCSV())],
    ]);

    const result = await fetchSentimentData({
      ...defaultOptions,
      fetchFn: createMockFetch(responses),
    });

    // Should still have NewsAPI articles
    expect(result.data.news_articles.length).toBe(2);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]!.provider).toBe('finnhub');
  });

  it('handles NewsAPI failure gracefully', async () => {
    const responses = new Map<string, Response>([
      ['finnhub.io', jsonResponse(createFinnhubNewsResponse())],
      ['newsapi.org', jsonResponse({ status: 'error', message: 'API key invalid' })],
      ['ECONOMIC_CALENDAR', textResponse(createAlphaVantageCalendarCSV())],
    ]);

    const result = await fetchSentimentData({
      ...defaultOptions,
      fetchFn: createMockFetch(responses),
    });

    // Should still have Finnhub articles
    expect(result.data.news_articles.length).toBe(2);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]!.provider).toBe('news_api');
  });

  it('handles all sources failing gracefully', async () => {
    const responses = new Map<string, Response | Error>([
      ['finnhub.io', new Error('Connection refused')],
      ['newsapi.org', new Error('Timeout')],
      ['ECONOMIC_CALENDAR', new Error('DNS failed')],
    ]);

    const result = await fetchSentimentData({
      ...defaultOptions,
      fetchFn: createMockFetch(responses),
    });

    expect(result.data.news_articles).toHaveLength(0);
    expect(result.data.economic_events).toHaveLength(0);
    expect(result.data.news_count).toBe(0);
    expect(result.data.high_impact_event_count).toBe(0);
    expect(result.data.overall_sentiment_bias).toBe(0);
    expect(result.errors).toHaveLength(3);
  });

  it('respects rate limits', async () => {
    // Exhaust Finnhub per-minute limit
    for (let i = 0; i < 60; i++) {
      registry.recordRequest('finnhub');
    }

    const responses = new Map<string, Response>([
      ['newsapi.org', jsonResponse(createNewsAPIResponse())],
      ['ECONOMIC_CALENDAR', textResponse(createAlphaVantageCalendarCSV())],
    ]);

    const result = await fetchSentimentData({
      ...defaultOptions,
      fetchFn: createMockFetch(responses),
    });

    // Finnhub should be blocked, others should work
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]!.provider).toBe('finnhub');
    expect(result.errors[0]!.error).toContain('Rate limit');
    expect(result.data.news_articles.length).toBe(2); // NewsAPI only
  });

  it('records rate limit usage for successful requests', async () => {
    const responses = new Map<string, Response>([
      ['finnhub.io', jsonResponse(createFinnhubNewsResponse())],
      ['newsapi.org', jsonResponse(createNewsAPIResponse())],
      ['ECONOMIC_CALENDAR', textResponse(createAlphaVantageCalendarCSV())],
    ]);

    await fetchSentimentData({
      ...defaultOptions,
      fetchFn: createMockFetch(responses),
    });

    const finnhub = registry.get('finnhub')!;
    const newsApi = registry.get('news_api')!;
    const av = registry.get('alpha_vantage')!;

    // Each provider should have 1 request recorded
    expect(finnhub.getRemainingPerMinute()).toBe(59); // 60 - 1
    expect(newsApi.getRemainingDaily()).toBe(99); // 100 - 1
    expect(av.getRemainingDaily()).toBe(24); // 25 - 1
  });
});

describe('computeSentimentBias', () => {
  it('returns 0 for empty articles', () => {
    expect(computeSentimentBias([])).toBe(0);
  });

  it('returns positive bias for bullish headlines', () => {
    const articles: NewsArticle[] = [
      { source: 'finnhub', headline: 'Market rally continues', summary: 'Strong growth signals', url: '', published_at: '', category: '' },
      { source: 'newsapi', headline: 'Bullish sentiment drives gains', summary: 'Recovery accelerates', url: '', published_at: '', category: '' },
    ];
    const bias = computeSentimentBias(articles);
    expect(bias).toBeGreaterThan(0);
    expect(bias).toBeLessThanOrEqual(1);
  });

  it('returns negative bias for bearish headlines', () => {
    const articles: NewsArticle[] = [
      { source: 'finnhub', headline: 'Market crash fears mount', summary: 'Recession risk grows', url: '', published_at: '', category: '' },
      { source: 'newsapi', headline: 'Bearish plunge deepens', summary: 'Fear drives sell-off', url: '', published_at: '', category: '' },
    ];
    const bias = computeSentimentBias(articles);
    expect(bias).toBeLessThan(0);
    expect(bias).toBeGreaterThanOrEqual(-1);
  });

  it('returns 0 for neutral articles with no sentiment keywords', () => {
    const articles: NewsArticle[] = [
      { source: 'finnhub', headline: 'Market opens flat', summary: 'Trading volume average', url: '', published_at: '', category: '' },
    ];
    expect(computeSentimentBias(articles)).toBe(0);
  });
});

describe('classifyEventImpact', () => {
  it('classifies CPI as high impact', () => {
    expect(classifyEventImpact('Consumer Price Index (CPI)')).toBe('high');
  });

  it('classifies Nonfarm Payrolls as high impact', () => {
    expect(classifyEventImpact('Nonfarm Payrolls')).toBe('high');
  });

  it('classifies GDP as high impact', () => {
    expect(classifyEventImpact('GDP Growth Rate')).toBe('high');
  });

  it('classifies FOMC as high impact', () => {
    expect(classifyEventImpact('FOMC Statement')).toBe('high');
  });

  it('classifies PMI as medium impact', () => {
    expect(classifyEventImpact('PMI Manufacturing')).toBe('medium');
  });

  it('classifies Retail Sales as medium impact', () => {
    expect(classifyEventImpact('Retail Sales MoM')).toBe('medium');
  });

  it('classifies unknown events as low impact', () => {
    expect(classifyEventImpact('Minor Trade Data')).toBe('low');
  });
});

describe('parseAlphaVantageCalendarCSV', () => {
  it('parses valid CSV with events within 24h window', () => {
    const today = new Date().toISOString().split('T')[0];
    const csv = `timestamp,name,impact,actual,estimate,previous,currency
${today},Nonfarm Payrolls,high,200K,180K,175K,USD
${today},PMI,medium,51.2,50.8,50.5,USD`;

    const events = parseAlphaVantageCalendarCSV(csv);
    expect(events.length).toBe(2);
    expect(events[0]!.name).toBe('Nonfarm Payrolls');
    expect(events[0]!.impact).toBe('high');
    expect(events[0]!.actual).toBe('200K');
    expect(events[0]!.currency).toBe('USD');
  });

  it('returns empty array for header-only CSV', () => {
    const csv = 'timestamp,name,impact,actual,estimate,previous,currency';
    const events = parseAlphaVantageCalendarCSV(csv);
    expect(events).toHaveLength(0);
  });

  it('returns empty array for empty string', () => {
    const events = parseAlphaVantageCalendarCSV('');
    expect(events).toHaveLength(0);
  });

  it('filters out events older than 24 hours', () => {
    const oldDate = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString().split('T')[0];
    const csv = `timestamp,name,impact,actual,estimate,previous,currency
${oldDate},Old Event,high,100,95,90,USD`;

    const events = parseAlphaVantageCalendarCSV(csv);
    expect(events).toHaveLength(0);
  });

  it('skips malformed rows', () => {
    const today = new Date().toISOString().split('T')[0];
    const csv = `timestamp,name,impact,actual,estimate,previous,currency
${today},Valid Event,high,100,95,90,USD
bad
${today},Another Valid,medium,50,48,47,EUR`;

    const events = parseAlphaVantageCalendarCSV(csv);
    expect(events.length).toBe(2);
  });
});
