/**
 * Similarity Engine
 *
 * Retrieves the top N historically similar fingerprints using a three-tiered pipeline:
 *   Step 1: Pre-filter candidates by asset, timeframe, and regime metadata (SQL)
 *   Step 2: pgvector HNSW search across 5 state layers (cosine for L1-L3, L2/euclidean for L4-L5)
 *   Step 3: Regime-based linear weight aggregation with frozen weight matrices
 *
 * Key invariants:
 * - DETERMINISTIC: identical inputs + identical dataset → identical ranked results
 * - NO outcome bias: no performance-based weighting or distribution logic
 * - NO dynamic thresholds: filtering and weights are frozen per engine version
 * - Retrieval purity: operates exclusively on structural similarity
 * - Frozen normalisation: all weight matrices are versioned and immutable per release
 *
 * Requirements: 2.1, 2.2, 2.3, 2.4, 2.5, 2.6, 2.7
 */

import type {
  Fingerprint,
  SimilarityInput,
  SimilarityMatch,
  SimilarityOutput,
  RegimeWeightMatrix,
  RegimeClassification,
} from "../types/index.js";
import { MAX_SIMILARITY_MATCHES } from "../config/constants.js";

// =============================================================================
// Constants
// =============================================================================

const ENGINE_VERSION = "1.0.0";

/**
 * Frozen weight matrices per regime classification.
 * These are static, versioned, and immutable per engine release.
 * Key is derived from: `${volatility_regime}_${trend_regime}`
 *
 * From the specification:
 * - LOW VOL / MEAN REVERSION (RANGING): structure=0.40, liquidity=0.30, volatility=0.15, macro=0.10, sentiment=0.05
 * - HIGH VOL / BREAKOUT (BULLISH/BEARISH): structure=0.25, liquidity=0.15, volatility=0.25, macro=0.20, sentiment=0.15
 * - MACRO EVENT DRIVEN (NORMAL + HIGH macro activity): structure=0.20, liquidity=0.15, volatility=0.15, macro=0.30, sentiment=0.20
 */
export const REGIME_WEIGHT_MATRICES: Record<string, RegimeWeightMatrix> = {
  // LOW volatility + RANGING = mean reversion regime
  LOW_RANGING: {
    market_structure: 0.40,
    volatility: 0.15,
    liquidity: 0.30,
    macro: 0.10,
    sentiment: 0.05,
  },
  // LOW volatility + BULLISH/BEARISH = mild trend, lean structural
  LOW_BULLISH: {
    market_structure: 0.40,
    volatility: 0.15,
    liquidity: 0.30,
    macro: 0.10,
    sentiment: 0.05,
  },
  LOW_BEARISH: {
    market_structure: 0.40,
    volatility: 0.15,
    liquidity: 0.30,
    macro: 0.10,
    sentiment: 0.05,
  },
  // HIGH volatility + BULLISH/BEARISH = breakout regime
  HIGH_BULLISH: {
    market_structure: 0.25,
    volatility: 0.25,
    liquidity: 0.15,
    macro: 0.20,
    sentiment: 0.15,
  },
  HIGH_BEARISH: {
    market_structure: 0.25,
    volatility: 0.25,
    liquidity: 0.15,
    macro: 0.20,
    sentiment: 0.15,
  },
  HIGH_RANGING: {
    market_structure: 0.25,
    volatility: 0.25,
    liquidity: 0.15,
    macro: 0.20,
    sentiment: 0.15,
  },
  // NORMAL volatility = macro event driven
  NORMAL_BULLISH: {
    market_structure: 0.20,
    volatility: 0.15,
    liquidity: 0.15,
    macro: 0.30,
    sentiment: 0.20,
  },
  NORMAL_BEARISH: {
    market_structure: 0.20,
    volatility: 0.15,
    liquidity: 0.15,
    macro: 0.30,
    sentiment: 0.20,
  },
  NORMAL_RANGING: {
    market_structure: 0.20,
    volatility: 0.15,
    liquidity: 0.15,
    macro: 0.30,
    sentiment: 0.20,
  },
} as const;

/** Default weight matrix if no regime match (should not happen with valid data) */
const DEFAULT_WEIGHT_MATRIX: RegimeWeightMatrix = {
  market_structure: 0.20,
  volatility: 0.20,
  liquidity: 0.20,
  macro: 0.20,
  sentiment: 0.20,
};

/** Threshold for classifying a layer as "matched" vs "mismatched" */
const LAYER_MATCH_THRESHOLD = 0.6;

// =============================================================================
// Database Interaction Types
// =============================================================================

/** Candidate fingerprint record returned from DB queries. */
export interface CandidateRecord {
  fingerprint_id: string;
  asset: string;
  timeframe: string;
  regime: RegimeClassification;
  session: string;
  market_structure_vector: number[];
  volatility_vector: number[];
  liquidity_vector: number[];
  macro_vector: number[];
  sentiment_vector: number[];
}

/** Result from a single-layer HNSW vector search. */
export interface VectorSearchResult {
  fingerprint_id: string;
  distance: number;
}

/** Database access interface for dependency injection. */
export interface SimilarityStore {
  /**
   * Step 1: Pre-filter candidates by asset, timeframe, and regime metadata.
   * Returns fingerprint IDs that pass the pre-similarity gate.
   */
  preFilterCandidates(
    asset: string,
    timeframe: string,
    regime: RegimeClassification,
    excludeFingerprintId: string,
  ): Promise<CandidateRecord[]>;

  /**
   * Step 2: Execute HNSW vector search for a specific layer.
   * Returns top candidates with their distances.
   */
  vectorSearch(
    layer: string,
    queryVector: number[],
    candidateIds: string[],
    topN: number,
    distanceMetric: "cosine" | "l2",
  ): Promise<VectorSearchResult[]>;

  /**
   * Store similarity matches to the similarity_matches table.
   */
  storeMatches(matches: SimilarityMatch[]): Promise<void>;
}

// =============================================================================
// Public API
// =============================================================================

/**
 * Execute the full similarity retrieval pipeline.
 * This is the main entry point for the similarity engine.
 *
 * @param input - The query fingerprint and top_n parameter
 * @param store - Database access interface (injected for testability)
 * @param batchId - Current batch processing ID
 * @returns SimilarityOutput with ranked matches
 */
export async function findSimilarFingerprints(
  input: SimilarityInput,
  store: SimilarityStore,
  batchId: string,
): Promise<SimilarityOutput> {
  const { query_fingerprint, top_n } = input;
  const effectiveTopN = Math.min(top_n, MAX_SIMILARITY_MATCHES);

  // Determine regime weights for this query
  const regimeWeights = getRegimeWeights(query_fingerprint.regime);

  // Step 1: Pre-filter candidates by asset, timeframe, regime
  const candidates = await store.preFilterCandidates(
    query_fingerprint.asset,
    query_fingerprint.timeframe,
    query_fingerprint.regime,
    query_fingerprint.fingerprint_id,
  );

  if (candidates.length === 0) {
    return {
      matches: [],
      match_count: 0,
      regime_weights_used: regimeWeights,
    };
  }

  // Step 2: HNSW vector search across 5 layers
  const candidateIds = candidates.map((c) => c.fingerprint_id);

  const [
    marketStructureResults,
    volatilityResults,
    liquidityResults,
    macroResults,
    sentimentResults,
  ] = await Promise.all([
    store.vectorSearch(
      "market_structure_vector",
      query_fingerprint.state_layers.market_structure,
      candidateIds,
      effectiveTopN * 2, // Over-fetch to ensure enough candidates after aggregation
      "cosine",
    ),
    store.vectorSearch(
      "volatility_vector",
      query_fingerprint.state_layers.volatility_profile,
      candidateIds,
      effectiveTopN * 2,
      "cosine",
    ),
    store.vectorSearch(
      "liquidity_vector",
      query_fingerprint.state_layers.liquidity_field,
      candidateIds,
      effectiveTopN * 2,
      "cosine",
    ),
    store.vectorSearch(
      "macro_vector",
      query_fingerprint.state_layers.macro_context,
      candidateIds,
      effectiveTopN * 2,
      "l2",
    ),
    store.vectorSearch(
      "sentiment_vector",
      query_fingerprint.state_layers.sentiment_pressure,
      candidateIds,
      effectiveTopN * 2,
      "l2",
    ),
  ]);

  // Step 3: Weighted aggregation
  const layerScoresMap = buildLayerScoresMap(
    marketStructureResults,
    volatilityResults,
    liquidityResults,
    macroResults,
    sentimentResults,
  );

  const scoredMatches = computeWeightedScores(
    layerScoresMap,
    regimeWeights,
    query_fingerprint.fingerprint_id,
    batchId,
  );

  // Sort by score descending, take top N
  scoredMatches.sort((a, b) => b.similarity_score - a.similarity_score);
  const topMatches = scoredMatches.slice(0, effectiveTopN);

  // Assign ranks (1-indexed)
  const rankedMatches = topMatches.map((match, index) => ({
    ...match,
    rank: index + 1,
  }));

  // Store results
  if (rankedMatches.length > 0) {
    await store.storeMatches(rankedMatches);
  }

  return {
    matches: rankedMatches,
    match_count: rankedMatches.length,
    regime_weights_used: regimeWeights,
  };
}

// =============================================================================
// Step 1: Pre-Filter Logic (exported for testability)
// =============================================================================

/**
 * Build the SQL WHERE clause parameters for pre-filtering.
 * This is a pure function that produces the filter criteria.
 *
 * @param fingerprint - The query fingerprint to derive filter criteria from
 * @returns Filter parameters for asset, timeframe, and regime metadata
 */
export function buildPreFilterCriteria(fingerprint: Fingerprint): {
  asset: string;
  timeframe: string;
  volatility_regime: string;
  trend_regime: string;
  session: string;
} {
  return {
    asset: fingerprint.asset,
    timeframe: fingerprint.timeframe,
    volatility_regime: fingerprint.regime.volatility_regime,
    trend_regime: fingerprint.regime.trend_regime,
    session: fingerprint.regime.session,
  };
}

// =============================================================================
// Step 3: Weight Aggregation (exported for testability)
// =============================================================================

/**
 * Get the frozen regime weight matrix for a given regime classification.
 * Pure function — deterministic mapping from regime to weights.
 */
export function getRegimeWeights(
  regime: RegimeClassification,
): RegimeWeightMatrix {
  const key = `${regime.volatility_regime}_${regime.trend_regime}`;
  return REGIME_WEIGHT_MATRICES[key] ?? DEFAULT_WEIGHT_MATRIX;
}

/**
 * Convert a raw distance value to a similarity score in [0, 1].
 *
 * For cosine distance: similarity = 1 - distance (cosine distance is 0..2, but pgvector returns 0..1 for normalised vectors)
 * For L2 distance: similarity = 1 / (1 + distance) — bounded sigmoid-like mapping
 */
export function distanceToSimilarity(
  distance: number,
  metric: "cosine" | "l2",
): number {
  if (metric === "cosine") {
    // Cosine distance from pgvector: 1 - cos(a,b), range [0, 2]
    // Similarity = 1 - distance, clamped to [0, 1]
    return clamp(1 - distance, 0, 1);
  }
  // L2/Euclidean: transform to [0, 1] using inverse mapping
  return 1 / (1 + distance);
}

/**
 * Compute the final weighted similarity score from per-layer scores.
 * Pure function — deterministic linear combination.
 *
 * @param layerScores - Individual similarity scores per layer (0 to 1)
 * @param weights - Frozen regime weight matrix
 * @returns Final similarity score rounded to 6 decimal places
 */
export function computeAggregateScore(
  layerScores: {
    market_structure: number;
    volatility: number;
    liquidity: number;
    macro: number;
    sentiment: number;
  },
  weights: RegimeWeightMatrix,
): number {
  const raw =
    layerScores.market_structure * weights.market_structure +
    layerScores.volatility * weights.volatility +
    layerScores.liquidity * weights.liquidity +
    layerScores.macro * weights.macro +
    layerScores.sentiment * weights.sentiment;

  return roundTo6Decimals(clamp(raw, 0, 1));
}

/**
 * Generate match explanation from layer scores.
 * Classifies each layer as matched or mismatched based on threshold.
 */
export function generateMatchExplanation(
  layerScores: {
    market_structure: number;
    volatility: number;
    liquidity: number;
    macro: number;
    sentiment: number;
  },
  weights: RegimeWeightMatrix,
): {
  matched_layers: string[];
  mismatched_layers: string[];
  primary_match_reason: string;
} {
  const layers: Array<{ name: string; score: number; weight: number }> = [
    { name: "market_structure", score: layerScores.market_structure, weight: weights.market_structure },
    { name: "volatility", score: layerScores.volatility, weight: weights.volatility },
    { name: "liquidity", score: layerScores.liquidity, weight: weights.liquidity },
    { name: "macro", score: layerScores.macro, weight: weights.macro },
    { name: "sentiment", score: layerScores.sentiment, weight: weights.sentiment },
  ];

  const matched_layers: string[] = [];
  const mismatched_layers: string[] = [];

  for (const layer of layers) {
    if (layer.score >= LAYER_MATCH_THRESHOLD) {
      matched_layers.push(layer.name);
    } else {
      mismatched_layers.push(layer.name);
    }
  }

  // Primary match reason: highest weighted contributing layer
  const sortedByContribution = [...layers]
    .filter((l) => l.score >= LAYER_MATCH_THRESHOLD)
    .sort((a, b) => b.score * b.weight - a.score * a.weight);

  let primary_match_reason: string;
  if (sortedByContribution.length > 0) {
    const topLayer = sortedByContribution[0]!;
    primary_match_reason = `strong_${topLayer.name}_alignment`;
  } else {
    primary_match_reason = "weak_overall_match";
  }

  return { matched_layers, mismatched_layers, primary_match_reason };
}

// =============================================================================
// Internal Pipeline Helpers
// =============================================================================

/**
 * Build a map of fingerprint_id → per-layer similarity scores from individual search results.
 */
function buildLayerScoresMap(
  marketStructureResults: VectorSearchResult[],
  volatilityResults: VectorSearchResult[],
  liquidityResults: VectorSearchResult[],
  macroResults: VectorSearchResult[],
  sentimentResults: VectorSearchResult[],
): Map<
  string,
  {
    market_structure: number;
    volatility: number;
    liquidity: number;
    macro: number;
    sentiment: number;
  }
> {
  const map = new Map<
    string,
    {
      market_structure: number;
      volatility: number;
      liquidity: number;
      macro: number;
      sentiment: number;
    }
  >();

  const initEntry = () => ({
    market_structure: 0,
    volatility: 0,
    liquidity: 0,
    macro: 0,
    sentiment: 0,
  });

  // Process L1: Market Structure (cosine)
  for (const result of marketStructureResults) {
    if (!map.has(result.fingerprint_id)) {
      map.set(result.fingerprint_id, initEntry());
    }
    map.get(result.fingerprint_id)!.market_structure = distanceToSimilarity(
      result.distance,
      "cosine",
    );
  }

  // Process L2: Volatility (cosine)
  for (const result of volatilityResults) {
    if (!map.has(result.fingerprint_id)) {
      map.set(result.fingerprint_id, initEntry());
    }
    map.get(result.fingerprint_id)!.volatility = distanceToSimilarity(
      result.distance,
      "cosine",
    );
  }

  // Process L3: Liquidity (cosine)
  for (const result of liquidityResults) {
    if (!map.has(result.fingerprint_id)) {
      map.set(result.fingerprint_id, initEntry());
    }
    map.get(result.fingerprint_id)!.liquidity = distanceToSimilarity(
      result.distance,
      "cosine",
    );
  }

  // Process L4: Macro (L2/euclidean)
  for (const result of macroResults) {
    if (!map.has(result.fingerprint_id)) {
      map.set(result.fingerprint_id, initEntry());
    }
    map.get(result.fingerprint_id)!.macro = distanceToSimilarity(
      result.distance,
      "l2",
    );
  }

  // Process L5: Sentiment (L2/euclidean)
  for (const result of sentimentResults) {
    if (!map.has(result.fingerprint_id)) {
      map.set(result.fingerprint_id, initEntry());
    }
    map.get(result.fingerprint_id)!.sentiment = distanceToSimilarity(
      result.distance,
      "l2",
    );
  }

  return map;
}

/**
 * Compute weighted scores for all candidates and return unsorted matches.
 */
function computeWeightedScores(
  layerScoresMap: Map<
    string,
    {
      market_structure: number;
      volatility: number;
      liquidity: number;
      macro: number;
      sentiment: number;
    }
  >,
  weights: RegimeWeightMatrix,
  queryFingerprintId: string,
  batchId: string,
): SimilarityMatch[] {
  const matches: SimilarityMatch[] = [];

  for (const [fingerprintId, layerScores] of layerScoresMap) {
    // Exclude the query fingerprint itself (Requirement 2.1)
    if (fingerprintId === queryFingerprintId) {
      continue;
    }

    const similarity_score = computeAggregateScore(layerScores, weights);
    const explanation = generateMatchExplanation(layerScores, weights);

    matches.push({
      fingerprint_id: queryFingerprintId,
      match_fingerprint_id: fingerprintId,
      similarity_score,
      rank: 0, // Assigned after sorting
      layer_breakdown: {
        market_structure: roundTo6Decimals(layerScores.market_structure),
        volatility: roundTo6Decimals(layerScores.volatility),
        liquidity: roundTo6Decimals(layerScores.liquidity),
        macro: roundTo6Decimals(layerScores.macro),
        sentiment: roundTo6Decimals(layerScores.sentiment),
      },
      match_explanation: explanation,
      batch_id: batchId,
    });
  }

  return matches;
}

// =============================================================================
// Utility Functions
// =============================================================================

/** Clamp a value between min and max. */
function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

/** Round to exactly 6 decimal places for deterministic output. */
function roundTo6Decimals(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}
