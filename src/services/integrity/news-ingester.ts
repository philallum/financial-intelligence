/**
 * News Ingester for the Daily Data Integrity module.
 *
 * Fetches forex-relevant news articles from Finnhub and NewsAPI,
 * maps sentiment labels to numeric scores, assigns asset relevance,
 * and stores articles in the news_articles table.
 *
 * Implements fail-forward: if one source fails, the other is still attempted.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import type { RateLimitRegistry } from "../ingestion/rate-limiter.js";
import type { NewsIngestionConfig, NewsArticle, NewsIngestionResult } from "./types.js";
import { SENTIMENT_MAP } from "./types.js";

// ─── Currency Detection ──────────────────────────────────────────────────────

/** Supported currency codes for asset_id detection. */
const CURRENCY_CODES = ["USD", "EUR", "GBP", "JPY", "AUD", "NZD", "CAD", "CHF"] as const;

type CurrencyCode = (typeof CURRENCY_CODES)[number];

/** Known currency pairs mapped to their asset_id. Order matters: first match wins. */
const CURRENCY_PAIRS: Array<{ currencies: [CurrencyCode, CurrencyCode]; assetId: string }> = [
  { currencies: ["EUR", "USD"], assetId: "eurusd" },
  { currencies: ["GBP", "USD"], assetId: "gbpusd" },
  { currencies: ["USD", "JPY"], assetId: "usdjpy" },
  { currencies: ["AUD", "USD"], assetId: "audusd" },
  { currencies: ["NZD", "USD"], assetId: "nzdusd" },
  { currencies: ["USD", "CAD"], assetId: "usdcad" },
  { currencies: ["USD", "CHF"], assetId: "usdchf" },
  { currencies: ["EUR", "GBP"], assetId: "eurgbp" },
  { currencies: ["EUR", "JPY"], assetId: "eurjpy" },
  { currencies: ["GBP", "JPY"], assetId: "gbpjpy" },
];

/**
 * Detect currency mentions in text and return matching asset_id.
 * Returns "forex" as a generic fallback when no specific pair is identified.
 */
export function detectAssetId(text: string): string {
  const upperText = text.toUpperCase();
  const mentioned: CurrencyCode[] = CURRENCY_CODES.filter((code) => upperText.includes(code));

  if (mentioned.length >= 2) {
    for (const pair of CURRENCY_PAIRS) {
      if (mentioned.includes(pair.currencies[0]) && mentioned.includes(pair.currencies[1])) {
        return pair.assetId;
      }
    }
  }

  // Single currency mentioned — default to that currency paired with USD
  if (mentioned.length === 1) {
    const currency = mentioned[0];
    if (currency === "USD") return "forex";
    const pairMatch = CURRENCY_PAIRS.find(
      (p) => p.currencies.includes(currency) && p.currencies.includes("USD")
    );
    return pairMatch?.assetId ?? "forex";
  }

  return "forex";
}

/**
 * Compute relevance score based on number of currency mentions.
 * - 0 mentions → 0.3 (generic forex article)
 * - 1 mention → 0.5
 * - 2+ mentions (pair match) → 0.8
 */
export function computeRelevanceScore(text: string): number {
  const upperText = text.toUpperCase();
  const mentioned = CURRENCY_CODES.filter((code) => upperText.includes(code));

  if (mentioned.length >= 2) return 0.8;
  if (mentioned.length === 1) return 0.5;
  return 0.3;
}

// ─── Finnhub Fetcher ─────────────────────────────────────────────────────────

interface FinnhubArticle {
  headline: string;
  summary: string;
  url: string;
  datetime: number; // Unix timestamp
  category: string;
  source: string;
}

/**
 * Fetch news articles from Finnhub's forex news endpoint.
 */
async function fetchFinnhub(
  rateLimits: RateLimitRegistry,
  config: NewsIngestionConfig
): Promise<NewsArticle[]> {
  const apiKey = process.env.FINNHUB_API_KEY;
  if (!apiKey) {
    throw new Error("FINNHUB_API_KEY environment variable not set");
  }

  if (!rateLimits.canRequest("finnhub")) {
    throw new Error("Finnhub rate limit exceeded");
  }

  const now = new Date();
  const fromDate = new Date(now.getTime() - config.lookbackHours * 60 * 60 * 1000);
  const fromStr = fromDate.toISOString().split("T")[0];
  const toStr = now.toISOString().split("T")[0];

  const url = `https://finnhub.io/api/v1/news?category=forex&token=${apiKey}&from=${fromStr}&to=${toStr}`;

  rateLimits.recordRequest("finnhub");
  const response = await fetch(url);

  if (!response.ok) {
    throw new Error(`Finnhub API returned ${response.status}: ${response.statusText}`);
  }

  const rawArticles: FinnhubArticle[] = await response.json() as FinnhubArticle[];

  // Cap at maxArticlesPerSource
  const capped = rawArticles.slice(0, config.maxArticlesPerSource);

  return capped.map((article) => {
    const combinedText = `${article.headline} ${article.summary}`;
    return {
      source: "finnhub",
      headline: article.headline,
      summary: article.summary || "",
      url: article.url,
      published_at: new Date(article.datetime * 1000).toISOString(),
      category: article.category || "forex",
      sentiment_hint: "neutral" as const,
      relevance_score: computeRelevanceScore(combinedText),
    };
  });
}

// ─── NewsAPI Fetcher ─────────────────────────────────────────────────────────

interface NewsAPIResponse {
  articles: Array<{
    title: string;
    description: string | null;
    url: string;
    publishedAt: string;
    source: { name: string };
  }>;
}

/**
 * Fetch news articles from NewsAPI's everything endpoint.
 */
async function fetchNewsAPI(
  rateLimits: RateLimitRegistry,
  config: NewsIngestionConfig
): Promise<NewsArticle[]> {
  const apiKey = process.env.NEWS_API_KEY;
  if (!apiKey) {
    throw new Error("NEWS_API_KEY environment variable not set");
  }

  if (!rateLimits.canRequest("news_api")) {
    throw new Error("NewsAPI rate limit exceeded");
  }

  const now = new Date();
  const fromDate = new Date(now.getTime() - config.lookbackHours * 60 * 60 * 1000);
  const fromStr = fromDate.toISOString().split("T")[0];
  const toStr = now.toISOString().split("T")[0];

  const url = `https://newsapi.org/v2/everything?q=forex+currency&from=${fromStr}&to=${toStr}&sortBy=publishedAt&pageSize=${config.maxArticlesPerSource}&apiKey=${apiKey}`;

  rateLimits.recordRequest("news_api");
  const response = await fetch(url);

  if (!response.ok) {
    throw new Error(`NewsAPI returned ${response.status}: ${response.statusText}`);
  }

  const data: NewsAPIResponse = await response.json() as NewsAPIResponse;
  const capped = (data.articles || []).slice(0, config.maxArticlesPerSource);

  return capped.map((article) => {
    const combinedText = `${article.title} ${article.description || ""}`;
    return {
      source: "newsapi",
      headline: article.title,
      summary: article.description || "",
      url: article.url,
      published_at: article.publishedAt,
      category: "forex",
      sentiment_hint: "neutral" as const,
      relevance_score: computeRelevanceScore(combinedText),
    };
  });
}

// ─── Storage ─────────────────────────────────────────────────────────────────

/**
 * Store articles in the news_articles table.
 * Uses upsert with ignoreDuplicates on (source, url) constraint.
 * Returns count of actually inserted rows and duplicates skipped.
 */
async function storeArticles(
  supabase: SupabaseClient,
  articles: NewsArticle[]
): Promise<{ inserted: number; duplicatesSkipped: number }> {
  if (articles.length === 0) {
    return { inserted: 0, duplicatesSkipped: 0 };
  }

  const runDate = new Date().toISOString().split("T")[0];

  const rows = articles.map((article) => ({
    asset_id: detectAssetId(`${article.headline} ${article.summary}`),
    source: article.source,
    headline: article.headline,
    summary: article.summary || null,
    url: article.url,
    published_at: article.published_at,
    category: article.category,
    sentiment_hint: SENTIMENT_MAP[article.sentiment_hint],
    relevance_score: article.relevance_score,
    run_date: runDate,
  }));

  const { data, error } = await supabase
    .from("news_articles")
    .upsert(rows, { onConflict: "source,url", ignoreDuplicates: true })
    .select("id");

  if (error) {
    throw new Error(`Database upsert failed: ${error.message}`);
  }

  const inserted = data?.length ?? 0;
  const duplicatesSkipped = articles.length - inserted;

  return { inserted, duplicatesSkipped };
}

// ─── Structured Logging ──────────────────────────────────────────────────────

function logError(stage: string, message: string, context?: Record<string, unknown>): void {
  console.log(
    JSON.stringify({
      severity: "ERROR",
      component: "integrity",
      stage: "news_ingestion",
      substage: stage,
      message,
      ...context,
      timestamp: new Date().toISOString(),
    })
  );
}

// ─── Main Entry Point ────────────────────────────────────────────────────────

/**
 * Ingest news articles from Finnhub and NewsAPI.
 *
 * Implements fail-forward: if one source fails, the other is still attempted.
 * If both fail, logs the errors and returns a result with zero articles.
 *
 * @param supabase - Supabase client for database operations
 * @param rateLimits - Rate limit registry for API call tracking
 * @param config - News ingestion configuration
 * @returns Result summary of the ingestion run
 */
export async function ingestNews(
  supabase: SupabaseClient,
  rateLimits: RateLimitRegistry,
  config: NewsIngestionConfig
): Promise<NewsIngestionResult> {
  const result: NewsIngestionResult = {
    finnhubCount: 0,
    newsapiCount: 0,
    totalIngested: 0,
    duplicatesSkipped: 0,
    errors: [],
  };

  let finnhubArticles: NewsArticle[] = [];
  let newsapiArticles: NewsArticle[] = [];

  // ── Fetch from Finnhub (fail-forward) ───────────────────────────────────
  try {
    finnhubArticles = await fetchFinnhub(rateLimits, config);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logError("finnhub_fetch", message);
    result.errors.push(`Finnhub fetch failed: ${message}`);
  }

  // ── Fetch from NewsAPI (fail-forward) ───────────────────────────────────
  try {
    newsapiArticles = await fetchNewsAPI(rateLimits, config);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logError("newsapi_fetch", message);
    result.errors.push(`NewsAPI fetch failed: ${message}`);
  }

  // ── Store Finnhub articles ──────────────────────────────────────────────
  if (finnhubArticles.length > 0) {
    try {
      const { inserted, duplicatesSkipped } = await storeArticles(supabase, finnhubArticles);
      result.finnhubCount = inserted;
      result.duplicatesSkipped += duplicatesSkipped;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logError("finnhub_store", message);
      result.errors.push(`Finnhub store failed: ${message}`);
    }
  }

  // ── Store NewsAPI articles ──────────────────────────────────────────────
  if (newsapiArticles.length > 0) {
    try {
      const { inserted, duplicatesSkipped } = await storeArticles(supabase, newsapiArticles);
      result.newsapiCount = inserted;
      result.duplicatesSkipped += duplicatesSkipped;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logError("newsapi_store", message);
      result.errors.push(`NewsAPI store failed: ${message}`);
    }
  }

  result.totalIngested = result.finnhubCount + result.newsapiCount;

  return result;
}
