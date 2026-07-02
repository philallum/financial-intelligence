/**
 * Research Archival Types
 *
 * Defines the SimilarityArchiveRecord interface for permanent similarity match storage.
 * All similarity results are persisted for explainability and audit purposes.
 *
 * Requirements: 10.1, 10.2, 10.4, 10.5
 */

/**
 * A persisted, immutable similarity match record in the research archive.
 * Preserves the complete per-layer breakdown and explanation for every match.
 */
export interface SimilarityArchiveRecord {
  fingerprint_id: string;
  match_fingerprint_id: string;
  similarity_score: number;             // NUMERIC(8,6), range 0.000000 to 1.000000
  layer_breakdown: {
    market_structure: number;
    volatility: number;
    liquidity: number;
    macro: number;
    sentiment: number;
  };
  match_explanation: {
    matched_layers: string[];
    mismatched_layers: string[];
    primary_match_reason: string;
  };
  rank: number;                         // 1-indexed, 1 to 50
  batch_id: string;
  engine_versions: Record<string, string>;
  created_at: string;
}

/**
 * Interface for persisting similarity match results to the research archive.
 */
export interface SimilarityArchiver {
  persistMatches(records: SimilarityArchiveRecord[]): Promise<void>;
}
