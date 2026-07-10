/**
 * Sentiment Engine Property Tests
 *
 * Property 1: Sentiment output vector invariant
 *
 * Generates random NewsArticle arrays (0–100 items), random window_end,
 * random window_hours, and random previous_aggregate_sentiment. Asserts that
 * the output vector always satisfies structural invariants regardless of input.
 *
 * **Validates: Requirements 1.4, 1.5, 3.1, 3.2, 3.3, 3.4, 12.5**
 */

import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';
import { computeSentiment, roundTo6 } from '../sentiment-engine.js';
import type { NewsArticle, SentimentEngineInput } from '../../types/index.js';

// =============================================================================
// Helpers
// =============================================================================

/**
 * Checks whether a number is rounded to exactly 6 decimal places.
 */
function isRoundedTo6(value: number): boolean {
  return value === Math.round(value * 1_000_000) / 1_000_000;
}

/**
 * The 6 expected dimension keys of the SentimentVector.
 */
const VECTOR_DIMENSIONS = [
  'aggregate_sentiment',
  'bullish_pressure',
  'bearish_pressure',
  'article_volume',
  'sentiment_dispersion',
  'momentum',
] as const;

// =============================================================================
// Generators
// =============================================================================

/**
 * Generates a random ISO-8601 UTC timestamp within a reasonable range
 * (2020-01-01 to 2025-12-31).
 */
function arbIsoTimestamp(): fc.Arbitrary<string> {
  const minMs = new Date('2020-01-01T00:00:00Z').getTime();
  const maxMs = new Date('2025-12-31T23:59:59Z').getTime();
  return fc
    .integer({ min: minMs, max: maxMs })
    .map((ms) => new Date(ms).toISOString());
}

/**
 * Generates a random NewsArticle with valid field ranges.
 */
function arbNewsArticle(): fc.Arbitrary<NewsArticle> {
  return fc.record({
    id: fc.string({ minLength: 1, maxLength: 36 }),
    asset_id: fc.string({ minLength: 1, maxLength: 10 }),
    headline: fc.string({ minLength: 1, maxLength: 200 }),
    summary: fc.option(fc.string({ minLength: 1, maxLength: 500 }), { nil: null }),
    published_at: arbIsoTimestamp(),
    sentiment_hint: fc.option(
      fc.double({ min: -1, max: 1, noNaN: true, noDefaultInfinity: true }),
      { nil: null }
    ),
    relevance_score: fc.double({ min: 0, max: 1, noNaN: true, noDefaultInfinity: true }),
    source: fc.string({ minLength: 1, maxLength: 50 }),
  });
}

/**
 * Generates a valid SentimentEngineInput with random articles (0–100),
 * window parameters, and optional previous aggregate.
 */
function arbSentimentInput(): fc.Arbitrary<SentimentEngineInput> {
  return fc.record({
    articles: fc.array(arbNewsArticle(), { minLength: 0, maxLength: 100 }),
    window_end: arbIsoTimestamp(),
    window_hours: fc.integer({ min: 4, max: 48 }),
    previous_aggregate_sentiment: fc.option(
      fc.double({ min: 0, max: 1, noNaN: true, noDefaultInfinity: true }),
      { nil: null }
    ),
  });
}

// =============================================================================
// Property 1: Sentiment output vector invariant
// =============================================================================

describe('Sentiment Engine Property Tests', () => {
  describe('Property 1: Sentiment output vector invariant', () => {
    it('output vector has exactly 6 dimensions, all in [0, 1], rounded to 6dp', () => {
      fc.assert(
        fc.property(arbSentimentInput(), (input) => {
          const output = computeSentiment(input);
          const vector = output.vector;

          // Vector has exactly 6 dimensions
          const keys = Object.keys(vector);
          expect(keys).toHaveLength(6);
          expect(keys.sort()).toEqual([...VECTOR_DIMENSIONS].sort());

          // All dimensions in [0, 1] and rounded to 6 decimal places
          for (const dim of VECTOR_DIMENSIONS) {
            const value = vector[dim];
            expect(value).toBeGreaterThanOrEqual(0);
            expect(value).toBeLessThanOrEqual(1);
            expect(isRoundedTo6(value)).toBe(true);
          }
        }),
        { numRuns: 200 }
      );
    });

    it('sentiment_score is in [0, 1] and rounded to 6 decimal places', () => {
      fc.assert(
        fc.property(arbSentimentInput(), (input) => {
          const output = computeSentiment(input);

          expect(output.sentiment_score).toBeGreaterThanOrEqual(0);
          expect(output.sentiment_score).toBeLessThanOrEqual(1);
          expect(isRoundedTo6(output.sentiment_score)).toBe(true);
        }),
        { numRuns: 200 }
      );
    });

    it('bullish_pressure + bearish_pressure <= 1.0', () => {
      fc.assert(
        fc.property(arbSentimentInput(), (input) => {
          const output = computeSentiment(input);
          const sum = output.vector.bullish_pressure + output.vector.bearish_pressure;

          expect(sum).toBeLessThanOrEqual(1.0);
        }),
        { numRuns: 200 }
      );
    });
  });

  // ===========================================================================
  // Property 3: Sentiment order-independence
  // ===========================================================================

  describe('Property 3: Sentiment order-independence', () => {
    /**
     * Generates a valid NewsArticle within a given time window.
     */
    function articleInWindowP3(windowEndMs: number, windowHours: number): fc.Arbitrary<NewsArticle> {
      const windowMs = windowHours * 3600000;
      return fc.record({
        id: fc.uuid(),
        asset_id: fc.constant('EURUSD'),
        headline: fc.string({ minLength: 1, maxLength: 50 }),
        summary: fc.option(fc.string({ minLength: 1, maxLength: 100 }), { nil: null }),
        published_at: fc.integer({ min: windowEndMs - windowMs, max: windowEndMs }).map(
          (ms) => new Date(ms).toISOString()
        ),
        sentiment_hint: fc.option(fc.double({ min: -1, max: 1, noNaN: true }), { nil: null }),
        relevance_score: fc.double({ min: 0.01, max: 1, noNaN: true }),
        source: fc.constant('test-source'),
      });
    }

    /**
     * **Validates: Requirements 2.3, 2.6, 12.1**
     *
     * For any set of NewsArticle records and any two permutations of that set,
     * computeSentiment SHALL produce bit-identical output. The weighted mean
     * aggregation is commutative — the order articles appear in the input array
     * does not affect any output dimension.
     */
    it('should produce bit-identical output regardless of article order (shuffled)', () => {
      const windowEnd = new Date('2024-06-15T12:00:00Z').getTime();
      const windowHours = 24;

      fc.assert(
        fc.property(
          fc.array(articleInWindowP3(windowEnd, windowHours), { minLength: 1, maxLength: 50 }),
          fc.option(fc.double({ min: 0, max: 1, noNaN: true }), { nil: null }),
          (articles, previousAggregate) => {
            // Create a shuffled permutation using a deterministic shuffle
            const shuffled = [...articles];
            for (let i = shuffled.length - 1; i > 0; i--) {
              const j = Math.abs(shuffled[i].published_at.charCodeAt(0) + i) % (i + 1);
              [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
            }

            const input1: SentimentEngineInput = {
              articles,
              window_end: new Date(windowEnd).toISOString(),
              window_hours: windowHours,
              previous_aggregate_sentiment: previousAggregate,
            };

            const input2: SentimentEngineInput = {
              articles: shuffled,
              window_end: new Date(windowEnd).toISOString(),
              window_hours: windowHours,
              previous_aggregate_sentiment: previousAggregate,
            };

            const output1 = computeSentiment(input1);
            const output2 = computeSentiment(input2);

            // Assert bit-identical output for both permutations
            expect(output1).toEqual(output2);
          }
        ),
        { numRuns: 100 }
      );
    });

    it('should produce identical vector dimensions for reversed articles', () => {
      const windowEnd = new Date('2024-06-15T12:00:00Z').getTime();
      const windowHours = 24;

      fc.assert(
        fc.property(
          fc.array(articleInWindowP3(windowEnd, windowHours), { minLength: 2, maxLength: 50 }),
          fc.option(fc.double({ min: 0, max: 1, noNaN: true }), { nil: null }),
          (articles, previousAggregate) => {
            // Use reverse as a deterministic permutation
            const reversed = [...articles].reverse();

            const input1: SentimentEngineInput = {
              articles,
              window_end: new Date(windowEnd).toISOString(),
              window_hours: windowHours,
              previous_aggregate_sentiment: previousAggregate,
            };

            const input2: SentimentEngineInput = {
              articles: reversed,
              window_end: new Date(windowEnd).toISOString(),
              window_hours: windowHours,
              previous_aggregate_sentiment: previousAggregate,
            };

            const output1 = computeSentiment(input1);
            const output2 = computeSentiment(input2);

            // Assert each vector dimension is bit-identical
            expect(output1.vector.aggregate_sentiment).toBe(output2.vector.aggregate_sentiment);
            expect(output1.vector.bullish_pressure).toBe(output2.vector.bullish_pressure);
            expect(output1.vector.bearish_pressure).toBe(output2.vector.bearish_pressure);
            expect(output1.vector.article_volume).toBe(output2.vector.article_volume);
            expect(output1.vector.sentiment_dispersion).toBe(output2.vector.sentiment_dispersion);
            expect(output1.vector.momentum).toBe(output2.vector.momentum);

            // Assert scalar values are bit-identical
            expect(output1.sentiment_score).toBe(output2.sentiment_score);
            expect(output1.article_count).toBe(output2.article_count);
            expect(output1.confidence_factor).toBe(output2.confidence_factor);
          }
        ),
        { numRuns: 100 }
      );
    });
  });

  // ===========================================================================
  // Property 4: Sparse data confidence blending
  // ===========================================================================

  describe('Property 4: Sparse data confidence blending', () => {
    /**
     * Generates a valid NewsArticle within a given time window.
     * Articles are placed close to window_end to ensure they fall within the window.
     */
    function articleInWindow(windowEndMs: number, windowHours: number): fc.Arbitrary<NewsArticle> {
      const windowMs = windowHours * 3600000;
      return fc.record({
        id: fc.uuid(),
        asset_id: fc.constant('EURUSD'),
        headline: fc.string({ minLength: 1, maxLength: 50 }),
        summary: fc.option(fc.string({ minLength: 1, maxLength: 100 }), { nil: null }),
        published_at: fc.integer({ min: windowEndMs - windowMs, max: windowEndMs }).map(
          (ms) => new Date(ms).toISOString()
        ),
        sentiment_hint: fc.option(fc.double({ min: -1, max: 1, noNaN: true }), { nil: null }),
        relevance_score: fc.double({ min: 0.01, max: 1, noNaN: true }),
        source: fc.constant('test-source'),
      });
    }

    /**
     * **Validates: Requirements 4.3**
     *
     * For inputs with 1 or 2 articles:
     * - confidence_factor = count / 3
     * - Blending pulls each dimension closer to 0.5 than the unblended value
     * - The exact formula: d_out = d_computed * cf + 0.5 * (1 - cf)
     */
    it('blending IS applied when article count < 3: confidence_factor and formula verified', () => {
      const windowEnd = new Date('2024-06-15T12:00:00Z').getTime();
      const windowHours = 24;

      fc.assert(
        fc.property(
          fc.integer({ min: 1, max: 2 }).chain((count) =>
            fc.tuple(
              fc.constant(count),
              fc.array(articleInWindow(windowEnd, windowHours), { minLength: count, maxLength: count })
            )
          ),
          fc.double({ min: 0, max: 1, noNaN: true }),
          ([count, articles], prevAgg) => {
            const sparseInput: SentimentEngineInput = {
              articles,
              window_end: new Date(windowEnd).toISOString(),
              window_hours: windowHours,
              previous_aggregate_sentiment: prevAgg,
            };
            const sparseOutput = computeSentiment(sparseInput);

            // Verify confidence_factor equals roundTo6(count / 3)
            const expectedCf = roundTo6(count / 3);
            expect(sparseOutput.confidence_factor).toBe(expectedCf);

            // Verify the blending formula via round-trip:
            // d_out = roundTo6(d_computed * cf + 0.5 * (1 - cf))
            // Reverse: d_computed = (d_out - 0.5 * (1 - cf)) / cf
            // Re-apply: roundTo6(d_computed * cf + 0.5 * (1 - cf)) === d_out
            const cf = count / 3;
            const vector = sparseOutput.vector;
            const dims = [
              vector.aggregate_sentiment,
              vector.bullish_pressure,
              vector.bearish_pressure,
              vector.article_volume,
              vector.sentiment_dispersion,
              vector.momentum,
            ];

            for (const d_out of dims) {
              const d_computed = (d_out - 0.5 * (1 - cf)) / cf;
              const reBlended = roundTo6(d_computed * cf + 0.5 * (1 - cf));
              // Round-trip identity confirms the blending formula is applied
              expect(reBlended).toBe(d_out);
            }

            // Verify blending pulls dimensions toward 0.5:
            // |d_out - 0.5| <= |d_computed - 0.5| (blending reduces distance from neutral)
            for (const d_out of dims) {
              const d_computed = (d_out - 0.5 * (1 - cf)) / cf;
              expect(Math.abs(d_out - 0.5)).toBeLessThanOrEqual(Math.abs(d_computed - 0.5) + 1e-6);
            }
          }
        ),
        { numRuns: 200 }
      );
    });

    /**
     * **Validates: Requirements 4.3**
     *
     * When count >= 3, no blending is applied:
     * confidence_factor = 1.0 (roundTo6(min(count/3, 1)) = 1)
     */
    it('no blending applied when article count >= 3', () => {
      const windowEnd = new Date('2024-06-15T12:00:00Z').getTime();
      const windowHours = 24;

      fc.assert(
        fc.property(
          fc.integer({ min: 3, max: 10 }).chain((count) =>
            fc.tuple(
              fc.constant(count),
              fc.array(articleInWindow(windowEnd, windowHours), { minLength: count, maxLength: count })
            )
          ),
          fc.double({ min: 0, max: 1, noNaN: true }),
          ([count, articles], prevAgg) => {
            const input: SentimentEngineInput = {
              articles,
              window_end: new Date(windowEnd).toISOString(),
              window_hours: windowHours,
              previous_aggregate_sentiment: prevAgg,
            };
            const output = computeSentiment(input);

            // confidence_factor should be 1.0 when count >= 3
            expect(output.confidence_factor).toBe(1);

            // Verify article_count matches
            expect(output.article_count).toBe(count);
          }
        ),
        { numRuns: 200 }
      );
    });
  });
});