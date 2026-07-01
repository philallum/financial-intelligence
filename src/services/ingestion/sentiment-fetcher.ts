/**
 * Sentiment Data Fetcher for the Financial Intelligence Platform.
 *
 * Fetches news and economic event data that feeds into the L5 (sentiment_pressure)
 * state layer of the fingerprint. Sources:
 *   - Market news articles — Finnhub
 *   - General financial news — NewsAPI
 *   - Economic calendar (CPI, NFP, GDP, rates) — Alpha Vantage
 *
 * All data is fetched 60-180 seconds after candle close per platform execution principles.
 * Rate limits are tracked per provider per cycle.
 *
 * Requirements: 1.1, 1.5
 */

import type { RateLimitRegistry } from './rate-limiter.js';

// =============================================================================
// Types
// =============================================================================

/** A classified news article from any source */
export interface NewsArticle {
  source: 'finnhub' | 'newsapi';
  headline: string;
  summary: string;
  url: string;
  published_at: string;
  category: string;
  sentiment_hint?: 'positive' | 'negative' | 'neutral';
  relevance_score?: number;
}

/** An economic calendar event */
export interface EconomicEvent {
  name: string;
  date: string;
  impact: 'high' | 'medium' | 'low';
  actual?: string;
  estimate?: string;
  previous?: string;
  currency: string;
}

/** Structured sentiment data matching L5 (sentiment_pressure) state layer input */
export interface SentimentData {
  news_articles: NewsArticle[];
  economic_events: EconomicEvent[];
  news_count: number;
  high_impact_event_count: number;
  overall_sentiment_bias: number; // -1 (bearish) to +1 (bullish)
  fetch_timestamp_utc: string;
}

/** Result from the sentiment fetcher including metadata */
export interface SentimentFetchResult {
  data: SentimentData;
  fetch_time_ms: number;
  errors: SentimentFetchError[];
}

export interface SentimentFetchError {
  provider: string;
  endpoint: string;
  error: string;
  recoverable: boolean;
}

/** Options for configuring the sentiment fetcher */
export interface SentimentFetcherOptions {
  finnhubApiKey: string;
  newsApiKey: string;
  alphaVantageApiKey: string;
  rateLimitRegistry: RateLimitRegistry;
  /** HTTP fetch function, injectable for testing */
  fetchFn?: typeof fetch;
  /** Timeout per request in milliseconds */
  timeoutMs?: number;
}

// =============================================================================
// Finnhub Types
// =============================================================================

interface FinnhubNewsItem {
  category: string;
  datetime: number;
  headline: string;
  id: number;
  image: string;
  related: string;
  source: string;
  summary: string;
  url: string;
}

// =============================================================================
// NewsAPI Types
// =============================================================================

interface NewsAPIArticle {
  source: { id: string | null; name: string };
  author: string | null;
  title: string;
  description: string | null;
  url: string;
  publishedAt: string;
  content: string | null;
}

interface NewsAPIResponse {
  status: string;
  totalResults?: number;
  articles?: NewsAPIArticle[];
  message?: string;
}

// =============================================================================
// Alpha Vantage Economic Calendar Types (simplified)
// =============================================================================

interface AlphaVantageEconEvent {
  date: string;
  event: string;
  impact: string;
  actual?: string;
  estimate?: string;
  previous?: string;
  currency: string;
}

// =============================================================================
// Constants
// =============================================================================

const FINNHUB_BASE_URL = 'https://finnhub.io/api/v1';
const NEWS_API_BASE_URL = 'https://newsapi.org/v2';
const ALPHA_VANTAGE_BASE_URL = 'https://www.alphavantage.co/query';

const DEFAULT_TIMEOUT_MS = 10_000;

/** Keywords for filtering financial news relevant to forex */
const FOREX_KEYWORDS = ['forex', 'currency', 'dollar', 'euro', 'fed', 'ecb', 'interest rate', 'inflation', 'gdp', 'employment'];

// =============================================================================
// Implementation
// =============================================================================

/**
 * Fetch market news from Finnhub.
 */
async function fetchFinnhubNews(
  apiKey: string,
  registry: RateLimitRegistry,
  fetchFn: typeof fetch,
  timeoutMs: number,
): Promise<{ articles: NewsArticle[]; error?: SentimentFetchError }> {
  if (!registry.canRequest('finnhub')) {
    return {
      articles: [],
      error: {
        provider: 'finnhub',
        endpoint: 'market-news',
        error: 'Rate limit exceeded for Finnhub',
        recoverable: true,
      },
    };
  }

  try {
    const url = `${FINNHUB_BASE_URL}/news?category=forex&token=${apiKey}`;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    const response = await fetchFn(url, { signal: controller.signal });
    clearTimeout(timeout);

    registry.recordRequest('finnhub');

    if (!response.ok) {
      return {
        articles: [],
        error: {
          provider: 'finnhub',
          endpoint: 'market-news',
          error: `HTTP ${response.status}: ${response.statusText}`,
          recoverable: response.status >= 500,
        },
      };
    }

    const json = (await response.json()) as FinnhubNewsItem[];

    if (!Array.isArray(json)) {
      return {
        articles: [],
        error: {
          provider: 'finnhub',
          endpoint: 'market-news',
          error: 'Unexpected response format',
          recoverable: false,
        },
      };
    }

    // Take the most recent articles (last 4H window = ~10-20 articles max)
    const recentArticles = json.slice(0, 20).map((item): NewsArticle => ({
      source: 'finnhub',
      headline: item.headline,
      summary: item.summary,
      url: item.url,
      published_at: new Date(item.datetime * 1000).toISOString(),
      category: item.category,
    }));

    return { articles: recentArticles };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      articles: [],
      error: {
        provider: 'finnhub',
        endpoint: 'market-news',
        error: message,
        recoverable: true,
      },
    };
  }
}

/**
 * Fetch general financial news from NewsAPI.
 */
async function fetchNewsAPIArticles(
  apiKey: string,
  registry: RateLimitRegistry,
  fetchFn: typeof fetch,
  timeoutMs: number,
): Promise<{ articles: NewsArticle[]; error?: SentimentFetchError }> {
  if (!registry.canRequest('news_api')) {
    return {
      articles: [],
      error: {
        provider: 'news_api',
        endpoint: 'everything',
        error: 'Rate limit exceeded for NewsAPI',
        recoverable: true,
      },
    };
  }

  try {
    // Search for forex/macro relevant news from the last 4 hours
    const fromDate = new Date(Date.now() - 4 * 60 * 60 * 1000).toISOString();
    const query = 'forex OR "interest rate" OR "federal reserve" OR EUR/USD';
    const url = `${NEWS_API_BASE_URL}/everything?q=${encodeURIComponent(query)}&from=${fromDate}&sortBy=publishedAt&pageSize=10&apiKey=${apiKey}`;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    const response = await fetchFn(url, { signal: controller.signal });
    clearTimeout(timeout);

    registry.recordRequest('news_api');

    if (!response.ok) {
      return {
        articles: [],
        error: {
          provider: 'news_api',
          endpoint: 'everything',
          error: `HTTP ${response.status}: ${response.statusText}`,
          recoverable: response.status >= 500,
        },
      };
    }

    const json = (await response.json()) as NewsAPIResponse;

    if (json.status !== 'ok' || !json.articles) {
      return {
        articles: [],
        error: {
          provider: 'news_api',
          endpoint: 'everything',
          error: json.message ?? 'No articles returned',
          recoverable: false,
        },
      };
    }

    const articles: NewsArticle[] = json.articles.map((item): NewsArticle => ({
      source: 'newsapi',
      headline: item.title,
      summary: item.description ?? '',
      url: item.url,
      published_at: item.publishedAt,
      category: 'general_financial',
    }));

    return { articles };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      articles: [],
      error: {
        provider: 'news_api',
        endpoint: 'everything',
        error: message,
        recoverable: true,
      },
    };
  }
}

/**
 * Fetch economic calendar events from Alpha Vantage.
 * Looks for high-impact events: CPI, NFP, GDP, interest rate decisions.
 */
async function fetchEconomicCalendar(
  apiKey: string,
  registry: RateLimitRegistry,
  fetchFn: typeof fetch,
  timeoutMs: number,
): Promise<{ events: EconomicEvent[]; error?: SentimentFetchError }> {
  if (!registry.canRequest('alpha_vantage')) {
    return {
      events: [],
      error: {
        provider: 'alpha_vantage',
        endpoint: 'economic-calendar',
        error: 'Rate limit exceeded for Alpha Vantage',
        recoverable: true,
      },
    };
  }

  try {
    const url = `${ALPHA_VANTAGE_BASE_URL}?function=ECONOMIC_CALENDAR&apikey=${apiKey}`;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    const response = await fetchFn(url, { signal: controller.signal });
    clearTimeout(timeout);

    registry.recordRequest('alpha_vantage');

    if (!response.ok) {
      return {
        events: [],
        error: {
          provider: 'alpha_vantage',
          endpoint: 'economic-calendar',
          error: `HTTP ${response.status}: ${response.statusText}`,
          recoverable: response.status >= 500,
        },
      };
    }

    // Alpha Vantage economic calendar returns CSV — parse it
    const text = await response.text();
    const events = parseAlphaVantageCalendarCSV(text);

    return { events };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      events: [],
      error: {
        provider: 'alpha_vantage',
        endpoint: 'economic-calendar',
        error: message,
        recoverable: true,
      },
    };
  }
}

/**
 * Parse Alpha Vantage economic calendar CSV response into structured events.
 * Format: timestamp,name,impact,actual,estimate,previous,currency
 */
function parseAlphaVantageCalendarCSV(csv: string): EconomicEvent[] {
  const lines = csv.trim().split('\n');
  if (lines.length <= 1) return []; // header only or empty

  const events: EconomicEvent[] = [];

  // Skip header row
  for (let i = 1; i < lines.length; i++) {
    const parts = lines[i]!.split(',');
    if (parts.length < 4) continue;

    const impact = classifyEventImpact(parts[1]?.trim() ?? '');
    const event: EconomicEvent = {
      date: parts[0]?.trim() ?? '',
      name: parts[1]?.trim() ?? '',
      impact,
      actual: parts[3]?.trim() || undefined,
      estimate: parts[4]?.trim() || undefined,
      previous: parts[5]?.trim() || undefined,
      currency: parts[6]?.trim() ?? 'USD',
    };

    events.push(event);
  }

  // Filter to only recent/upcoming events (within 24h window)
  const now = Date.now();
  const twentyFourHoursAgo = now - 24 * 60 * 60 * 1000;
  const twentyFourHoursAhead = now + 24 * 60 * 60 * 1000;

  return events.filter((e) => {
    const eventTime = new Date(e.date).getTime();
    return eventTime >= twentyFourHoursAgo && eventTime <= twentyFourHoursAhead;
  });
}

/**
 * Classify event impact based on event name.
 * High-impact: CPI, NFP, GDP, interest rate decisions
 */
function classifyEventImpact(eventName: string): 'high' | 'medium' | 'low' {
  const highImpact = [
    'nonfarm', 'nfp', 'cpi', 'gdp', 'interest rate', 'fomc',
    'fed funds', 'ecb rate', 'employment change',
  ];
  const mediumImpact = [
    'pmi', 'retail sales', 'trade balance', 'unemployment',
    'consumer confidence', 'housing',
  ];

  const lower = eventName.toLowerCase();

  if (highImpact.some((term) => lower.includes(term))) return 'high';
  if (mediumImpact.some((term) => lower.includes(term))) return 'medium';
  return 'low';
}

/**
 * Compute a simple overall sentiment bias from news articles.
 * Uses keyword-based heuristic: returns value in [-1, +1].
 *
 * Positive signals: bullish, rally, growth, strong, gain, surge
 * Negative signals: bearish, crash, recession, weak, loss, plunge, fear
 */
function computeSentimentBias(articles: NewsArticle[]): number {
  if (articles.length === 0) return 0;

  const positiveTerms = ['bullish', 'rally', 'growth', 'strong', 'gain', 'surge', 'optimism', 'recovery'];
  const negativeTerms = ['bearish', 'crash', 'recession', 'weak', 'loss', 'plunge', 'fear', 'risk-off', 'decline'];

  let positiveCount = 0;
  let negativeCount = 0;

  for (const article of articles) {
    const text = `${article.headline} ${article.summary}`.toLowerCase();
    for (const term of positiveTerms) {
      if (text.includes(term)) positiveCount++;
    }
    for (const term of negativeTerms) {
      if (text.includes(term)) negativeCount++;
    }
  }

  const total = positiveCount + negativeCount;
  if (total === 0) return 0;

  // Normalize to [-1, +1]
  return (positiveCount - negativeCount) / total;
}

/**
 * Fetch all sentiment data for the current 4H cycle.
 *
 * Returns structured data matching the L5 (sentiment_pressure) state layer input
 * of the Fingerprint Engine. Includes news articles, economic events, and
 * computed sentiment metrics.
 *
 * Fetches are performed concurrently where rate limits allow.
 * Individual source failures result in empty data (graceful degradation).
 */
export async function fetchSentimentData(
  options: SentimentFetcherOptions,
): Promise<SentimentFetchResult> {
  const startTime = Date.now();
  const fetchFn = options.fetchFn ?? globalThis.fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const errors: SentimentFetchError[] = [];

  // Fetch all sources concurrently
  const [finnhubResult, newsApiResult, calendarResult] = await Promise.all([
    fetchFinnhubNews(
      options.finnhubApiKey,
      options.rateLimitRegistry,
      fetchFn,
      timeoutMs,
    ),
    fetchNewsAPIArticles(
      options.newsApiKey,
      options.rateLimitRegistry,
      fetchFn,
      timeoutMs,
    ),
    fetchEconomicCalendar(
      options.alphaVantageApiKey,
      options.rateLimitRegistry,
      fetchFn,
      timeoutMs,
    ),
  ]);

  // Collect errors
  if (finnhubResult.error) errors.push(finnhubResult.error);
  if (newsApiResult.error) errors.push(newsApiResult.error);
  if (calendarResult.error) errors.push(calendarResult.error);

  // Merge all news articles
  const allArticles = [...finnhubResult.articles, ...newsApiResult.articles];
  const highImpactEvents = calendarResult.events.filter((e) => e.impact === 'high');

  const data: SentimentData = {
    news_articles: allArticles,
    economic_events: calendarResult.events,
    news_count: allArticles.length,
    high_impact_event_count: highImpactEvents.length,
    overall_sentiment_bias: computeSentimentBias(allArticles),
    fetch_timestamp_utc: new Date().toISOString(),
  };

  return {
    data,
    fetch_time_ms: Date.now() - startTime,
    errors,
  };
}

// Export internal utilities for testing
export { computeSentimentBias, classifyEventImpact, parseAlphaVantageCalendarCSV };
