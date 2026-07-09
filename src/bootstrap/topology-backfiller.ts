/**
 * Topology Backfiller — src/bootstrap/topology-backfiller.ts
 *
 * Computes and stores topology vectors for each fingerprint using the
 * topology engine. Requires at least 30 preceding candles; uses up to 120.
 *
 * Requirements: 6.1, 6.2, 6.3, 6.4, 6.5, 10.5
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { computeTopology } from '../engines/topology-engine.js';
import type { TopologyOutput } from '../engines/topology-engine.js';
import type { OHLC } from '../types/index.js';
import type { CandleRecord, TopologyResult } from './types.js';
import {
  BATCH_SIZE_TOPOLOGY,
  MIN_TOPOLOGY_CANDLES,
  MAX_TOPOLOGY_CANDLES,
} from './types.js';

/**
 * Compute and store topology vectors for each fingerprint.
 *
 * For each candle at index i:
 * - If i < 30: skip (insufficient preceding history)
 * - If i >= 30: provide up to 120 preceding candles as context to computeTopology
 *
 * Results are batch-upserted into fingerprint_topology with deduplication
 * on (fingerprint_id). Processing continues on batch errors (fail-forward).
 *
 * @param supabase - Supabase client instance
 * @param candles - Array of candle records in chronological order
 * @param fingerprintIds - Array of fingerprint IDs corresponding to each candle
 * @param asset - The asset symbol (e.g. "GBPUSD")
 * @param batchSize - Number of records per batch insert (default: BATCH_SIZE_TOPOLOGY)
 * @returns TopologyResult with computed/stored/skipped/error counts
 */
export async function backfillTopology(
  supabase: SupabaseClient,
  candles: CandleRecord[],
  fingerprintIds: string[],
  asset: string,
  batchSize: number = BATCH_SIZE_TOPOLOGY
): Promise<TopologyResult> {
  const result: TopologyResult = {
    computed: 0,
    stored: 0,
    skipped: 0,
    errors: 0,
  };

  const topologyOutputs: TopologyOutput[] = [];

  for (let i = 0; i < candles.length; i++) {
    // Requirement 6.2: Skip fingerprints with fewer than 30 preceding candles
    if (i < MIN_TOPOLOGY_CANDLES) {
      result.skipped++;
      continue;
    }

    // Requirement 6.3: Provide up to 120 preceding candles as context
    const startIdx = Math.max(0, i - MAX_TOPOLOGY_CANDLES);
    const precedingCandles = candles.slice(startIdx, i);

    // Convert CandleRecords to OHLC objects
    const precedingOHLC: OHLC[] = precedingCandles.map((c) => ({
      open: c.open,
      high: c.high,
      low: c.low,
      close: c.close,
    }));

    try {
      const output = computeTopology({
        fingerprint_id: fingerprintIds[i],
        asset,
        candles: precedingOHLC,
      });

      topologyOutputs.push(output);
      result.computed++;

      // Log progress every 100 topology vectors computed
      if (result.computed % 100 === 0) {
        console.log(
          `[Bootstrap] Topology progress: ${result.computed} vectors computed, ${result.skipped} skipped`
        );
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(
        `[Bootstrap] ERROR: Topology computation failed for fingerprint ${fingerprintIds[i]}: ${message}`
      );
      result.errors++;
    }
  }

  // Batch-upsert results into fingerprint_topology
  for (let i = 0; i < topologyOutputs.length; i += batchSize) {
    const batch = topologyOutputs.slice(i, i + batchSize);

    const rows = batch.map((output) => ({
      fingerprint_id: output.fingerprint_id,
      asset: output.asset,
      levels: output.levels,
      topology_vector: output.topology_vector,
      insufficient_history: output.insufficient_history,
      candle_count_used: output.candle_count_used,
      engine_version: output.engine_version,
    }));

    const { error } = await supabase
      .from('fingerprint_topology')
      .upsert(rows, { onConflict: 'fingerprint_id', ignoreDuplicates: true });

    if (error) {
      console.error(
        `[Bootstrap] ERROR: Topology batch insert failed at offset ${i}: ${error.message}`
      );
      result.errors += batch.length;
    } else {
      result.stored += batch.length;
    }
  }

  return result;
}
