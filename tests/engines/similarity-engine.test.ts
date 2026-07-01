/**
 * Unit tests for the Similarity Engine.
 *
 * Tests cover:
 * - Regime weight matrix selection
 * - Distance-to-similarity conversion
 * - Weighted score aggregation
 * - Match explanation generation
 * - Full pipeline integration (with mocked store)
 * - Edge cases: no candidates, fewer than 50, query fingerprint exclusion
 */

import { describe, it, expect, vi } from "vitest";
import {
  findSimilarFingerprints,
  getRegimeWeights,
  distanceToSimilarity,
  computeAggregateScore,
  generateMatchExplanation,
  buildPreFilterCriteria,
  REGIME_WEIGHT_MATRICES,
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
  SAMPLE_FINGERPRINT,
  TRENDING_HIGH_VOL_REGIME,
  RANGING_LOW_VOL_REGIME,
  NORMAL_BEARISH_REGIME,
} from "../helpers/fixtures.js";

// =============================================================================
// Helpers
// =============================================================================

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
      sentiment_pressure: Array(6).fill(0.5),
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

function makeVectorResults(candidateIds: string[], baseDistance: number): VectorSearchResult[] {
  return candidateIds.map((id, i) => ({
    fingerprint_id: id,
    distance: baseDistance + i * 0.01,
  }));
}

// =============================================================================
// Tests: getRegimeWeights
// =============================================================================

describe("getRegimeWeights", () => {
  it("returns LOW_RANGING weights for low vol ranging regime", () => {
    const regime: RegimeClassification = {
      volatility_regime: "LOW",
      trend_regime: "RANGING",
      session: "ASIA",
    };
    const weights = getRegimeWeights(regime);
    expect(weights).toEqual(REGIME_WEIGHT_MATRICES["LOW_RANGING"]);
    expect(weights.market_structure).toBe(0.40);
    expect(weights.liquidity).toBe(0.30);
  });

  it("returns HIGH_BULLISH weights for high vol bullish regime", () => {
    const regime: RegimeClassification = {
      volatility_regime: "HIGH",
      trend_regime: "BULLISH",
      session: "LONDON",
    };
    const weights = getRegimeWeights(regime);
    expect(weights).toEqual(REGIME_WEIGHT_MATRICES["HIGH_BULLISH"]);
    expect(weights.volatility).toBe(0.25);
    expect(weights.macro).toBe(0.20);
  });

  it("returns NORMAL weights for normal vol regime", () => {
    const regime: RegimeClassification = {
      volatility_regime: "NORMAL",
      trend_regime: "BEARISH",
      session: "NY",
    };
    const weights = getRegimeWeights(regime);
    expect(weights).toEqual(REGIME_WEIGHT_MATRICES["NORMAL_BEARISH"]);
    expect(weights.macro).toBe(0.30);
    expect(weights.sentiment).toBe(0.20);
  });

  it("all weight matrices sum to 1.0", () => {
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
});

// =============================================================================
// Tests: distanceToSimilarity
// =============================================================================

describe("distanceToSimilarity", () => {
  describe("cosine metric", () => {
    it("returns 1.0 for distance 0 (identical vectors)", () => {
      expect(distanceToSimilarity(0, "cosine")).toBe(1);
    });

    it("returns 0.0 for distance 1 (orthogonal vectors)", () => {
      expect(distanceToSimilarity(1, "cosine")).toBe(0);
    });

    it("returns 0.5 for distance 0.5", () => {
      expect(distanceToSimilarity(0.5, "cosine")).toBe(0.5);
    });

    it("clamps negative results to 0", () => {
      expect(distanceToSimilarity(1.5, "cosine")).toBe(0);
    });
  });

  describe("l2 metric", () => {
    it("returns 1.0 for distance 0 (identical vectors)", () => {
      expect(distanceToSimilarity(0, "l2")).toBe(1);
    });

    it("returns 0.5 for distance 1", () => {
      expect(distanceToSimilarity(1, "l2")).toBe(0.5);
    });

    it("returns a positive value for large distances", () => {
      const result = distanceToSimilarity(100, "l2");
      expect(result).toBeGreaterThan(0);
      expect(result).toBeLessThan(0.1);
    });

    it("is monotonically decreasing with distance", () => {
      const d1 = distanceToSimilarity(0.5, "l2");
      const d2 = distanceToSimilarity(1.0, "l2");
      const d3 = distanceToSimilarity(2.0, "l2");
      expect(d1).toBeGreaterThan(d2);
      expect(d2).toBeGreaterThan(d3);
    });
  });
});

// =============================================================================
// Tests: computeAggregateScore
// =============================================================================

describe("computeAggregateScore", () => {
  it("returns 1.0 when all layer scores are 1.0", () => {
    const layerScores = {
      market_structure: 1,
      volatility: 1,
      liquidity: 1,
      macro: 1,
      sentiment: 1,
    };
    const weights: RegimeWeightMatrix = {
      market_structure: 0.2,
      volatility: 0.2,
      liquidity: 0.2,
      macro: 0.2,
      sentiment: 0.2,
    };
    expect(computeAggregateScore(layerScores, weights)).toBe(1.0);
  });

  it("returns 0.0 when all layer scores are 0.0", () => {
    const layerScores = {
      market_structure: 0,
      volatility: 0,
      liquidity: 0,
      macro: 0,
      sentiment: 0,
    };
    const weights: RegimeWeightMatrix = {
      market_structure: 0.4,
      volatility: 0.15,
      liquidity: 0.3,
      macro: 0.1,
      sentiment: 0.05,
    };
    expect(computeAggregateScore(layerScores, weights)).toBe(0.0);
  });

  it("computes correct weighted sum", () => {
    const layerScores = {
      market_structure: 0.9,
      volatility: 0.8,
      liquidity: 0.7,
      macro: 0.5,
      sentiment: 0.3,
    };
    const weights: RegimeWeightMatrix = {
      market_structure: 0.40,
      volatility: 0.15,
      liquidity: 0.30,
      macro: 0.10,
      sentiment: 0.05,
    };
    // Expected: 0.9*0.40 + 0.8*0.15 + 0.7*0.30 + 0.5*0.10 + 0.3*0.05
    //         = 0.36 + 0.12 + 0.21 + 0.05 + 0.015 = 0.755
    const result = computeAggregateScore(layerScores, weights);
    expect(result).toBe(0.755);
  });

  it("returns value with 6 decimal places", () => {
    const layerScores = {
      market_structure: 0.333333,
      volatility: 0.666666,
      liquidity: 0.111111,
      macro: 0.888888,
      sentiment: 0.444444,
    };
    const weights: RegimeWeightMatrix = {
      market_structure: 0.20,
      volatility: 0.20,
      liquidity: 0.20,
      macro: 0.20,
      sentiment: 0.20,
    };
    const result = computeAggregateScore(layerScores, weights);
    const decimalPlaces = result.toString().split(".")[1]?.length ?? 0;
    expect(decimalPlaces).toBeLessThanOrEqual(6);
    expect(result).toBeGreaterThanOrEqual(0);
    expect(result).toBeLessThanOrEqual(1);
  });

  it("clamps result to [0, 1]", () => {
    // This shouldn't normally happen but tests the safety clamp
    const layerScores = {
      market_structure: 1.5,
      volatility: 1.5,
      liquidity: 1.5,
      macro: 1.5,
      sentiment: 1.5,
    };
    const weights: RegimeWeightMatrix = {
      market_structure: 0.40,
      volatility: 0.15,
      liquidity: 0.30,
      macro: 0.10,
      sentiment: 0.05,
    };
    expect(computeAggregateScore(layerScores, weights)).toBe(1.0);
  });
});

// =============================================================================
// Tests: generateMatchExplanation
// =============================================================================

describe("generateMatchExplanation", () => {
  const weights: RegimeWeightMatrix = {
    market_structure: 0.40,
    volatility: 0.15,
    liquidity: 0.30,
    macro: 0.10,
    sentiment: 0.05,
  };

  it("classifies layers above threshold as matched", () => {
    const layerScores = {
      market_structure: 0.9,
      volatility: 0.8,
      liquidity: 0.7,
      macro: 0.3,
      sentiment: 0.2,
    };
    const result = generateMatchExplanation(layerScores, weights);
    expect(result.matched_layers).toContain("market_structure");
    expect(result.matched_layers).toContain("volatility");
    expect(result.matched_layers).toContain("liquidity");
    expect(result.mismatched_layers).toContain("macro");
    expect(result.mismatched_layers).toContain("sentiment");
  });

  it("determines primary match reason from highest weighted contributing layer", () => {
    const layerScores = {
      market_structure: 0.95,
      volatility: 0.8,
      liquidity: 0.85,
      macro: 0.3,
      sentiment: 0.2,
    };
    const result = generateMatchExplanation(layerScores, weights);
    expect(result.primary_match_reason).toBe("strong_market_structure_alignment");
  });

  it("returns weak_overall_match when no layers exceed threshold", () => {
    const layerScores = {
      market_structure: 0.3,
      volatility: 0.2,
      liquidity: 0.4,
      macro: 0.1,
      sentiment: 0.5,
    };
    const result = generateMatchExplanation(layerScores, weights);
    expect(result.primary_match_reason).toBe("weak_overall_match");
    expect(result.matched_layers).toHaveLength(0);
    expect(result.mismatched_layers).toHaveLength(5);
  });
});

// =============================================================================
// Tests: buildPreFilterCriteria
// =============================================================================

describe("buildPreFilterCriteria", () => {
  it("extracts correct filter criteria from fingerprint", () => {
    const fp = makeFingerprint();
    const criteria = buildPreFilterCriteria(fp);
    expect(criteria).toEqual({
      asset: "EURUSD",
      timeframe: "4H",
      volatility_regime: "HIGH",
      trend_regime: "BULLISH",
      session: "LONDON",
    });
  });
});

// =============================================================================
// Tests: findSimilarFingerprints (full pipeline)
// =============================================================================

describe("findSimilarFingerprints", () => {
  it("returns empty matches when no candidates pass pre-filter", async () => {
    const store = makeMockStore();
    const input: SimilarityInput = {
      query_fingerprint: makeFingerprint(),
      top_n: 50,
    };

    const result = await findSimilarFingerprints(input, store, "batch-001");

    expect(result.matches).toHaveLength(0);
    expect(result.match_count).toBe(0);
    expect(result.regime_weights_used).toEqual(
      REGIME_WEIGHT_MATRICES["HIGH_BULLISH"],
    );
  });

  it("excludes query fingerprint from results", async () => {
    const queryFp = makeFingerprint({ fingerprint_id: "query-fp-id-001" });
    const candidates = [
      ...makeCandidates(3),
      // Also include the query fingerprint ID in vector search results
    ];

    const vectorResults: VectorSearchResult[] = [
      { fingerprint_id: "query-fp-id-001", distance: 0 }, // Self — should be excluded
      { fingerprint_id: "candidate-1", distance: 0.1 },
      { fingerprint_id: "candidate-2", distance: 0.2 },
      { fingerprint_id: "candidate-3", distance: 0.3 },
    ];

    const store = makeMockStore({
      preFilterCandidates: vi.fn().mockResolvedValue(candidates),
      vectorSearch: vi.fn().mockResolvedValue(vectorResults),
    });

    const input: SimilarityInput = { query_fingerprint: queryFp, top_n: 50 };
    const result = await findSimilarFingerprints(input, store, "batch-001");

    const matchIds = result.matches.map((m) => m.match_fingerprint_id);
    expect(matchIds).not.toContain("query-fp-id-001");
  });

  it("returns fewer than 50 matches when not enough candidates exist", async () => {
    const queryFp = makeFingerprint();
    const candidates = makeCandidates(5);

    const vectorResults = makeVectorResults(
      candidates.map((c) => c.fingerprint_id),
      0.1,
    );

    const store = makeMockStore({
      preFilterCandidates: vi.fn().mockResolvedValue(candidates),
      vectorSearch: vi.fn().mockResolvedValue(vectorResults),
    });

    const input: SimilarityInput = { query_fingerprint: queryFp, top_n: 50 };
    const result = await findSimilarFingerprints(input, store, "batch-001");

    expect(result.match_count).toBe(5);
    expect(result.matches).toHaveLength(5);
  });

  it("assigns ranks 1 through N in descending score order", async () => {
    const queryFp = makeFingerprint();
    const candidates = makeCandidates(5);

    const vectorResults = makeVectorResults(
      candidates.map((c) => c.fingerprint_id),
      0.05,
    );

    const store = makeMockStore({
      preFilterCandidates: vi.fn().mockResolvedValue(candidates),
      vectorSearch: vi.fn().mockResolvedValue(vectorResults),
    });

    const input: SimilarityInput = { query_fingerprint: queryFp, top_n: 50 };
    const result = await findSimilarFingerprints(input, store, "batch-001");

    for (let i = 0; i < result.matches.length; i++) {
      expect(result.matches[i]!.rank).toBe(i + 1);
    }

    // Scores should be in descending order
    for (let i = 1; i < result.matches.length; i++) {
      expect(result.matches[i - 1]!.similarity_score).toBeGreaterThanOrEqual(
        result.matches[i]!.similarity_score,
      );
    }
  });

  it("caps results at MAX_SIMILARITY_MATCHES even if top_n is larger", async () => {
    const queryFp = makeFingerprint();
    const candidates = makeCandidates(100);

    const vectorResults = makeVectorResults(
      candidates.map((c) => c.fingerprint_id),
      0.01,
    );

    const store = makeMockStore({
      preFilterCandidates: vi.fn().mockResolvedValue(candidates),
      vectorSearch: vi.fn().mockResolvedValue(vectorResults),
    });

    const input: SimilarityInput = { query_fingerprint: queryFp, top_n: 200 };
    const result = await findSimilarFingerprints(input, store, "batch-001");

    expect(result.match_count).toBeLessThanOrEqual(50);
  });

  it("stores matches via store.storeMatches when results exist", async () => {
    const queryFp = makeFingerprint();
    const candidates = makeCandidates(3);
    const vectorResults = makeVectorResults(
      candidates.map((c) => c.fingerprint_id),
      0.1,
    );

    const storeMatchesFn = vi.fn().mockResolvedValue(undefined);
    const store = makeMockStore({
      preFilterCandidates: vi.fn().mockResolvedValue(candidates),
      vectorSearch: vi.fn().mockResolvedValue(vectorResults),
      storeMatches: storeMatchesFn,
    });

    const input: SimilarityInput = { query_fingerprint: queryFp, top_n: 50 };
    await findSimilarFingerprints(input, store, "batch-001");

    expect(storeMatchesFn).toHaveBeenCalledTimes(1);
    const storedMatches = storeMatchesFn.mock.calls[0][0];
    expect(storedMatches.length).toBe(3);
  });

  it("does not store matches when no results", async () => {
    const store = makeMockStore();
    const input: SimilarityInput = {
      query_fingerprint: makeFingerprint(),
      top_n: 50,
    };

    await findSimilarFingerprints(input, store, "batch-001");

    expect(store.storeMatches).not.toHaveBeenCalled();
  });

  it("includes correct batch_id in all matches", async () => {
    const queryFp = makeFingerprint();
    const candidates = makeCandidates(3);
    const vectorResults = makeVectorResults(
      candidates.map((c) => c.fingerprint_id),
      0.1,
    );

    const store = makeMockStore({
      preFilterCandidates: vi.fn().mockResolvedValue(candidates),
      vectorSearch: vi.fn().mockResolvedValue(vectorResults),
    });

    const input: SimilarityInput = { query_fingerprint: queryFp, top_n: 50 };
    const result = await findSimilarFingerprints(input, store, "batch-xyz-999");

    for (const match of result.matches) {
      expect(match.batch_id).toBe("batch-xyz-999");
    }
  });

  it("similarity_score is between 0 and 1 with 6 decimal places", async () => {
    const queryFp = makeFingerprint();
    const candidates = makeCandidates(10);
    const vectorResults = makeVectorResults(
      candidates.map((c) => c.fingerprint_id),
      0.15,
    );

    const store = makeMockStore({
      preFilterCandidates: vi.fn().mockResolvedValue(candidates),
      vectorSearch: vi.fn().mockResolvedValue(vectorResults),
    });

    const input: SimilarityInput = { query_fingerprint: queryFp, top_n: 50 };
    const result = await findSimilarFingerprints(input, store, "batch-001");

    for (const match of result.matches) {
      expect(match.similarity_score).toBeGreaterThanOrEqual(0);
      expect(match.similarity_score).toBeLessThanOrEqual(1);
      const decimals = match.similarity_score.toString().split(".")[1]?.length ?? 0;
      expect(decimals).toBeLessThanOrEqual(6);
    }
  });

  it("includes layer_breakdown with all 5 layers", async () => {
    const queryFp = makeFingerprint();
    const candidates = makeCandidates(2);
    const vectorResults = makeVectorResults(
      candidates.map((c) => c.fingerprint_id),
      0.2,
    );

    const store = makeMockStore({
      preFilterCandidates: vi.fn().mockResolvedValue(candidates),
      vectorSearch: vi.fn().mockResolvedValue(vectorResults),
    });

    const input: SimilarityInput = { query_fingerprint: queryFp, top_n: 50 };
    const result = await findSimilarFingerprints(input, store, "batch-001");

    for (const match of result.matches) {
      expect(match.layer_breakdown).toHaveProperty("market_structure");
      expect(match.layer_breakdown).toHaveProperty("volatility");
      expect(match.layer_breakdown).toHaveProperty("liquidity");
      expect(match.layer_breakdown).toHaveProperty("macro");
      expect(match.layer_breakdown).toHaveProperty("sentiment");
    }
  });

  it("includes match_explanation with matched/mismatched layers and reason", async () => {
    const queryFp = makeFingerprint();
    const candidates = makeCandidates(2);
    const vectorResults = makeVectorResults(
      candidates.map((c) => c.fingerprint_id),
      0.2,
    );

    const store = makeMockStore({
      preFilterCandidates: vi.fn().mockResolvedValue(candidates),
      vectorSearch: vi.fn().mockResolvedValue(vectorResults),
    });

    const input: SimilarityInput = { query_fingerprint: queryFp, top_n: 50 };
    const result = await findSimilarFingerprints(input, store, "batch-001");

    for (const match of result.matches) {
      expect(match.match_explanation).toHaveProperty("matched_layers");
      expect(match.match_explanation).toHaveProperty("mismatched_layers");
      expect(match.match_explanation).toHaveProperty("primary_match_reason");
      expect(Array.isArray(match.match_explanation.matched_layers)).toBe(true);
      expect(Array.isArray(match.match_explanation.mismatched_layers)).toBe(true);
      expect(typeof match.match_explanation.primary_match_reason).toBe("string");
    }
  });

  it("returns the correct regime_weights_used", async () => {
    const queryFp = makeFingerprint({
      regime: { volatility_regime: "LOW", trend_regime: "RANGING", session: "ASIA" },
    });

    const store = makeMockStore();
    const input: SimilarityInput = { query_fingerprint: queryFp, top_n: 50 };
    const result = await findSimilarFingerprints(input, store, "batch-001");

    expect(result.regime_weights_used).toEqual(REGIME_WEIGHT_MATRICES["LOW_RANGING"]);
  });
});
