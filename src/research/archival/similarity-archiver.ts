/**
 * Similarity Archiver — Phase 3: Similarity Match Persistence
 *
 * Persists similarity match records to the research_similarity_archive table.
 * Unlike the forecast archive writer, this module THROWS on failure to halt
 * downstream pipeline processing — similarity data is critical for explainability.
 *
 * Duplicate key conflicts (fingerprint_id, match_fingerprint_id, batch_id) are
 * logged as warnings and do NOT cause failure.
 *
 * Requirements: 10.1, 10.2, 10.3, 10.4, 10.5, 10.6, 10.7
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import type { SimilarityArchiveRecord, SimilarityArchiver } from './types.js';

/**
 * Creates a SimilarityArchiver backed by a Supabase client.
 *
 * The archiver performs a single batch INSERT of all records into the
 * research_similarity_archive table (up to 50 per query fingerprint).
 *
 * On failure: THROWS to halt downstream pipeline and mark batch as failed.
 * On duplicate key conflict (23505): logs warning, does NOT throw.
 * On empty input: returns successfully without any DB call.
 */
export function createSimilarityArchiver(supabase: SupabaseClient): SimilarityArchiver {
  return {
    async persistMatches(records: SimilarityArchiveRecord[]): Promise<void> {
      if (records.length === 0) {
        return;
      }

      const batchId = records[0].batch_id;

      try {
        const { error } = await supabase.from('research_similarity_archive').insert(
          records.map((record) => ({
            fingerprint_id: record.fingerprint_id,
            match_fingerprint_id: record.match_fingerprint_id,
            similarity_score: record.similarity_score,
            layer_breakdown: record.layer_breakdown,
            match_explanation: record.match_explanation,
            rank: record.rank,
            batch_id: record.batch_id,
            engine_versions: record.engine_versions,
            created_at: record.created_at,
          }))
        );

        if (error) {
          // Duplicate key conflict: log warning, do NOT halt pipeline
          if (error.code === '23505') {
            console.warn(
              `[SimilarityArchiver] Duplicate records rejected — batch_id=${batchId}`
            );
            return;
          }

          // Any other DB error: THROW to halt downstream processing
          throw new Error(
            `[SimilarityArchiver] Failed to persist similarity matches — batch_id=${batchId}: ${error.message}`
          );
        }
      } catch (err) {
        // Re-throw if it's already our error
        if (err instanceof Error && err.message.startsWith('[SimilarityArchiver]')) {
          throw err;
        }

        // Unexpected errors (network, serialisation, etc): THROW to halt pipeline
        throw new Error(
          `[SimilarityArchiver] Unexpected error persisting similarity matches — batch_id=${batchId}: ${err instanceof Error ? err.message : String(err)}`
        );
      }
    },
  };
}
