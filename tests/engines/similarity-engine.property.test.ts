/**
 * Property-Based Test: Engine Determinism (Similarity Engine)
 *
 * Property 1: Engine Determinism (Similarity Engine)
 * For any valid query fingerprint and consistent historical dataset,
 * executing the similarity engine twice with identical inputs produces
 * identical ranked results (same order, same scores, same match_explanation).
 *
 * **Validates: Requirements 2.6, 13.1**
 *
 * Test coverage:
 * 1. Full pipeline determinism via findSimilarFingerprints()
 * 2. Pure function determinism: computeAggregateScore, getRegimeWeights,
 *    distanceToSimilarity, generateMatchExplanation
 * 3. Random fingerprints with consistent mock store
 * 4. Minimum 100 iterations per property
 */

import { describe, it, expect } from "vitest";
import * as fc from "fast-check";
import {
  findSimilarFingerprints,
  getRegimeWeights,
  distanceToSimilarity,
  computeAggregateScore,
  generateMatchExplanation,
  type SimilarityStore,
  type CandidateRecord,
  type VectorSearchResult,
} from "../../src/engines/similarity-engine.js";
import type {
  Fingerprint,
  SimilarityInput,
  RegimeWeightMatrix,
  RegimeClassification,
} from "../../src/types/index.js";
import {
  arbFingerprint,
  arbRegime,
  arbStateLayers,
  arbSimilarityScore,
} from "../helpers/generators.js";

// =============================================================================
// Arbitraries
// =============================================================================

/**
 * Generates a full Fingerprint type (with normalisation fields required by the engine).
 */
const arbFullFingerprint: fc.Arbitrary<Fingerprint> = arbFingerprint.map((fp) => ({
  ...fp,
  normalisation: {
    quantile_table_version: "v1_0",
    scaling_method: "fixed",
  },
}));

/**
 * Generates valid layer scores for testing pure aggregation functions.
 */
const arbLayerScores = fc.record({
  market_structure: fc.double({ min: 0, max: 1, noNaN: true, noDefaultInfinity: true }),
  volatility: fc.double({ min: 0, max: 1, noNaN: true, noDefaultInfinity: true }),
  liquidity: fc.double({ min: 0, max: 1, noNaN: true, noDefaultInfinity: true }),
  macro: fc.double({ min: 0, max: 1, noNaN: true, noDefaultInfinity: true }),
  sentiment: fc.double({ min: 0, max: 1, noNaN: true, noDefaultInfinity: true }),
});

/**
 * Generates a valid weight matrix that sums to 1.0.
 */
const arbWeightMatrix: fc.Arbitrary<RegimeWeightMatrix> = fc
  .array(fc.double({ min: 0.01, max: 1, noNaN: true, noDefaultInfinity: true }), {
    minLength: 5,
    maxLength: 5,
  })
  .map((raw) => {
    const sum = raw.reduce((a, b) => a + b, 0);
    const normalized = raw.map((v) => v / sum);
    return {
      market_structure: normalized[0]!,
      volatility: normalized[1]!,
      liquidity: normalized[2]!,
      macro: normalized[3]!,
      sentiment: normalized[4]!,
    };
  });

/**
 * Generates a distance value for testing distanceToSimilarity.
 */
const arbDistance = fc.double({ min: 0, max: 5, noNaN: true, noDefaultInfinity: true });

/**
 * Generates a distance metric type.
 */
const arbMetric = fc.constantFrom("cosine", "l2") as fc.Arbitrary<"cosine" | "l2">;

// =============================================================================
// Deterministic Mock Store Builder
// =============================================================================

/**
 * Creates a deterministic mock store that returns fixed, consistent results
 * for any given input. The same inputs always produce the same outputs.
 *
 * Uses a seeded approach: candidates are derived deterministically from
 * the query fingerprint's properties.
 */
function buildDeterministicStore(
  candidateCount: number,
  queryFingerprintId: string,
): SimilarityStore {
  // Build fixed candidates
  const candidates: CandidateRecord[] = Array.from(
    { length: candidateCount },
    (_, i) => ({
      fingerprint_id: `candidate-${String(i).padStart(4, "0")}`,
      asset: "EURUSD",
      timeframe: "4H",
      regime: {
        volatility_regime: "HIGH" as const,
        trend_regime: "BULLISH" as const,
        session: "LONDON" as const,
      },
      session: "LONDON",
      market_structure_vector: Array(16).fill(0.5),
      volatility_vector: Array(12).fill(0.5),
      liquidity_vector: Array(20).fill(0.5),
      macro_vector: Array(8).fill(0.5),
      sentiment_vector: Array(6).fill(0.5),
    }),
  );

  // Build deterministic vector search results: distance is based on candidate index
  const buildVectorResults = (
    _layer: string,
    _queryVector: number[],
    candidateIds: string[],
    topN: number,
    _metric: "cosine" | "l2",
  ): VectorSearchResult[] => {
    return candidateIds.slice(0, topN).map((id, i) => ({
      fingerprint_id: id,
      distance: 0.05 + i * 0.02,
    }));
  };

  return {
    preFilterCandidates: async (
      _asset: string,
      _timeframe: string,
      _regime: RegimeClassification,
      _excludeId: string,
    ) => candidates,
    vectorSearch: async (
      layer: string,
      queryVector: number[],
      candidateIds: string[],
      topN: number,
      metric: "cosine" | "l2",
    ) => buildVectorResults(layer, queryVector, candidateIds, topN, metric),
    storeMatches: async () => {},
  };
}

// =============================================================================
// Property Tests: Full Pipeline Determinism
// =============================================================================

describe("Property 1: Engine Determinism (Similarity Engine)", () => {
  it("findSimilarFingerprints produces bit-identical output for any valid fingerprint with consistent store", async () => {
    await fc.assert(
      fc.asyncProperty(
        arbFullFingerprint,
        fc.integer({ min: 3, max: 20 }),
        fc.integer({ min: 5, max: 50 }),
        async (fingerprint, candidateCount, topN) => {
          const store = buildDeterministicStore(
            candidateCount,
            fingerprint.fingerprint_id,
          );
          const input: SimilarityInput = {
            query_fingerprint: fingerprint,
            top_n: topN,
          };
          const batchId = "batch-property-test-001";

          const result1 = await findSimilarFingerprints(input, store, batchId);
          const result2 = await findSimilarFingerprints(input, store, batchId);

          // Bit-identical comparison via JSON.stringify
          expect(JSON.stringify(result1)).toBe(JSON.stringify(result2));
        },
      ),
      { numRuns: 100 },
    );
  });

  it("findSimilarFingerprints ranked order is identical across repeated executions", async () => {
    await fc.assert(
      fc.asyncProperty(
        arbFullFingerprint,
        fc.integer({ min: 5, max: 30 }),
        async (fingerprint, candidateCount) => {
          const store = buildDeterministicStore(
            candidateCount,
            fingerprint.fingerprint_id,
          );
          const input: SimilarityInput = {
            query_fingerprint: fingerprint,
            top_n: 50,
          };

          const result1 = await findSimilarFingerprints(input, store, "batch-001");
          const result2 = await findSimilarFingerprints(input, store, "batch-001");

          // Same number of matches
          expect(result1.match_count).toBe(result2.match_count);

          // Identical ranks and scores
          for (let i = 0; i < result1.matches.length; i++) {
            expect(result1.matches[i]!.rank).toBe(result2.matches[i]!.rank);
            expect(result1.matches[i]!.similarity_score).toBe(
              result2.matches[i]!.similarity_score,
            );
            expect(result1.matches[i]!.match_fingerprint_id).toBe(
              result2.matches[i]!.match_fingerprint_id,
            );
            // match_explanation must also be identical
            expect(JSON.stringify(result1.matches[i]!.match_explanation)).toBe(
              JSON.stringify(result2.matches[i]!.match_explanation),
            );
          }
        },
      ),
      { numRuns: 100 },
    );
  });

  // ===========================================================================
  // Pure Function Determinism
  // ===========================================================================

  it("computeAggregateScore is deterministic for random layer scores and weights", () => {
    fc.assert(
      fc.property(arbLayerScores, arbWeightMatrix, (layerScores, weights) => {
        const score1 = computeAggregateScore(layerScores, weights);
        const score2 = computeAggregateScore(layerScores, weights);
        expect(score1).toBe(score2);
      }),
      { numRuns: 100 },
    );
  });

  it("getRegimeWeights is deterministic for any valid regime", () => {
    fc.assert(
      fc.property(arbRegime, (regime) => {
        const regimeClassification: RegimeClassification = {
          volatility_regime: regime.volatility_regime,
          trend_regime: regime.trend_regime,
          session: regime.session,
        };
        const weights1 = getRegimeWeights(regimeClassification);
        const weights2 = getRegimeWeights(regimeClassification);
        expect(JSON.stringify(weights1)).toBe(JSON.stringify(weights2));
      }),
      { numRuns: 100 },
    );
  });

  it("distanceToSimilarity is deterministic for any valid distance and metric", () => {
    fc.assert(
      fc.property(arbDistance, arbMetric, (distance, metric) => {
        const sim1 = distanceToSimilarity(distance, metric);
        const sim2 = distanceToSimilarity(distance, metric);
        expect(sim1).toBe(sim2);
      }),
      { numRuns: 100 },
    );
  });

  it("generateMatchExplanation is deterministic for random layer scores and weights", () => {
    fc.assert(
      fc.property(arbLayerScores, arbWeightMatrix, (layerScores, weights) => {
        const explanation1 = generateMatchExplanation(layerScores, weights);
        const explanation2 = generateMatchExplanation(layerScores, weights);
        expect(JSON.stringify(explanation1)).toBe(JSON.stringify(explanation2));
      }),
      { numRuns: 100 },
    );
  });

  // ===========================================================================
  // Additional Determinism Properties
  // ===========================================================================

  it("distanceToSimilarity always returns a value in [0, 1]", () => {
    fc.assert(
      fc.property(arbDistance, arbMetric, (distance, metric) => {
        const result = distanceToSimilarity(distance, metric);
        expect(result).toBeGreaterThanOrEqual(0);
        expect(result).toBeLessThanOrEqual(1);
      }),
      { numRuns: 100 },
    );
  });

  it("computeAggregateScore always returns a value in [0, 1]", () => {
    fc.assert(
      fc.property(arbLayerScores, arbWeightMatrix, (layerScores, weights) => {
        const score = computeAggregateScore(layerScores, weights);
        expect(score).toBeGreaterThanOrEqual(0);
        expect(score).toBeLessThanOrEqual(1);
      }),
      { numRuns: 100 },
    );
  });
});
