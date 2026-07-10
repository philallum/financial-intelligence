import { describe, it, expect } from 'vitest';
import { computeSentiment, computeDecayWeight, roundTo6, mapToUnitInterval } from '../sentiment-engine.js';
import type { NewsArticle, SentimentEngineInput } from '../../types/index.js';

function makeArticle(overrides: Partial<NewsArticle> = {}): NewsArticle {
  return {
    id: 'test-1',
    asset_id: 'EURUSD',
    headline: 'Test headline',
    summary: null,
    published_at: '2024-01-01T00:00:00Z',
    sentiment_hint: 0.5,
    relevance_score: 1.0,
    source: 'test-source',
    ...overrides,
  };
}

describe('Sentiment Engine', () => {
  describe('computeSentiment', () => {
    it('returns neutral vector when articles array is empty (Req 4.1, 4.2)', () => {
      const input: SentimentEngineInput = {
        articles: [],
        window_end: '2024-01-01T00:00:00Z',
        window_hours: 24,
        previous_aggregate_sentiment: null,
      };

      const result = computeSentiment(input);

      expect(result.vector.aggregate_sentiment).toBe(0.5);
      expect(result.vector.bullish_pressure).toBe(0.5);
      expect(result.vector.bearish_pressure).toBe(0.5);
      expect(result.vector.article_volume).toBe(0.5);
      expect(result.vector.sentiment_dispersion).toBe(0.5);
      expect(result.vector.momentum).toBe(0.5);
      expect(result.sentiment_score).toBe(0.5);
      expect(result.article_count).toBe(0);
      expect(result.confidence_factor).toBe(0);
    });

    it('treats null sentiment_hint as 0.0 (Req 2.2)', () => {
      const input: SentimentEngineInput = {
        articles: [
          makeArticle({ id: 'a1', sentiment_hint: null, published_at: '2024-01-01T00:00:00Z' }),
          makeArticle({ id: 'a2', sentiment_hint: null, published_at: '2024-01-01T00:00:00Z' }),
          makeArticle({ id: 'a3', sentiment_hint: null, published_at: '2024-01-01T00:00:00Z' }),
        ],
        window_end: '2024-01-01T00:00:00Z',
        window_hours: 24,
        previous_aggregate_sentiment: 0.5,
      };

      const result = computeSentiment(input);

      // With sentiment_hint=null treated as 0.0, mapped to [0,1] = 0.5
      expect(result.vector.aggregate_sentiment).toBe(0.5);
      // 0.0 is between -0.2 and 0.2, so no bullish or bearish pressure
      expect(result.vector.bullish_pressure).toBe(0);
      expect(result.vector.bearish_pressure).toBe(0);
    });

    it('uses 0.5 as previous aggregate when previous_aggregate_sentiment is null (Req 3.5)', () => {
      // Create articles with sentiment_hint = 0.0 (neutral) so aggregate_sentiment = 0.5
      const input: SentimentEngineInput = {
        articles: [
          makeArticle({ id: 'a1', sentiment_hint: 0.0, published_at: '2024-01-01T00:00:00Z' }),
          makeArticle({ id: 'a2', sentiment_hint: 0.0, published_at: '2024-01-01T00:00:00Z' }),
          makeArticle({ id: 'a3', sentiment_hint: 0.0, published_at: '2024-01-01T00:00:00Z' }),
        ],
        window_end: '2024-01-01T00:00:00Z',
        window_hours: 24,
        previous_aggregate_sentiment: null,
      };

      const result = computeSentiment(input);

      // aggregate_sentiment = 0.5, prev = 0.5 (null defaults to 0.5)
      // momentum = mapToUnitInterval(0.5 - 0.5) = mapToUnitInterval(0) = 0.5
      expect(result.vector.momentum).toBe(0.5);
    });

    it('produces maximum bullish signal for single article with hint=1.0', () => {
      const input: SentimentEngineInput = {
        articles: [
          makeArticle({ id: 'a1', sentiment_hint: 1.0, relevance_score: 1.0, published_at: '2024-01-01T00:00:00Z' }),
        ],
        window_end: '2024-01-01T00:00:00Z',
        window_hours: 24,
        previous_aggregate_sentiment: 0.5,
      };

      const result = computeSentiment(input);

      // With confidence blending (count=1, confidence = 1/3):
      // Raw bullish_pressure = 1.0 (1 article > 0.2 / 1 article total)
      // Blended: 1.0 * (1/3) + 0.5 * (2/3) = 0.333333 + 0.333333 = 0.666667
      expect(result.vector.bullish_pressure).toBeCloseTo(0.666667, 5);

      // Raw bearish_pressure = 0.0 (no articles < -0.2)
      // Blended: 0.0 * (1/3) + 0.5 * (2/3) = 0.333333
      expect(result.vector.bearish_pressure).toBeCloseTo(0.333333, 5);

      // confidence_factor = min(1/3, 1) = 0.333333
      expect(result.confidence_factor).toBeCloseTo(0.333333, 5);
    });

    it('returns neutral vector when all articles are outside the window', () => {
      // Articles published 48 hours before window_end, but window is only 24 hours
      const input: SentimentEngineInput = {
        articles: [
          makeArticle({ id: 'a1', published_at: '2023-12-29T00:00:00Z' }),
          makeArticle({ id: 'a2', published_at: '2023-12-29T12:00:00Z' }),
        ],
        window_end: '2024-01-01T00:00:00Z',
        window_hours: 24,
        previous_aggregate_sentiment: null,
      };

      const result = computeSentiment(input);

      // All articles outside window → same as empty articles
      expect(result.vector.aggregate_sentiment).toBe(0.5);
      expect(result.vector.bullish_pressure).toBe(0.5);
      expect(result.vector.bearish_pressure).toBe(0.5);
      expect(result.vector.article_volume).toBe(0.5);
      expect(result.vector.sentiment_dispersion).toBe(0.5);
      expect(result.vector.momentum).toBe(0.5);
      expect(result.sentiment_score).toBe(0.5);
      expect(result.article_count).toBe(0);
      expect(result.confidence_factor).toBe(0);
    });

    it('completes computation for 100 articles in less than 5 seconds (Req 13.1)', () => {
      const articles: NewsArticle[] = [];
      for (let i = 0; i < 100; i++) {
        const hoursAgo = Math.random() * 24;
        const publishedAt = new Date(
          new Date('2024-01-01T00:00:00Z').getTime() - hoursAgo * 3600000
        ).toISOString();
        articles.push(
          makeArticle({
            id: `perf-${i}`,
            sentiment_hint: Math.random() * 2 - 1, // [-1, 1]
            relevance_score: Math.random(),
            published_at: publishedAt,
          })
        );
      }

      const input: SentimentEngineInput = {
        articles,
        window_end: '2024-01-01T00:00:00Z',
        window_hours: 24,
        previous_aggregate_sentiment: 0.5,
      };

      const start = performance.now();
      const result = computeSentiment(input);
      const elapsed = performance.now() - start;

      expect(elapsed).toBeLessThan(5000);
      expect(result.article_count).toBeGreaterThan(0);
      expect(result.vector.aggregate_sentiment).toBeGreaterThanOrEqual(0);
      expect(result.vector.aggregate_sentiment).toBeLessThanOrEqual(1);
    });
  });

  describe('computeDecayWeight', () => {
    it('returns 1.0 when elapsed is 0', () => {
      expect(computeDecayWeight(0, 8)).toBe(1.0);
    });

    it('returns 0.5 when elapsed equals half-life', () => {
      expect(computeDecayWeight(8, 8)).toBe(0.5);
    });

    it('returns 0.25 when elapsed is double the half-life', () => {
      expect(computeDecayWeight(16, 8)).toBe(0.25);
    });
  });

  describe('roundTo6', () => {
    it('rounds to 6 decimal places', () => {
      expect(roundTo6(0.1234567)).toBe(0.123457);
    });

    it('preserves exact values with fewer decimals', () => {
      expect(roundTo6(0.5)).toBe(0.5);
    });

    it('preserves integer values', () => {
      expect(roundTo6(1.0)).toBe(1.0);
    });
  });

  describe('mapToUnitInterval', () => {
    it('maps -1 to 0', () => {
      expect(mapToUnitInterval(-1)).toBe(0);
    });

    it('maps 0 to 0.5', () => {
      expect(mapToUnitInterval(0)).toBe(0.5);
    });

    it('maps 1 to 1', () => {
      expect(mapToUnitInterval(1)).toBe(1);
    });
  });
});
