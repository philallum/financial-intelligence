/**
 * Sentiment Engine type definitions.
 *
 * Interfaces for the Sentiment Engine data contract — input articles,
 * engine configuration, 6-dimensional sentiment vector output, and
 * composite engine output.
 */

/** A news article record from the news_articles table. */
export interface NewsArticle {
  readonly id: string;
  readonly asset_id: string;
  readonly headline: string;
  readonly summary: string | null;
  readonly published_at: string;           // ISO-8601 UTC
  readonly sentiment_hint: number | null;  // [-1, 1] or null
  readonly relevance_score: number;        // [0, 1]
  readonly source: string;
}

/** Input to the Sentiment Engine. */
export interface SentimentEngineInput {
  readonly articles: readonly NewsArticle[];
  readonly window_end: string;             // ISO-8601 UTC (4H candle boundary)
  readonly window_hours: number;           // default 24, minimum 4
  readonly previous_aggregate_sentiment: number | null; // previous window's score for momentum
}

/** 6-dimensional sentiment vector for L5 fingerprint layer. */
export interface SentimentVector {
  /** Composite sentiment score mapped to [0, 1]. */
  readonly aggregate_sentiment: number;
  /** Proportion of positive articles (sentiment_hint > 0.2). */
  readonly bullish_pressure: number;
  /** Proportion of negative articles (sentiment_hint < -0.2). */
  readonly bearish_pressure: number;
  /** Normalised article count: min(count / 50, 1). */
  readonly article_volume: number;
  /** Normalised variance of article scores. */
  readonly sentiment_dispersion: number;
  /** Change rate from previous window, mapped [0, 1]. */
  readonly momentum: number;
}

/** Output from the Sentiment Engine. */
export interface SentimentEngineOutput {
  readonly vector: SentimentVector;
  readonly sentiment_score: number;        // [0, 1], 6 decimal places
  readonly article_count: number;
  readonly confidence_factor: number;      // min(article_count / 3, 1)
  readonly engine_version: string;
}
