/**
 * Sentiment Engine — pure computational module.
 *
 * Provides shared math utilities used by both the Sentiment Engine and
 * the Macro Context Engine, plus the core sentiment computation functions.
 */

import type {
  NewsArticle,
  SentimentEngineInput,
  SentimentEngineOutput,
  SentimentVector,
} from '../types/index.js';

/**
 * Rounds a number to 6 decimal places for bit-identical reproducibility.
 */
export function roundTo6(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}

/**
 * Maps a value from [-1, 1] to [0, 1] using (value + 1) / 2.
 */
export function mapToUnitInterval(value: number): number {
  return (value + 1) / 2;
}

/**
 * Computes exponential decay weight based on elapsed time.
 * Formula: 2^(-elapsed_hours / half_life_hours)
 *
 * An article published exactly half_life_hours ago receives 50% weight.
 */
export function computeDecayWeight(elapsed_hours: number, half_life_hours: number): number {
  return Math.pow(2, -elapsed_hours / half_life_hours);
}

/**
 * Computes the sentiment vector and scalar score from news articles.
 * Pure function: no I/O, no randomness, deterministic.
 */
export function computeSentiment(input: SentimentEngineInput): SentimentEngineOutput {
  const windowEndMs = new Date(input.window_end).getTime();
  const windowMs = input.window_hours * 3600000;

  // Filter articles within the time window
  const articles = input.articles.filter((article) => {
    const publishedMs = new Date(article.published_at).getTime();
    const age = windowEndMs - publishedMs;
    return age >= 0 && age <= windowMs;
  });

  // If no articles, return neutral vector
  if (articles.length === 0) {
    const neutralVector: SentimentVector = {
      aggregate_sentiment: 0.5,
      bullish_pressure: 0.5,
      bearish_pressure: 0.5,
      article_volume: 0.5,
      sentiment_dispersion: 0.5,
      momentum: 0.5,
    };
    return {
      vector: neutralVector,
      sentiment_score: 0.5,
      article_count: 0,
      confidence_factor: 0,
      engine_version: '1.0.0',
    };
  }

  // Log warning for sparse data
  if (articles.length < 3) {
    console.warn(JSON.stringify({
      engine_name: 'sentiment',
      severity: 'warn',
      detail: `Fewer than 3 articles available`,
      article_count: articles.length,
    }));
  }

  // Step 1: Compute per-article weighted scores
  const weightedScores: Array<{ score: number; weight: number }> = [];
  for (const article of articles) {
    const baseScore = article.sentiment_hint ?? 0.0;
    const publishedMs = new Date(article.published_at).getTime();
    const elapsedHours = (windowEndMs - publishedMs) / 3600000;
    const decayWeight = computeDecayWeight(elapsedHours, 8);
    const combinedWeight = article.relevance_score * decayWeight;
    weightedScores.push({ score: baseScore, weight: combinedWeight });
  }

  // Step 2: Weighted mean → aggregate sentiment
  const totalWeight = weightedScores.reduce((sum, w) => sum + w.weight, 0);
  const rawAggregate = totalWeight === 0
    ? 0.0
    : weightedScores.reduce((sum, w) => sum + w.score * w.weight, 0) / totalWeight;
  const aggregateSentiment = mapToUnitInterval(rawAggregate);

  // Step 3: Directional pressure
  const positiveCount = articles.filter(
    (a) => (a.sentiment_hint ?? 0.0) > 0.2
  ).length;
  const negativeCount = articles.filter(
    (a) => (a.sentiment_hint ?? 0.0) < -0.2
  ).length;
  const bullishPressure = positiveCount / articles.length;
  const bearishPressure = negativeCount / articles.length;

  // Step 4: Volume
  const articleVolume = Math.min(articles.length / 50, 1.0);

  // Step 5: Dispersion (normalised variance)
  const mappedScores = articles.map((a) => mapToUnitInterval(a.sentiment_hint ?? 0.0));
  const mean = mappedScores.reduce((sum, s) => sum + s, 0) / mappedScores.length;
  const variance = mappedScores.reduce((sum, s) => sum + (s - mean) ** 2, 0) / mappedScores.length;
  const sentimentDispersion = Math.min(variance / 0.25, 1.0);

  // Step 6: Momentum
  const prevSentiment = input.previous_aggregate_sentiment ?? 0.5;
  const diff = aggregateSentiment - prevSentiment;
  const momentum = mapToUnitInterval(diff);

  // Assemble computed vector
  let vector: SentimentVector = {
    aggregate_sentiment: aggregateSentiment,
    bullish_pressure: bullishPressure,
    bearish_pressure: bearishPressure,
    article_volume: articleVolume,
    sentiment_dispersion: sentimentDispersion,
    momentum,
  };

  // Step 7: Confidence blending for sparse data
  const confidenceFactor = Math.min(articles.length / 3, 1.0);
  if (confidenceFactor < 1.0) {
    vector = {
      aggregate_sentiment: vector.aggregate_sentiment * confidenceFactor + 0.5 * (1 - confidenceFactor),
      bullish_pressure: vector.bullish_pressure * confidenceFactor + 0.5 * (1 - confidenceFactor),
      bearish_pressure: vector.bearish_pressure * confidenceFactor + 0.5 * (1 - confidenceFactor),
      article_volume: vector.article_volume * confidenceFactor + 0.5 * (1 - confidenceFactor),
      sentiment_dispersion: vector.sentiment_dispersion * confidenceFactor + 0.5 * (1 - confidenceFactor),
      momentum: vector.momentum * confidenceFactor + 0.5 * (1 - confidenceFactor),
    };
  }

  // Step 8: Round all values to 6 decimal places
  const roundedVector: SentimentVector = {
    aggregate_sentiment: roundTo6(vector.aggregate_sentiment),
    bullish_pressure: roundTo6(vector.bullish_pressure),
    bearish_pressure: roundTo6(vector.bearish_pressure),
    article_volume: roundTo6(vector.article_volume),
    sentiment_dispersion: roundTo6(vector.sentiment_dispersion),
    momentum: roundTo6(vector.momentum),
  };

  return {
    vector: roundedVector,
    sentiment_score: roundTo6(roundedVector.aggregate_sentiment),
    article_count: articles.length,
    confidence_factor: roundTo6(confidenceFactor),
    engine_version: '1.0.0',
  };
}
