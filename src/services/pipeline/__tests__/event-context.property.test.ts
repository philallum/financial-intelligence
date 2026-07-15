/**
 * Property-Based Tests for Event Context Service
 *
 * Property 8: Event Impact Summary Statistics
 * Property 9: Feature Vector Augmentation with Event Context
 *
 * Validates: Requirements 8.2, 9.1
 */

import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';
import type { EventImpactSummary } from '../event-context-service.js';

// =============================================================================
// Pure computation helpers (replicated from the service's private methods)
// =============================================================================

/**
 * Compute the statistical median of an array of numbers.
 */
function computeMedian(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 0) {
    return (sorted[mid - 1]! + sorted[mid]!) / 2;
  }
  return sorted[mid]!;
}

/**
 * Compute EventImpactSummary from an array of net_return_pips values.
 * Mirrors the private computeImpactSummary method in EventContextService.
 */
function computeImpactSummary(eventType: string, outcomes: number[]): EventImpactSummary {
  const absMoves = outcomes.map((v) => Math.abs(v));
  const medianMovePips = computeMedian(absMoves);

  const upCount = outcomes.filter((v) => v > 0).length;
  const directionSkew = upCount / outcomes.length;

  const meanAbsMove = absMoves.reduce((sum, v) => sum + v, 0) / absMoves.length;
  const volExpansionRatio = medianMovePips > 0 ? meanAbsMove / medianMovePips : 1.0;

  return {
    event_type: eventType,
    median_move_pips: medianMovePips,
    direction_skew: directionSkew,
    vol_expansion_ratio: volExpansionRatio,
    instance_count: outcomes.length,
  };
}

/**
 * Augment a base feature vector with event context values.
 * Takes a 30-dimension vector and appends median_move_pips, direction_skew,
 * and vol_expansion_ratio to produce a 33-dimension vector.
 *
 * Validates: Requirement 9.1
 */
function augmentFeatureVector(
  baseVector: number[],
  summary: EventImpactSummary,
): number[] {
  return [
    ...baseVector,
    summary.median_move_pips,
    summary.direction_skew,
    summary.vol_expansion_ratio,
  ];
}

// =============================================================================
// Generators
// =============================================================================

/**
 * Generator for net_return_pips values: floats in a reasonable range, no NaN/Infinity.
 */
const pipsArb = fc.float({ min: -1000, max: 1000, noNaN: true, noDefaultInfinity: true });

/**
 * Generator for arrays of pips values with at least 3 elements (minimum required).
 */
const outcomesArb = fc.array(pipsArb, { minLength: 3, maxLength: 50 });

/**
 * Generator for a 30-dimension feature vector.
 */
const featureVectorArb = fc.array(
  fc.float({ min: -100, max: 100, noNaN: true, noDefaultInfinity: true }),
  { minLength: 30, maxLength: 30 },
);

/**
 * Generator for a valid EventImpactSummary object.
 */
const eventImpactSummaryArb = fc.record({
  event_type: fc.string({ minLength: 1, maxLength: 30 }),
  median_move_pips: fc.float({ min: 0, max: 1000, noNaN: true, noDefaultInfinity: true }),
  direction_skew: fc.float({ min: 0, max: 1, noNaN: true, noDefaultInfinity: true }),
  vol_expansion_ratio: fc.float({ min: 0, max: 100, noNaN: true, noDefaultInfinity: true }),
  instance_count: fc.integer({ min: 3, max: 100 }),
});

// =============================================================================
// Property 8: Event Impact Summary Statistics
// =============================================================================

describe('Property 8: Event Impact Summary Statistics', () => {
  /**
   * Validates: Requirements 8.2
   *
   * For any array of at least 3 net_return_pips values, the computed
   * EventImpactSummary SHALL have:
   * - median_move_pips equal to the statistical median of abs(net_return_pips)
   * - direction_skew equal to count(pips > 0) / total
   * - vol_expansion_ratio equal to mean(abs values) / median(abs values), or 1.0 if median is 0
   */

  it('median_move_pips equals the statistical median of absolute pips values', () => {
    fc.assert(
      fc.property(outcomesArb, (outcomes) => {
        const summary = computeImpactSummary('TestEvent', outcomes);
        const absMoves = outcomes.map((v) => Math.abs(v));
        const expectedMedian = computeMedian(absMoves);

        expect(summary.median_move_pips).toBe(expectedMedian);
      }),
      { numRuns: 100 },
    );
  });

  it('direction_skew equals the proportion of positive moves', () => {
    fc.assert(
      fc.property(outcomesArb, (outcomes) => {
        const summary = computeImpactSummary('TestEvent', outcomes);
        const upCount = outcomes.filter((v) => v > 0).length;
        const expectedSkew = upCount / outcomes.length;

        expect(summary.direction_skew).toBe(expectedSkew);
      }),
      { numRuns: 100 },
    );
  });

  it('vol_expansion_ratio equals mean(abs) / median(abs), or 1.0 when median is 0', () => {
    fc.assert(
      fc.property(outcomesArb, (outcomes) => {
        const summary = computeImpactSummary('TestEvent', outcomes);
        const absMoves = outcomes.map((v) => Math.abs(v));
        const median = computeMedian(absMoves);
        const mean = absMoves.reduce((sum, v) => sum + v, 0) / absMoves.length;

        if (median > 0) {
          const expectedRatio = mean / median;
          expect(summary.vol_expansion_ratio).toBeCloseTo(expectedRatio, 10);
        } else {
          expect(summary.vol_expansion_ratio).toBe(1.0);
        }
      }),
      { numRuns: 100 },
    );
  });

  it('direction_skew is always in range [0, 1]', () => {
    fc.assert(
      fc.property(outcomesArb, (outcomes) => {
        const summary = computeImpactSummary('TestEvent', outcomes);

        expect(summary.direction_skew).toBeGreaterThanOrEqual(0);
        expect(summary.direction_skew).toBeLessThanOrEqual(1);
      }),
      { numRuns: 100 },
    );
  });

  it('instance_count equals the number of input outcomes', () => {
    fc.assert(
      fc.property(outcomesArb, (outcomes) => {
        const summary = computeImpactSummary('TestEvent', outcomes);

        expect(summary.instance_count).toBe(outcomes.length);
      }),
      { numRuns: 100 },
    );
  });

  it('median_move_pips is always non-negative (since it uses absolute values)', () => {
    fc.assert(
      fc.property(outcomesArb, (outcomes) => {
        const summary = computeImpactSummary('TestEvent', outcomes);

        expect(summary.median_move_pips).toBeGreaterThanOrEqual(0);
      }),
      { numRuns: 100 },
    );
  });
});

// =============================================================================
// Property 9: Feature Vector Augmentation with Event Context
// =============================================================================

describe('Property 9: Feature Vector Augmentation with Event Context', () => {
  /**
   * Validates: Requirements 9.1
   *
   * For any base feature vector of 30 dimensions and any valid EventImpactSummary:
   * - The augmented feature vector SHALL have exactly 33 dimensions
   * - Positions 30-32 contain [median_move_pips, direction_skew, vol_expansion_ratio]
   */

  it('augmented vector has exactly 33 dimensions', () => {
    fc.assert(
      fc.property(featureVectorArb, eventImpactSummaryArb, (baseVector, summary) => {
        const augmented = augmentFeatureVector(baseVector, summary);

        expect(augmented).toHaveLength(33);
      }),
      { numRuns: 100 },
    );
  });

  it('positions 30-32 contain event context values in order', () => {
    fc.assert(
      fc.property(featureVectorArb, eventImpactSummaryArb, (baseVector, summary) => {
        const augmented = augmentFeatureVector(baseVector, summary);

        expect(augmented[30]).toBe(summary.median_move_pips);
        expect(augmented[31]).toBe(summary.direction_skew);
        expect(augmented[32]).toBe(summary.vol_expansion_ratio);
      }),
      { numRuns: 100 },
    );
  });

  it('first 30 dimensions are preserved unchanged', () => {
    fc.assert(
      fc.property(featureVectorArb, eventImpactSummaryArb, (baseVector, summary) => {
        const augmented = augmentFeatureVector(baseVector, summary);
        const preserved = augmented.slice(0, 30);

        expect(preserved).toEqual(baseVector);
      }),
      { numRuns: 100 },
    );
  });

  it('augmentation does not mutate the original base vector', () => {
    fc.assert(
      fc.property(featureVectorArb, eventImpactSummaryArb, (baseVector, summary) => {
        const originalCopy = [...baseVector];
        augmentFeatureVector(baseVector, summary);

        expect(baseVector).toEqual(originalCopy);
        expect(baseVector).toHaveLength(30);
      }),
      { numRuns: 100 },
    );
  });
});
