/**
 * Outcome Computer — src/bootstrap/outcome-computer.ts
 *
 * Computes forward 4H outcomes for consecutive candle pairs and stores
 * them in the market_outcomes table with batched upsert and deduplication.
 *
 * Requirements: 5.1, 5.2, 5.3, 5.4, 5.5, 5.6, 5.7
 */

import type { CandleRecord, OutcomeRecord, OutcomeResult } from './types.js';
import { BATCH_SIZE_OUTCOMES, BOOTSTRAP_BATCH_ID, TIMEFRAME } from './types.js';

/**
 * Compute forward 4H outcomes for consecutive candle pairs.
 *
 * For each index i from 0 to N-2, computes the outcome using candles[i]
 * (current) and candles[i+1] (next). Uses fingerprintIds[i] as the
 * fingerprint_id for each outcome.
 *
 * @param candles - Array of candle records in chronological order
 * @param fingerprintIds - Array of fingerprint IDs corresponding to each candle
 * @param asset - The asset symbol (e.g. "GBPUSD")
 * @param pipSize - The pip size for the asset (e.g. 0.0001 for most pairs)
 * @returns Array of OutcomeRecord[] with N-1 entries
 */
export function computeOutcomes(
  candles: CandleRecord[],
  fingerprintIds: string[],
  asset: string,
  pipSize: number
): OutcomeRecord[] {
  const outcomes: OutcomeRecord[] = [];

  for (let i = 0; i < candles.length - 1; i++) {
    const current = candles[i];
    const next = candles[i + 1];

    const currentClose = current.close;
    const nextClose = next.close;
    const nextHigh = next.high;
    const nextLow = next.low;

    // Requirement 5.2: net_return_pips = (next_close - current_close) / pipSize
    const net_return_pips = (nextClose - currentClose) / pipSize;

    // Requirement 5.3: max_favourable_excursion = (next_high - current_close) / pipSize
    const max_favourable_excursion = (nextHigh - currentClose) / pipSize;

    // Requirement 5.4: max_adverse_excursion = (current_close - next_low) / pipSize
    const max_adverse_excursion = (currentClose - nextLow) / pipSize;

    // Requirement 5.5: realised_volatility = ((next_high - next_low) / pipSize) / 10000
    const realised_volatility = ((nextHigh - nextLow) / pipSize) / 10000;

    outcomes.push({
      fingerprint_id: fingerprintIds[i],
      asset,
      horizon: TIMEFRAME,
      net_return_pips,
      max_favourable_excursion,
      max_adverse_excursion,
      realised_volatility,
      timestamp_utc: current.timestamp_utc,
      batch_id: BOOTSTRAP_BATCH_ID,
      engine_version: '1.0.0',
    });
  }

  return outcomes;
}

/**
 * Batch-insert outcomes into market_outcomes with deduplication.
 *
 * Uses upsert with onConflict: 'fingerprint_id,horizon' and ignoreDuplicates: true
 * to ensure idempotent execution. Processes in configurable batch sizes and
 * continues on individual batch errors (fail-forward).
 *
 * @param supabase - Supabase client instance
 * @param outcomes - Array of outcome records to store
 * @param batchSize - Number of records per batch insert (default: BATCH_SIZE_OUTCOMES)
 * @returns OutcomeResult with computed/stored/error counts
 */
export async function storeOutcomes(
  supabase: any,
  outcomes: OutcomeRecord[],
  batchSize: number = BATCH_SIZE_OUTCOMES
): Promise<OutcomeResult> {
  const result: OutcomeResult = {
    computed: outcomes.length,
    stored: 0,
    errors: 0,
  };

  for (let i = 0; i < outcomes.length; i += batchSize) {
    const batch = outcomes.slice(i, i + batchSize);

    const { error } = await supabase
      .from('market_outcomes')
      .upsert(batch, { onConflict: 'fingerprint_id,horizon', ignoreDuplicates: true });

    if (error) {
      console.error(
        `[Bootstrap] ERROR: Outcome batch insert failed at offset ${i}: ${error.message}`
      );
      result.errors += batch.length;
    } else {
      result.stored += batch.length;
    }
  }

  return result;
}
