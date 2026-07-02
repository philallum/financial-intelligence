/**
 * Research Archive Writer — Phase 1: Prediction Persistence
 *
 * Persists forecast records to the research_forecasts table as immutable research data.
 * This writer is called after the cache_write stage succeeds and must never halt
 * the batch pipeline — all failures are logged but not propagated.
 *
 * Requirements: 4.1, 9.1, 9.3, 9.4, 3.1, 3.7
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import type { ResearchForecastRecord, ResearchArchiveWriter } from './types.js';

/**
 * Creates a ResearchArchiveWriter backed by a Supabase client.
 *
 * The writer performs a single INSERT per forecast record into the research_forecasts table.
 * It handles duplicate key conflicts (fingerprint_id, batch_id) by logging a warning
 * and swallowing the error. Any other failure is logged with contextual identifiers
 * but never rethrown — the batch pipeline must not be halted by research persistence failures.
 */
export function createResearchArchiveWriter(supabase: SupabaseClient): ResearchArchiveWriter {
  return {
    async persistForecast(record: ResearchForecastRecord): Promise<void> {
      try {
        const { error } = await supabase.from('research_forecasts').insert({
          fingerprint_id: record.fingerprint_id,
          batch_id: record.batch_id,
          asset: record.asset,
          timeframe: record.timeframe,
          forecast_timestamp: record.forecast_timestamp,
          forecast_expiry: record.forecast_expiry,
          direction_probabilities: record.direction_probabilities,
          expected_move_pips: record.expected_move_pips,
          confidence_raw: record.confidence_raw,
          confidence_final: record.confidence_final,
          tradeability_placeholder: record.tradeability_placeholder,
          engine_versions: record.engine_versions,
          quantile_table_version: record.quantile_table_version,
          regime: record.regime,
          sample_size: record.sample_size,
          created_at: record.created_at,
        });

        if (error) {
          // Supabase returns error code '23505' for unique constraint violations (duplicate key)
          if (error.code === '23505') {
            console.warn(
              `[ResearchArchiveWriter] Duplicate forecast rejected — fingerprint_id=${record.fingerprint_id}, batch_id=${record.batch_id}`
            );
            return;
          }

          // Any other failure: log context, do NOT retry, do NOT halt batch
          console.error(
            `[ResearchArchiveWriter] Failed to persist forecast — batch_id=${record.batch_id}, fingerprint_id=${record.fingerprint_id}: ${error.message}`
          );
          return;
        }
      } catch (err) {
        // Unexpected errors (network, serialisation, etc): log and swallow
        console.error(
          `[ResearchArchiveWriter] Unexpected error persisting forecast — batch_id=${record.batch_id}, fingerprint_id=${record.fingerprint_id}:`,
          err instanceof Error ? err.message : String(err)
        );
      }
    },
  };
}
