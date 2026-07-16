/**
 * Candle Importer — Batched upsert of validated candle records into raw_candles.
 *
 * Implements fail-forward semantics: batch errors are logged and counted,
 * but processing continues with remaining batches.
 *
 * Requirements: 3.1, 3.2, 3.3, 3.4, 3.5, 3.6, 3.7, 10.2, 11.2
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import {
  type CandleRecord,
  type ImportResult,
  type ImportOptions,
  BATCH_SIZE_CANDLES,
  BOOTSTRAP_BATCH_ID,
  TIMEFRAME,
} from './types.js';

/**
 * Import candle records into the `raw_candles` table using batched upserts
 * with deduplication on (asset, timeframe, timestamp_utc).
 *
 * @param supabase - Supabase client instance
 * @param records - Validated candle records to import
 * @param asset - Asset symbol (will be uppercased)
 * @param options - Optional configuration (batchSize)
 * @returns Aggregate counts of inserted, skipped, and errored records
 */
export async function importCandles(
  supabase: SupabaseClient,
  records: CandleRecord[],
  asset: string,
  options?: ImportOptions
): Promise<ImportResult> {
  const batchSize = options?.batchSize ?? BATCH_SIZE_CANDLES;
  const upperAsset = asset.toUpperCase();

  let inserted = 0;
  let skipped = 0;
  let errors = 0;

  for (let i = 0; i < records.length; i += batchSize) {
    const batch = records.slice(i, i + batchSize);

    const rows = batch.map((record) => ({
      asset: upperAsset,
      timeframe: TIMEFRAME,
      timestamp_utc: record.timestamp_utc,
      open: record.open,
      high: record.high,
      low: record.low,
      close: record.close,
      volume: record.volume,
      batch_id: BOOTSTRAP_BATCH_ID,
    }));

    const { error, count } = await supabase
      .from('raw_candles')
      .upsert(rows, { onConflict: 'asset,timeframe,timestamp_utc', ignoreDuplicates: true, count: 'exact' });

    if (error) {
      console.error(
        `[CandleImporter] Batch ${Math.floor(i / batchSize) + 1} error (rows ${i}–${i + batch.length - 1}): ${error.message}`
      );
      errors += batch.length;
    } else {
      // count reflects actual rows inserted (excludes duplicates)
      const batchInserted = count ?? batch.length;
      const batchSkipped = batch.length - batchInserted;
      inserted += batchInserted;
      skipped += batchSkipped;
    }
  }

  return { inserted, skipped, errors };
}
