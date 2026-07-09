/**
 * Fingerprint Generator — Generates and stores market fingerprints for bootstrap candles.
 *
 * Processes candles in chronological order, generates fingerprints using the
 * existing fingerprint engine, and batch-upserts into market_fingerprints
 * with fail-forward semantics.
 *
 * Requirements: 4.1, 4.2, 4.3, 4.4, 4.5, 4.6, 10.3, 11.3
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { generateFingerprint } from '../engines/fingerprint-engine.js';
import type { OHLC, Fingerprint } from '../types/index.js';
import {
  type CandleRecord,
  type FingerprintResult,
  BATCH_SIZE_FINGERPRINTS,
  TIMEFRAME,
  BOOTSTRAP_BATCH_ID,
} from './types.js';

/**
 * Generate and store fingerprints for all candles.
 *
 * Processes candles in chronological order (ascending timestamp_utc),
 * generates fingerprints one-by-one using the deterministic fingerprint engine,
 * then batch-upserts into market_fingerprints with deduplication.
 *
 * @param supabase - Supabase client instance
 * @param candles - Candle records to generate fingerprints for
 * @param asset - Asset symbol (e.g. "EURUSD")
 * @param batchSize - Number of fingerprints per upsert batch (default 200)
 * @returns Aggregate counts and the list of generated fingerprint IDs
 */
export async function generateAndStoreFingerprints(
  supabase: SupabaseClient,
  candles: CandleRecord[],
  asset: string,
  batchSize: number = BATCH_SIZE_FINGERPRINTS
): Promise<FingerprintResult & { fingerprintIds: string[] }> {
  // Sort candles by timestamp ascending for chronological processing
  const sorted = [...candles].sort(
    (a, b) => new Date(a.timestamp_utc).getTime() - new Date(b.timestamp_utc).getTime()
  );

  let generated = 0;
  let stored = 0;
  let errors = 0;
  const fingerprintIds: string[] = [];
  const fingerprints: Fingerprint[] = [];

  // Generate fingerprints one at a time
  for (const candle of sorted) {
    const ohlc: OHLC = {
      open: Number(candle.open),
      high: Number(candle.high),
      low: Number(candle.low),
      close: Number(candle.close),
    };

    const fp = generateFingerprint({
      asset,
      timestamp_utc: candle.timestamp_utc,
      ohlc,
    });

    fingerprints.push(fp);
    fingerprintIds.push(fp.fingerprint_id);
    generated++;

    // Log progress every 1000 fingerprints
    if (generated % 1000 === 0) {
      console.log(`[FingerprintGenerator] Progress: ${generated}/${sorted.length} fingerprints generated`);
    }
  }

  console.log(`[FingerprintGenerator] Generated ${generated} fingerprints, starting batch upsert...`);

  // Batch-upsert fingerprints into market_fingerprints
  for (let i = 0; i < fingerprints.length; i += batchSize) {
    const batch = fingerprints.slice(i, i + batchSize);

    const rows = batch.map((fp) => ({
      fingerprint_id: fp.fingerprint_id,
      asset: fp.asset,
      timeframe: fp.timeframe,
      timestamp_utc: fp.timestamp_utc,
      market_state_version: fp.market_state_version,
      ohlc: fp.ohlc,
      return_profile: fp.return_profile,
      regime: fp.regime,
      market_structure_vector: JSON.stringify(fp.state_layers.market_structure),
      volatility_vector: JSON.stringify(fp.state_layers.volatility_profile),
      liquidity_vector: JSON.stringify(fp.state_layers.liquidity_field),
      macro_vector: JSON.stringify(fp.state_layers.macro_context),
      sentiment_vector: JSON.stringify(fp.state_layers.sentiment_pressure),
      extended_state: {},
      quantile_table_version: fp.normalisation.quantile_table_version,
      scaling_method: fp.normalisation.scaling_method,
      session: fp.regime.session,
      batch_id: BOOTSTRAP_BATCH_ID,
    }));

    const { error } = await supabase
      .from('market_fingerprints')
      .upsert(rows, { onConflict: 'asset,timeframe,timestamp_utc', ignoreDuplicates: true });

    if (error) {
      console.error(
        `[FingerprintGenerator] Batch ${Math.floor(i / batchSize) + 1} error (rows ${i}–${i + batch.length - 1}): ${error.message}`
      );
      errors += batch.length;
    } else {
      stored += batch.length;
    }
  }

  console.log(
    `[FingerprintGenerator] Complete: ${generated} generated, ${stored} stored, ${errors} errors`
  );

  return { generated, stored, errors, fingerprintIds };
}
