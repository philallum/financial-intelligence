import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';

// Feature: gbpusd-asset-onboarding, Property 6: Confidence blending for sparse sentiment data

// ─── Blending Formula (pure function under test) ────────────────────────────

/**
 * Confidence blending formula for sparse sentiment data.
 * When fewer than 3 articles are available, the computed sentiment value is
 * blended toward the neutral midpoint (0.5) based on how many articles exist.
 *
 * confidence_factor = article_count / 3
 * blended = (computed × confidence_factor) + (0.5 × (1 − confidence_factor))
 */
function blendWithConfidence(computed: number, articleCount: number): number {
  const confidenceFactor = articleCount / 3;
  return (computed * confidenceFactor) + (0.5 * (1 - confidenceFactor));
}

// ─── Generators ─────────────────────────────────────────────────────────────

/** Article counts that trigger blending: 0, 1, or 2 (fewer than 3) */
const sparseArticleCountArb = fc.constantFrom(0, 1, 2);

/** Computed sentiment values in the valid range [0.0, 1.0] */
const computedSentimentArb = fc.double({ min: 0.0, max: 1.0, noNaN: true });

/** Computed sentiment values that are NOT exactly 0.5 (for strict betweenness check) */
const computedSentimentNotHalfArb = computedSentimentArb.filter((v) => v !== 0.5);

// ─── Property 6: Confidence blending for sparse sentiment data ──────────────

describe('Property 6: Confidence blending for sparse sentiment data', () => {
  /**
   * Validates: Requirements 5.4
   * The blending formula produces the correct result:
   * blended = (computed × confidence_factor) + (0.5 × (1 − confidence_factor))
   * where confidence_factor = article_count / 3
   */
  it('computes blended value using the correct formula', () => {
    fc.assert(
      fc.property(sparseArticleCountArb, computedSentimentArb, (articleCount, computed) => {
        const confidenceFactor = articleCount / 3;
        const expected = (computed * confidenceFactor) + (0.5 * (1 - confidenceFactor));
        const result = blendWithConfidence(computed, articleCount);
        expect(result).toBeCloseTo(expected, 10);
      }),
      { numRuns: 100 },
    );
  });

  /**
   * Validates: Requirements 5.4
   * When computed !== 0.5 and articleCount < 3, blended value is strictly between
   * the computed value and 0.5 (pulled toward neutral).
   */
  it('blended value is strictly between computed and 0.5 when computed !== 0.5', () => {
    fc.assert(
      fc.property(
        fc.constantFrom(1, 2),
        computedSentimentNotHalfArb,
        (articleCount, computed) => {
          const blended = blendWithConfidence(computed, articleCount);
          const lower = Math.min(computed, 0.5);
          const upper = Math.max(computed, 0.5);
          expect(blended).toBeGreaterThan(lower);
          expect(blended).toBeLessThan(upper);
        },
      ),
      { numRuns: 100 },
    );
  });

  /**
   * Validates: Requirements 5.4
   * When computed === 0.5, blended always equals 0.5 regardless of article count.
   */
  it('blended equals 0.5 when computed is exactly 0.5', () => {
    fc.assert(
      fc.property(sparseArticleCountArb, (articleCount) => {
        const blended = blendWithConfidence(0.5, articleCount);
        expect(blended).toBe(0.5);
      }),
      { numRuns: 100 },
    );
  });

  /**
   * Validates: Requirements 5.4
   * When articleCount is 0, confidence_factor is 0, so blended always equals 0.5.
   */
  it('blended equals 0.5 when article count is 0 (no confidence)', () => {
    fc.assert(
      fc.property(computedSentimentArb, (computed) => {
        const blended = blendWithConfidence(computed, 0);
        expect(blended).toBe(0.5);
      }),
      { numRuns: 100 },
    );
  });

  /**
   * Validates: Requirements 5.4
   * Blended values are always within [0.0, 1.0] for valid inputs.
   */
  it('blended value remains in [0.0, 1.0] range', () => {
    fc.assert(
      fc.property(sparseArticleCountArb, computedSentimentArb, (articleCount, computed) => {
        const blended = blendWithConfidence(computed, articleCount);
        expect(blended).toBeGreaterThanOrEqual(0.0);
        expect(blended).toBeLessThanOrEqual(1.0);
      }),
      { numRuns: 100 },
    );
  });
});
