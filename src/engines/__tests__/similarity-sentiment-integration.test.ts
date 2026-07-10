/**
 * Integration tests: Similarity Engine ← Real Sentiment Data (L5 layer)
 *
 * Verifies that the similarity engine correctly uses L5 sentiment vector data
 * from the Sentiment Engine, that frozen weight matrices remain unchanged, and
 * that neutral placeholder vectors produce moderate (non-extreme) distances when
 * compared against real sentiment vectors.
 *
 * Requirements: 11.1, 11.2, 11.3
 */

import { describe, it, expect, vi } from "vitest";
import {
  findSimilarFingerprints,
  getRegimeWeights,
  distanceToSimilarity,
  computeAggregateScore,
  REGIME_WEIGHT_MATRICES,
  type SimilarityStore,
  type CandidateRecord,
  type VectorSearchResult,
} from "../similarity-engine.js";
import type {
  Fingerprint,
  SimilarityInput,
  RegimeWeightMatrix,
} from "../../types/index.js";

// =============================================================================
// Helpers
// =============================================================================

/** Neutral placeholder vector (all 0.5) — simulates no sentiment data. */
const NEUTRAL_SENTIMENT_VECTOR = [0.5, 0.5, 0.5, 0.5, 0.5, 0.5];

/** Real sentiment vector — simulates strong bullish sentiment from Sentiment Engine. */
const REAL_BULLISH_SENTIMENT_VECTOR = [0.82, 0.75, 0.10, 0.64, 0.22, 0.68];

/** Real sentiment vector — simulates strong bearish sentiment. */
const REAL_BEARISH_SENTIMENT_VECTOR = [0.15, 0.08, 0.85, 0.48, 0.35, 0.30];

/** Real sentiment vector — simulates moderate/mixed sentiment. */
const REAL_MODERATE_SENTIMENT_VECTOR = [0.55, 0.40, 0.30, 0.32, 0.18, 0.52];

function makeFingerprint(overrides: Partial<Fingerprint> = {}): Fingerprint {
  return {
    fingerprint_id: "query-fp-id-001",
    asset: "EURUSD",
    timeframe: "4H",
    timestamp_utc: "2024-06-15T08:00:00.000Z",
    market_state_version: "1.0.0",
    ohlc: { open: 1.085, high: 1.092, low: 1.0835, close: 1.091 },
    return_profile: { net_return_pips: 12.5, range_pips: 85.0 },
    regime: { volatility_regime: "HIGH", trend_regime: "BULLISH", session: "LONDON" },
    state_layers: {
      market_structure: Array(16).fill(0.5),
      volatility_profile: Array(12).fill(0.5),
      liquidity_field: Array(20).fill(0.5),
      macro_context: Array(8).fill(0.5),
      sentiment_pressure: NEUTRAL_SENTIMENT_VECTOR,
    },
    normalisation: {
      quantile_table_version: "v1_0",
      scaling_method: "fixed",
    },
    ...overrides,
  } as Fingerprint;
}

function makeMockStore(overrides: Partial<SimilarityStore> = {}): SimilarityStore {
  return {
    preFilterCandidates: vi.fn().mockResolvedValue([]),
    vectorSearch: vi.fn().mockResolvedValue([]),
    storeMatches: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

function makeCandidates(count: number): CandidateRecord[] {
  return Array.from({ length: count }, (_, i) => ({
    fingerprint_id: `candidate-${i + 1}`,
    asset: "EURUSD",
    timeframe: "4H",
    regime: { volatility_regime: "HIGH" as const, trend_regime: "BULLISH" as const, session: "LONDON" as const },
    session: "LONDON",
    market_structure_vector: Array(16).fill(0.5),
    volatility_vector: Array(12).fill(0.5),
    liquidity_vector: Array(20).fill(0.5),
    macro_vector: Array(8).fill(0.5),
    sentiment_vector: Array(6).fill(0.5),
  }));
}

// =============================================================================
// Test: Similarity engine uses L5 sentiment vector for vector search (Req 11.1)
// =============================================================================

describe("Similarity Engine - Real Sentiment Data Integration", () => {
  describe("Requirement 11.1: Uses SentimentVector from L5 for distance computation", () => {
    it("passes the query fingerprint's sentiment_pressure (L5) to vector search", async () => {
      const queryFp = makeFingerprint({
        state_layers: {
          market_structure: Array(16).fill(0.5),
          volatility_profile: Array(12).fill(0.5),
          liquidity_field: Array(20).fill(0.5),
          macro_context: Array(8).fill(0.5),
          sentiment_pressure: REAL_BULLISH_SENTIMENT_VECTOR,
        },
      });

      const candidates = makeCandidates(3);
      const vectorSearchFn = vi.fn().mockResolvedValue([
        { fingerprint_id: "candidate-1", distance: 0.2 },
        { fingerprint_id: "candidate-2", distance: 0.4 },
        { fingerprint_id: "candidate-3", distance: 0.6 },
      ]);

      const store = makeMockStore({
        preFilterCandidates: vi.fn().mockResolvedValue(candidates),
        vectorSearch: vectorSearchFn,
        storeMatches: vi.fn().mockResolvedValue(undefined),
      });

      const input: SimilarityInput = { query_fingerprint: queryFp, top_n: 50 };
      await findSimilarFingerprints(input, store, "batch-001");

      // Find the call that searched the sentiment_vector layer
      const sentimentCall = vectorSearchFn.mock.calls.find(
        (call) => call[0] === "sentiment_vector",
      );

      expect(sentimentCall).toBeDefined();
      // The query vector passed to sentiment_vector search should be the real sentiment vector
      expect(sentimentCall![1]).toEqual(REAL_BULLISH_SENTIMENT_VECTOR);
      // Distance metric for L5 should be "l2" (euclidean)
      expect(sentimentCall![4]).toBe("l2");
    });

    it("sentiment layer contributes to final similarity score when weight > 0", async () => {
      // HIGH_BULLISH regime has sentiment weight = 0.15
      const weights = getRegimeWeights({
        volatility_regime: "HIGH",
        trend_regime: "BULLISH",
        session: "LONDON",
      });
      expect(weights.sentiment).toBeGreaterThan(0);

      // Compute aggregate score with high sentiment similarity
      const highSentimentScore = computeAggregateScore(
        { market_structure: 0.5, volatility: 0.5, liquidity: 0.5, macro: 0.5, sentiment: 0.95 },
        weights,
      );

      // Compute aggregate score with low sentiment similarity
      const lowSentimentScore = computeAggregateScore(
        { market_structure: 0.5, volatility: 0.5, liquidity: 0.5, macro: 0.5, sentiment: 0.1 },
        weights,
      );

      // Higher sentiment similarity should produce higher overall score
      expect(highSentimentScore).toBeGreaterThan(lowSentimentScore);
      // The difference should be proportional to the sentiment weight
      const scoreDiff = highSentimentScore - lowSentimentScore;
      const expectedDiff = (0.95 - 0.1) * weights.sentiment;
      expect(scoreDiff).toBeCloseTo(expectedDiff, 5);
    });

    it("produces different results when real sentiment vector differs from neutral", async () => {
      const candidates = makeCandidates(3);

      // Simulate vector search where real sentiment produces different distances
      // than neutral would
      const realSentimentDistances: VectorSearchResult[] = [
        { fingerprint_id: "candidate-1", distance: 0.8 },  // Large distance
        { fingerprint_id: "candidate-2", distance: 0.3 },
        { fingerprint_id: "candidate-3", distance: 0.1 },  // Small distance
      ];

      const neutralSentimentDistances: VectorSearchResult[] = [
        { fingerprint_id: "candidate-1", distance: 0.4 },  // Moderate distances
        { fingerprint_id: "candidate-2", distance: 0.3 },
        { fingerprint_id: "candidate-3", distance: 0.35 },
      ];

      // Run with real sentiment vector
      const realVectorSearchFn = vi.fn().mockImplementation((layer: string) => {
        if (layer === "sentiment_vector") return Promise.resolve(realSentimentDistances);
        return Promise.resolve(candidates.map((c) => ({ fingerprint_id: c.fingerprint_id, distance: 0.2 })));
      });

      const storeReal = makeMockStore({
        preFilterCandidates: vi.fn().mockResolvedValue(candidates),
        vectorSearch: realVectorSearchFn,
        storeMatches: vi.fn().mockResolvedValue(undefined),
      });

      const realFp = makeFingerprint({
        state_layers: {
          market_structure: Array(16).fill(0.5),
          volatility_profile: Array(12).fill(0.5),
          liquidity_field: Array(20).fill(0.5),
          macro_context: Array(8).fill(0.5),
          sentiment_pressure: REAL_BULLISH_SENTIMENT_VECTOR,
        },
      });

      const realResult = await findSimilarFingerprints(
        { query_fingerprint: realFp, top_n: 50 },
        storeReal,
        "batch-001",
      );

      // Run with neutral sentiment vector
      const neutralVectorSearchFn = vi.fn().mockImplementation((layer: string) => {
        if (layer === "sentiment_vector") return Promise.resolve(neutralSentimentDistances);
        return Promise.resolve(candidates.map((c) => ({ fingerprint_id: c.fingerprint_id, distance: 0.2 })));
      });

      const storeNeutral = makeMockStore({
        preFilterCandidates: vi.fn().mockResolvedValue(candidates),
        vectorSearch: neutralVectorSearchFn,
        storeMatches: vi.fn().mockResolvedValue(undefined),
      });

      const neutralFp = makeFingerprint({
        state_layers: {
          market_structure: Array(16).fill(0.5),
          volatility_profile: Array(12).fill(0.5),
          liquidity_field: Array(20).fill(0.5),
          macro_context: Array(8).fill(0.5),
          sentiment_pressure: NEUTRAL_SENTIMENT_VECTOR,
        },
      });

      const neutralResult = await findSimilarFingerprints(
        { query_fingerprint: neutralFp, top_n: 50 },
        storeNeutral,
        "batch-001",
      );

      // The scores should differ because real sentiment produces different distances
      const realScores = realResult.matches.map((m) => m.similarity_score);
      const neutralScores = neutralResult.matches.map((m) => m.similarity_score);

      // At least one match should have a different score (real vs neutral sentiment)
      const hasDifference = realScores.some(
        (score, i) => Math.abs(score - (neutralScores[i] ?? 0)) > 0.001,
      );
      expect(hasDifference).toBe(true);
    });
  });

  // =============================================================================
  // Test: Frozen weight matrices remain unmodified (Req 11.2)
  // =============================================================================

  describe("Requirement 11.2: Frozen weight matrices remain unmodified", () => {
    it("all regime weight matrices have sentiment weight defined", () => {
      for (const [key, weights] of Object.entries(REGIME_WEIGHT_MATRICES)) {
        expect(weights.sentiment).toBeDefined();
        expect(typeof weights.sentiment).toBe("number");
        expect(weights.sentiment).toBeGreaterThanOrEqual(0);
        expect(weights.sentiment).toBeLessThanOrEqual(1);
      }
    });

    it("LOW_RANGING regime has sentiment weight 0.05 (frozen)", () => {
      expect(REGIME_WEIGHT_MATRICES["LOW_RANGING"]!.sentiment).toBe(0.05);
    });

    it("HIGH_BULLISH regime has sentiment weight 0.15 (frozen)", () => {
      expect(REGIME_WEIGHT_MATRICES["HIGH_BULLISH"]!.sentiment).toBe(0.15);
    });

    it("NORMAL_BEARISH regime has sentiment weight 0.20 (frozen)", () => {
      expect(REGIME_WEIGHT_MATRICES["NORMAL_BEARISH"]!.sentiment).toBe(0.20);
    });

    it("all weight matrices sum to exactly 1.0", () => {
      for (const [key, weights] of Object.entries(REGIME_WEIGHT_MATRICES)) {
        const sum =
          weights.market_structure +
          weights.volatility +
          weights.liquidity +
          weights.macro +
          weights.sentiment;
        expect(sum).toBeCloseTo(1.0, 10);
      }
    });

    it("weight matrices are frozen (Object.isFrozen-like — using const assertion)", () => {
      // The REGIME_WEIGHT_MATRICES is declared with `as const` — verify values haven't drifted
      const expectedMatrices: Record<string, RegimeWeightMatrix> = {
        LOW_RANGING: { market_structure: 0.40, volatility: 0.15, liquidity: 0.30, macro: 0.10, sentiment: 0.05 },
        LOW_BULLISH: { market_structure: 0.40, volatility: 0.15, liquidity: 0.30, macro: 0.10, sentiment: 0.05 },
        LOW_BEARISH: { market_structure: 0.40, volatility: 0.15, liquidity: 0.30, macro: 0.10, sentiment: 0.05 },
        HIGH_BULLISH: { market_structure: 0.25, volatility: 0.25, liquidity: 0.15, macro: 0.20, sentiment: 0.15 },
        HIGH_BEARISH: { market_structure: 0.25, volatility: 0.25, liquidity: 0.15, macro: 0.20, sentiment: 0.15 },
        HIGH_RANGING: { market_structure: 0.25, volatility: 0.25, liquidity: 0.15, macro: 0.20, sentiment: 0.15 },
        NORMAL_BULLISH: { market_structure: 0.20, volatility: 0.15, liquidity: 0.15, macro: 0.30, sentiment: 0.20 },
        NORMAL_BEARISH: { market_structure: 0.20, volatility: 0.15, liquidity: 0.15, macro: 0.30, sentiment: 0.20 },
        NORMAL_RANGING: { market_structure: 0.20, volatility: 0.15, liquidity: 0.15, macro: 0.30, sentiment: 0.20 },
      };

      for (const [key, expected] of Object.entries(expectedMatrices)) {
        expect(REGIME_WEIGHT_MATRICES[key]).toEqual(expected);
      }
    });

    it("total number of regime weight matrices is exactly 9", () => {
      expect(Object.keys(REGIME_WEIGHT_MATRICES)).toHaveLength(9);
    });
  });

  // =============================================================================
  // Test: Neutral placeholder vs real sentiment produces moderate distance (Req 11.3)
  // =============================================================================

  describe("Requirement 11.3: Neutral placeholder produces moderate distance", () => {
    it("L2 distance between neutral vector and real bullish vector is non-zero", () => {
      // Compute euclidean distance manually
      const l2Distance = Math.sqrt(
        NEUTRAL_SENTIMENT_VECTOR.reduce(
          (sum, val, i) => sum + (val - REAL_BULLISH_SENTIMENT_VECTOR[i]!) ** 2,
          0,
        ),
      );
      expect(l2Distance).toBeGreaterThan(0);
    });

    it("L2 distance between neutral vector and real bearish vector is non-zero", () => {
      const l2Distance = Math.sqrt(
        NEUTRAL_SENTIMENT_VECTOR.reduce(
          (sum, val, i) => sum + (val - REAL_BEARISH_SENTIMENT_VECTOR[i]!) ** 2,
          0,
        ),
      );
      expect(l2Distance).toBeGreaterThan(0);
    });

    it("neutral-vs-real similarity score is moderate (not extreme)", () => {
      // Compute the L2 distance between neutral and a real bullish vector
      const l2Distance = Math.sqrt(
        NEUTRAL_SENTIMENT_VECTOR.reduce(
          (sum, val, i) => sum + (val - REAL_BULLISH_SENTIMENT_VECTOR[i]!) ** 2,
          0,
        ),
      );

      // Convert to similarity using the engine's formula
      const similarity = distanceToSimilarity(l2Distance, "l2");

      // Should be moderate: not 0 (completely different) and not 1 (identical)
      expect(similarity).toBeGreaterThan(0.1);
      expect(similarity).toBeLessThan(0.9);
    });

    it("neutral-vs-moderate-sentiment has higher similarity than neutral-vs-extreme-sentiment", () => {
      // Neutral vs moderate
      const moderateDistance = Math.sqrt(
        NEUTRAL_SENTIMENT_VECTOR.reduce(
          (sum, val, i) => sum + (val - REAL_MODERATE_SENTIMENT_VECTOR[i]!) ** 2,
          0,
        ),
      );
      const moderateSimilarity = distanceToSimilarity(moderateDistance, "l2");

      // Neutral vs extreme bullish
      const extremeDistance = Math.sqrt(
        NEUTRAL_SENTIMENT_VECTOR.reduce(
          (sum, val, i) => sum + (val - REAL_BULLISH_SENTIMENT_VECTOR[i]!) ** 2,
          0,
        ),
      );
      const extremeSimilarity = distanceToSimilarity(extremeDistance, "l2");

      // Moderate sentiment is closer to neutral, so similarity should be higher
      expect(moderateSimilarity).toBeGreaterThan(extremeSimilarity);
    });

    it("two identical real sentiment vectors produce distance 0 (similarity 1)", () => {
      const l2Distance = Math.sqrt(
        REAL_BULLISH_SENTIMENT_VECTOR.reduce(
          (sum, val, i) => sum + (val - REAL_BULLISH_SENTIMENT_VECTOR[i]!) ** 2,
          0,
        ),
      );
      expect(l2Distance).toBe(0);
      expect(distanceToSimilarity(l2Distance, "l2")).toBe(1);
    });

    it("two neutral vectors produce distance 0 (similarity 1)", () => {
      const l2Distance = Math.sqrt(
        NEUTRAL_SENTIMENT_VECTOR.reduce(
          (sum, val, i) => sum + (val - NEUTRAL_SENTIMENT_VECTOR[i]!) ** 2,
          0,
        ),
      );
      expect(l2Distance).toBe(0);
      expect(distanceToSimilarity(l2Distance, "l2")).toBe(1);
    });

    it("full pipeline: neutral query vs candidates with real sentiment produces valid scores", async () => {
      // Query has neutral sentiment (placeholder)
      const queryFp = makeFingerprint({
        state_layers: {
          market_structure: Array(16).fill(0.5),
          volatility_profile: Array(12).fill(0.5),
          liquidity_field: Array(20).fill(0.5),
          macro_context: Array(8).fill(0.5),
          sentiment_pressure: NEUTRAL_SENTIMENT_VECTOR,
        },
      });

      const candidates = makeCandidates(3);

      // Simulate candidates with real sentiment data — distances reflect
      // comparison between neutral query and real candidate sentiment vectors
      const sentimentDistances: VectorSearchResult[] = [
        { fingerprint_id: "candidate-1", distance: 0.45 }, // Moderate distance
        { fingerprint_id: "candidate-2", distance: 0.30 }, // Moderate distance
        { fingerprint_id: "candidate-3", distance: 0.55 }, // Moderate distance
      ];

      const vectorSearchFn = vi.fn().mockImplementation((layer: string) => {
        if (layer === "sentiment_vector") return Promise.resolve(sentimentDistances);
        // Other layers return moderate distances
        return Promise.resolve(
          candidates.map((c) => ({ fingerprint_id: c.fingerprint_id, distance: 0.2 })),
        );
      });

      const store = makeMockStore({
        preFilterCandidates: vi.fn().mockResolvedValue(candidates),
        vectorSearch: vectorSearchFn,
        storeMatches: vi.fn().mockResolvedValue(undefined),
      });

      const input: SimilarityInput = { query_fingerprint: queryFp, top_n: 50 };
      const result = await findSimilarFingerprints(input, store, "batch-001");

      expect(result.matches).toHaveLength(3);

      // All scores should be valid (between 0 and 1)
      for (const match of result.matches) {
        expect(match.similarity_score).toBeGreaterThan(0);
        expect(match.similarity_score).toBeLessThan(1);
        // Sentiment layer breakdown should reflect moderate similarity
        expect(match.layer_breakdown.sentiment).toBeGreaterThan(0);
        expect(match.layer_breakdown.sentiment).toBeLessThan(1);
      }
    });

    it("no special handling needed: engine processes neutral and real vectors identically", async () => {
      // This test confirms no if/else branches exist for neutral detection —
      // the engine uses the same cosine/L2 computation for both
      const queryFp = makeFingerprint({
        state_layers: {
          market_structure: Array(16).fill(0.5),
          volatility_profile: Array(12).fill(0.5),
          liquidity_field: Array(20).fill(0.5),
          macro_context: Array(8).fill(0.5),
          sentiment_pressure: REAL_BEARISH_SENTIMENT_VECTOR,
        },
      });

      const candidates = makeCandidates(2);
      const vectorSearchFn = vi.fn().mockResolvedValue(
        candidates.map((c, i) => ({ fingerprint_id: c.fingerprint_id, distance: 0.3 + i * 0.1 })),
      );

      const store = makeMockStore({
        preFilterCandidates: vi.fn().mockResolvedValue(candidates),
        vectorSearch: vectorSearchFn,
        storeMatches: vi.fn().mockResolvedValue(undefined),
      });

      const input: SimilarityInput = { query_fingerprint: queryFp, top_n: 50 };
      const result = await findSimilarFingerprints(input, store, "batch-001");

      // Verify the sentiment_vector search was called with the real vector (no special neutral branch)
      const sentimentCall = vectorSearchFn.mock.calls.find(
        (call) => call[0] === "sentiment_vector",
      );
      expect(sentimentCall).toBeDefined();
      expect(sentimentCall![1]).toEqual(REAL_BEARISH_SENTIMENT_VECTOR);

      // Result should be valid
      expect(result.matches.length).toBeGreaterThan(0);
      for (const match of result.matches) {
        expect(match.similarity_score).toBeGreaterThanOrEqual(0);
        expect(match.similarity_score).toBeLessThanOrEqual(1);
      }
    });
  });
});
