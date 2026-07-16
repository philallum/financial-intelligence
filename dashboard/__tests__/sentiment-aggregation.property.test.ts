/**
 * Property-Based Tests for Sentiment Aggregation
 *
 * Feature: dashboard-multi-asset
 * Property 6: Sentiment aggregation is arithmetic mean of non-zero values
 *
 * Validates: Requirements 4.3
 *
 * For any array of news articles with sentiment_hint values, the displayed
 * aggregate sentiment SHALL equal the arithmetic mean of all non-zero
 * sentiment_hint values. If no non-zero values exist, the aggregate SHALL be 0.
 */

import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';
import { computeAggregateSentiment, NewsArticle } from '../sentiment-aggregation.js';

// =============================================================================
// Generators
// =============================================================================

/** Generator for a sentiment_hint value: positive, negative, zero, or null. */
const sentimentHintArb: fc.Arbitrary<number | null> = fc.oneof(
  fc.double({ min: -1, max: -0.01, noNaN: true, noDefaultInfinity: true }), // negative
  fc.double({ min: 0.01, max: 1, noNaN: true, noDefaultInfinity: true }),   // positive
  fc.constant(0),                                                            // zero
  fc.constant(null),                                                         // null
);

/** Generator for a non-zero sentiment_hint value. */
const nonZeroSentimentArb: fc.Arbitrary<number> = fc.oneof(
  fc.double({ min: -1, max: -0.01, noNaN: true, noDefaultInfinity: true }),
  fc.double({ min: 0.01, max: 1, noNaN: true, noDefaultInfinity: true }),
);

/** Generator for a valid ISO date string. */
const dateStringArb = fc
  .integer({ min: 1577836800000, max: 1893456000000 }) // 2020-01-01 to 2030-01-01
  .map((ts) => new Date(ts).toISOString());

/** Generator for a single NewsArticle with arbitrary sentiment_hint. */
const newsArticleArb: fc.Arbitrary<NewsArticle> = fc.record({
  headline: fc.option(fc.string(), { nil: undefined }),
  sentiment_hint: sentimentHintArb,
  relevance_score: fc.option(fc.double({ min: 0, max: 1, noNaN: true, noDefaultInfinity: true }), { nil: undefined }),
  published_at: fc.option(dateStringArb, { nil: undefined }),
});

/** Generator for an array of NewsArticles. */
const articlesArb: fc.Arbitrary<NewsArticle[]> = fc.array(newsArticleArb, { minLength: 0, maxLength: 50 });

/** Generator for an article with non-zero sentiment. */
const nonZeroArticleArb: fc.Arbitrary<NewsArticle> = fc.record({
  headline: fc.option(fc.string(), { nil: undefined }),
  sentiment_hint: nonZeroSentimentArb,
  relevance_score: fc.option(fc.double({ min: 0, max: 1, noNaN: true, noDefaultInfinity: true }), { nil: undefined }),
  published_at: fc.option(dateStringArb, { nil: undefined }),
});

/** Generator for an article with zero or null sentiment. */
const zeroOrNullArticleArb: fc.Arbitrary<NewsArticle> = fc.record({
  headline: fc.option(fc.string(), { nil: undefined }),
  sentiment_hint: fc.oneof(fc.constant(0), fc.constant(null)),
  relevance_score: fc.option(fc.double({ min: 0, max: 1, noNaN: true, noDefaultInfinity: true }), { nil: undefined }),
  published_at: fc.option(dateStringArb, { nil: undefined }),
});

// =============================================================================
// Property 6: Sentiment aggregation is arithmetic mean of non-zero values
// =============================================================================

describe('Property 6: Sentiment aggregation is arithmetic mean of non-zero values', () => {
  /**
   * Validates: Requirements 4.3
   *
   * For any array of articles with mixed sentiment_hint values, the aggregate
   * equals the arithmetic mean of all non-zero sentiment_hint values.
   */
  it('computes arithmetic mean of non-zero sentiment_hint values', () => {
    fc.assert(
      fc.property(articlesArb, (articles) => {
        const result = computeAggregateSentiment(articles);
        const nonZero = articles.filter(
          (a) => a.sentiment_hint !== null && a.sentiment_hint !== 0,
        );
        if (nonZero.length === 0) {
          expect(result).toBe(0);
        } else {
          const expectedMean =
            nonZero.reduce((sum, a) => sum + (a.sentiment_hint as number), 0) /
            nonZero.length;
          expect(result).toBeCloseTo(expectedMean, 10);
        }
      }),
      { numRuns: 100 },
    );
  });

  /**
   * Validates: Requirements 4.3
   *
   * If all sentiment_hint values are 0 or null, the aggregate is 0.
   */
  it('returns 0 when all sentiment_hint values are zero or null', () => {
    fc.assert(
      fc.property(
        fc.array(zeroOrNullArticleArb, { minLength: 0, maxLength: 30 }),
        (articles) => {
          const result = computeAggregateSentiment(articles);
          expect(result).toBe(0);
        },
      ),
      { numRuns: 100 },
    );
  });

  /**
   * Validates: Requirements 4.3
   *
   * Filtering out zero/null values from a mixed array gives the correct mean.
   * We generate arrays with at least one non-zero article mixed with zero/null articles.
   */
  it('correctly filters zero values from mixed arrays and computes mean', () => {
    fc.assert(
      fc.property(
        fc.array(nonZeroArticleArb, { minLength: 1, maxLength: 20 }),
        fc.array(zeroOrNullArticleArb, { minLength: 0, maxLength: 20 }),
        (nonZeroArticles, zeroArticles) => {
          // Combine and shuffle
          const combined = [...nonZeroArticles, ...zeroArticles];
          const result = computeAggregateSentiment(combined);

          // Expected: mean of only non-zero articles
          const expectedMean =
            nonZeroArticles.reduce((sum, a) => sum + (a.sentiment_hint as number), 0) /
            nonZeroArticles.length;
          expect(result).toBeCloseTo(expectedMean, 10);
        },
      ),
      { numRuns: 100 },
    );
  });

  /**
   * Validates: Requirements 4.3
   *
   * For an empty array, the aggregate is 0.
   */
  it('returns 0 for an empty articles array', () => {
    fc.assert(
      fc.property(fc.constant([] as NewsArticle[]), (articles) => {
        expect(computeAggregateSentiment(articles)).toBe(0);
      }),
      { numRuns: 100 },
    );
  });
});
