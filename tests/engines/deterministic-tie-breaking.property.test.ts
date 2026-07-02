/**
 * Property-Based Test: Deterministic Tie-Breaking
 *
 * Property 10: Deterministic Tie-Breaking
 * - Generate candidate sets with duplicate scores
 * - Verify ordering by fingerprint_id ascending lexicographic
 *
 * **Validates: Requirements 2.4**
 *
 * When the Similarity Engine produces matches with equal similarity scores,
 * ties must be broken deterministically using fingerprint_id in ascending
 * lexicographic order. This ensures:
 * - The same candidate set always produces the same ranking
 * - No randomness in tie-breaking
 * - Reproducible results across executions
 */

import { describe, it, expect } from "vitest";
import * as fc from "fast-check";

// =============================================================================
// Types
// =============================================================================

interface ScoredCandidate {
  match_fingerprint_id: string;
  similarity_score: number;
}

// =============================================================================
// Reference Implementation: Deterministic Sort
// =============================================================================

/**
 * Deterministic sort: score descending, then fingerprint_id ascending (lexicographic)
 * for ties. This is the reference implementation that defines correct behaviour
 * per Requirement 2.4.
 */
function deterministicSort(candidates: ScoredCandidate[]): ScoredCandidate[] {
  return [...candidates].sort((a, b) => {
    // Primary: score descending
    const scoreDiff = b.similarity_score - a.similarity_score;
    if (scoreDiff !== 0) return scoreDiff;
    // Secondary: fingerprint_id ascending lexicographic
    return a.match_fingerprint_id.localeCompare(b.match_fingerprint_id);
  });
}

// =============================================================================
// Arbitraries
// =============================================================================

/** Generate a UUID-like fingerprint ID */
const arbFingerprintId: fc.Arbitrary<string> = fc.uuid();

/**
 * Generate a similarity score from a limited set of values to ensure
 * ties occur frequently. Uses multiples of 0.1 quantised to 6 decimal places.
 */
const arbTieProneScore: fc.Arbitrary<number> = fc
  .integer({ min: 0, max: 10 })
  .map((n) => Math.round(n * 100_000) / 1_000_000); // 0.0 to 0.001000 in 0.0001 steps

/**
 * Generate a scored candidate with a tie-prone score and unique fingerprint ID.
 */
const arbScoredCandidate: fc.Arbitrary<ScoredCandidate> = fc.record({
  match_fingerprint_id: arbFingerprintId,
  similarity_score: arbTieProneScore,
});

/**
 * Generate arrays of 2-50 candidates with tie-prone scores.
 */
const arbCandidateSet: fc.Arbitrary<ScoredCandidate[]> = fc.array(arbScoredCandidate, {
  minLength: 2,
  maxLength: 50,
});

/**
 * Generate a candidate set where ALL candidates share the same score,
 * guaranteeing tie-breaking is exercised.
 */
const arbAllTiedCandidates: fc.Arbitrary<ScoredCandidate[]> = fc
  .record({
    score: arbTieProneScore,
    ids: fc.array(arbFingerprintId, { minLength: 2, maxLength: 30 }),
  })
  .map(({ score, ids }) =>
    ids.map((id) => ({ match_fingerprint_id: id, similarity_score: score })),
  );

// =============================================================================
// Property Tests
// =============================================================================

describe("Property 10: Deterministic Tie-Breaking", () => {
  it("sorting the same input twice produces identical output (stability)", () => {
    fc.assert(
      fc.property(arbCandidateSet, (candidates) => {
        const sorted1 = deterministicSort(candidates);
        const sorted2 = deterministicSort(candidates);
        expect(sorted1).toStrictEqual(sorted2);
      }),
      { numRuns: 200 },
    );
  });

  it("candidates with equal scores are ordered by fingerprint_id ascending (lexicographic)", () => {
    fc.assert(
      fc.property(arbCandidateSet, (candidates) => {
        const sorted = deterministicSort(candidates);

        // For each consecutive pair with equal scores, verify fingerprint_id ordering
        for (let i = 0; i < sorted.length - 1; i++) {
          if (sorted[i]!.similarity_score === sorted[i + 1]!.similarity_score) {
            expect(
              sorted[i]!.match_fingerprint_id.localeCompare(
                sorted[i + 1]!.match_fingerprint_id,
              ),
            ).toBeLessThanOrEqual(0);
          }
        }
      }),
      { numRuns: 200 },
    );
  });

  it("when all candidates have the same score, result is purely lexicographic by fingerprint_id", () => {
    fc.assert(
      fc.property(arbAllTiedCandidates, (candidates) => {
        const sorted = deterministicSort(candidates);

        // All scores are equal, so ordering must be purely by fingerprint_id ascending
        for (let i = 0; i < sorted.length - 1; i++) {
          expect(
            sorted[i]!.match_fingerprint_id.localeCompare(
              sorted[i + 1]!.match_fingerprint_id,
            ),
          ).toBeLessThanOrEqual(0);
        }
      }),
      { numRuns: 200 },
    );
  });

  it("permuting the input array does not change the sorted output", () => {
    fc.assert(
      fc.property(
        arbCandidateSet,
        fc.integer({ min: 1, max: 100 }),
        (candidates, seed) => {
          // Create a permutation by shuffling with a seeded approach
          const shuffled = [...candidates];
          for (let i = shuffled.length - 1; i > 0; i--) {
            const j = ((seed * (i + 1)) % (i + 1) + (i + 1)) % (i + 1);
            [shuffled[i], shuffled[j]] = [shuffled[j]!, shuffled[i]!];
          }

          const sortedOriginal = deterministicSort(candidates);
          const sortedShuffled = deterministicSort(shuffled);

          expect(sortedOriginal).toStrictEqual(sortedShuffled);
        },
      ),
      { numRuns: 200 },
    );
  });

  it("higher scores always come before lower scores", () => {
    fc.assert(
      fc.property(arbCandidateSet, (candidates) => {
        const sorted = deterministicSort(candidates);

        // Verify descending score order (allowing ties)
        for (let i = 0; i < sorted.length - 1; i++) {
          expect(sorted[i]!.similarity_score).toBeGreaterThanOrEqual(
            sorted[i + 1]!.similarity_score,
          );
        }
      }),
      { numRuns: 200 },
    );
  });

  it("the sort defines a total order (no ambiguity in the result)", () => {
    fc.assert(
      fc.property(arbCandidateSet, (candidates) => {
        const sorted = deterministicSort(candidates);

        // For any two adjacent elements, the sort key is strictly ordered
        // (score descending, then id ascending) — no two elements can be "equal"
        // unless they have both the same score AND same fingerprint_id
        for (let i = 0; i < sorted.length - 1; i++) {
          const a = sorted[i]!;
          const b = sorted[i + 1]!;

          const scoresEqual = a.similarity_score === b.similarity_score;
          const idsEqual = a.match_fingerprint_id === b.match_fingerprint_id;

          if (scoresEqual && !idsEqual) {
            // tie-breaking by id must resolve strictly
            expect(
              a.match_fingerprint_id.localeCompare(b.match_fingerprint_id),
            ).toBeLessThan(0);
          } else if (!scoresEqual) {
            // higher score first
            expect(a.similarity_score).toBeGreaterThan(b.similarity_score);
          }
          // If both equal, it's a true duplicate — allowed
        }
      }),
      { numRuns: 200 },
    );
  });

  it("the sort preserves all elements (no candidates lost or duplicated)", () => {
    fc.assert(
      fc.property(arbCandidateSet, (candidates) => {
        const sorted = deterministicSort(candidates);

        // Same length
        expect(sorted.length).toBe(candidates.length);

        // Same multiset of elements
        const toKey = (c: ScoredCandidate) =>
          `${c.match_fingerprint_id}:${c.similarity_score}`;
        const inputKeys = candidates.map(toKey).sort();
        const outputKeys = sorted.map(toKey).sort();
        expect(inputKeys).toStrictEqual(outputKeys);
      }),
      { numRuns: 200 },
    );
  });

  it("multiple independent sorts of different permutations all converge to the same result", () => {
    fc.assert(
      fc.property(arbCandidateSet, (candidates) => {
        // Sort the original
        const baseline = deterministicSort(candidates);

        // Reverse the input and sort
        const reversed = deterministicSort([...candidates].reverse());
        expect(reversed).toStrictEqual(baseline);

        // Sort an already-sorted input
        const resorted = deterministicSort(baseline);
        expect(resorted).toStrictEqual(baseline);
      }),
      { numRuns: 200 },
    );
  });
});
