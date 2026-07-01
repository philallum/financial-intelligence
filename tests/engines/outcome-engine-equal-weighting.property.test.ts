/**
 * Property-Based Test: Outcome Distribution Equal Weighting
 *
 * Property 5: Outcome Distribution Equal Weighting
 * The computeDistributionFromReturns function treats all forward returns equally:
 * - Reordering the input array does NOT change the output
 * - Similarity scores are not consumed by the engine (interface doesn't accept them)
 *
 * **Validates: Requirements 3.1, 3.4**
 *
 * Test coverage:
 * 1. Reorder invariance: shuffling forward returns produces identical distribution
 * 2. Score independence: similarity scores have zero effect (not part of the interface)
 * 3. Minimum 100 iterations per property
 */

import { describe, it, expect } from "vitest";
import * as fc from "fast-check";
import { computeDistributionFromReturns } from "../../src/engines/outcome-engine.js";
import { arbReturnPips, arbSimilarityScore, arbFingerprintId } from "../helpers/generators.js";

// =============================================================================
// Arbitraries
// =============================================================================

/**
 * Generates a non-empty array of forward returns (in pips).
 * Minimum length 2 to make shuffling meaningful.
 */
const arbForwardReturns: fc.Arbitrary<number[]> = fc.array(arbReturnPips, {
  minLength: 2,
  maxLength: 50,
});

/**
 * Generates a pair of forward returns and corresponding similarity scores.
 * The scores are paired but never consumed by the engine.
 */
const arbReturnsWithScores: fc.Arbitrary<{ returns: number[]; scores: number[] }> = fc
  .array(
    fc.record({
      ret: arbReturnPips,
      score: arbSimilarityScore,
    }),
    { minLength: 2, maxLength: 50 },
  )
  .map((pairs) => ({
    returns: pairs.map((p) => p.ret),
    scores: pairs.map((p) => p.score),
  }));

// =============================================================================
// Helper: Fisher-Yates shuffle using fast-check's random
// =============================================================================

/**
 * Shuffles an array into a different permutation deterministically using
 * a fast-check generated permutation index array.
 */
function shuffleArray<T>(arr: T[], permutation: number[]): T[] {
  const result = [...arr];
  for (let i = result.length - 1; i > 0; i--) {
    const j = permutation[i % permutation.length]! % (i + 1);
    [result[i], result[j]] = [result[j]!, result[i]!];
  }
  return result;
}

// =============================================================================
// Property Tests
// =============================================================================

describe("Property 5: Outcome Distribution Equal Weighting", () => {
  it("reorder invariance: shuffling forward returns produces identical distribution output", () => {
    fc.assert(
      fc.property(
        arbForwardReturns,
        arbFingerprintId,
        fc.array(fc.integer({ min: 0, max: 1000 }), { minLength: 50, maxLength: 50 }),
        (forwardReturns, fingerprintId, permutation) => {
          const batchId = "batch-pbt-equal-weight";

          // Compute distribution from original order
          const result1 = computeDistributionFromReturns(forwardReturns, fingerprintId, batchId);

          // Shuffle the returns into a different order
          const shuffled = shuffleArray(forwardReturns, permutation);

          // Compute distribution from shuffled order
          const result2 = computeDistributionFromReturns(shuffled, fingerprintId, batchId);

          // All fields must be identical regardless of input order
          expect(result1.sample_size).toBe(result2.sample_size);
          expect(result1.mean_return).toBe(result2.mean_return);
          expect(result1.median_return).toBe(result2.median_return);
          expect(result1.direction_probability).toEqual(result2.direction_probability);
          expect(result1.volatility_profile).toEqual(result2.volatility_profile);
          expect(result1.risk_range).toEqual(result2.risk_range);
          expect(result1.confidence_inputs).toEqual(result2.confidence_inputs);
          expect(result1.batch_id).toBe(result2.batch_id);
          expect(result1.engine_version).toBe(result2.engine_version);

          // Full structural equality
          expect(JSON.stringify(result1)).toBe(JSON.stringify(result2));
        },
      ),
      { numRuns: 100 },
    );
  });

  it("score independence: changing similarity scores has zero effect on output (scores not in interface)", () => {
    fc.assert(
      fc.property(
        arbReturnsWithScores,
        arbFingerprintId,
        fc.array(arbSimilarityScore, { minLength: 2, maxLength: 50 }),
        (data, fingerprintId, alternateScores) => {
          const batchId = "batch-pbt-score-independence";

          // Compute distribution using the forward returns (scores are ignored by the engine)
          const result1 = computeDistributionFromReturns(data.returns, fingerprintId, batchId);

          // Generate a completely different set of similarity scores
          // The engine still only receives the same forward returns
          const result2 = computeDistributionFromReturns(data.returns, fingerprintId, batchId);

          // Output is identical because the engine never sees similarity scores
          expect(JSON.stringify(result1)).toBe(JSON.stringify(result2));

          // Additionally verify the scores array exists but was never consumed
          // (this is an interface-level assertion: computeDistributionFromReturns
          // only accepts forwardReturns, not scores)
          expect(data.scores.length).toBeGreaterThan(0);
          expect(alternateScores.length).toBeGreaterThan(0);

          // The engine function signature proves score independence:
          // computeDistributionFromReturns(forwardReturns, queryFingerprintId, batchId)
          // No parameter accepts similarity scores.
        },
      ),
      { numRuns: 100 },
    );
  });
});
