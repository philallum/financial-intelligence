/**
 * Sentiment Aggregation Module — Testable pure functions for sentiment computation.
 *
 * Extracts the sentiment aggregation logic from the dashboard's renderSentimentCard
 * so it can be validated via property-based tests without requiring a DOM.
 */

// =============================================================================
// Types
// =============================================================================

export interface NewsArticle {
  headline?: string;
  sentiment_hint: number | null;
  relevance_score?: number;
  published_at?: string;
}

// =============================================================================
// Sentiment Aggregation
// =============================================================================

/**
 * Computes aggregate sentiment as arithmetic mean of all non-zero sentiment_hint values.
 * Returns 0 if no non-zero values exist.
 */
export function computeAggregateSentiment(articles: NewsArticle[]): number {
  const scoredArticles = (articles || []).filter(
    (a) => a.sentiment_hint !== null && a.sentiment_hint !== 0,
  );
  if (scoredArticles.length === 0) return 0;
  return (
    scoredArticles.reduce((sum, a) => sum + (a.sentiment_hint || 0), 0) /
    scoredArticles.length
  );
}
