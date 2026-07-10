/**
 * Backfill Outcomes for Live Pipeline Fingerprints
 *
 * One-time script that computes and inserts market_outcomes for any fingerprint
 * that doesn't already have one. Uses consecutive candles from raw_candles to
 * compute the forward 4H return.
 *
 * Safe to re-run (idempotent via upsert with ignoreDuplicates).
 *
 * Usage: npx tsx scripts/backfill-live-outcomes.ts
 */

import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';
import { getProcessableAssets } from '../src/config/research-assets.js';

const SUPABASE_URL = process.env.SUPABASE_URL!;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;

async function main() {
  const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);
  const assets = getProcessableAssets();

  console.log('[BackfillOutcomes] Starting outcome backfill for live fingerprints...');

  for (const asset of assets) {
    console.log(`\n[BackfillOutcomes] Processing ${asset.symbol}...`);

    // 1. Fetch all candles in chronological order
    const allCandles: Array<{ timestamp_utc: string; close: number; high: number; low: number }> = [];
    let offset = 0;
    const pageSize = 1000;

    while (true) {
      const { data, error } = await supabase
        .from('raw_candles')
        .select('timestamp_utc, close, high, low')
        .eq('asset', asset.symbol)
        .eq('timeframe', '4H')
        .order('timestamp_utc', { ascending: true })
        .range(offset, offset + pageSize - 1);

      if (error) {
        console.error(`[BackfillOutcomes] Error fetching candles: ${error.message}`);
        break;
      }
      if (!data || data.length === 0) break;
      allCandles.push(...data);
      offset += pageSize;
      if (data.length < pageSize) break;
    }

    console.log(`[BackfillOutcomes] Fetched ${allCandles.length} candles for ${asset.symbol}`);

    if (allCandles.length < 2) {
      console.log('[BackfillOutcomes] Not enough candles to compute outcomes, skipping.');
      continue;
    }

    // 2. Fetch all fingerprints for this asset
    const allFingerprints: Array<{ fingerprint_id: string; timestamp_utc: string }> = [];
    offset = 0;

    while (true) {
      const { data, error } = await supabase
        .from('market_fingerprints')
        .select('fingerprint_id, timestamp_utc')
        .eq('asset', asset.symbol)
        .eq('timeframe', '4H')
        .order('timestamp_utc', { ascending: true })
        .range(offset, offset + pageSize - 1);

      if (error) {
        console.error(`[BackfillOutcomes] Error fetching fingerprints: ${error.message}`);
        break;
      }
      if (!data || data.length === 0) break;
      allFingerprints.push(...data);
      offset += pageSize;
      if (data.length < pageSize) break;
    }

    console.log(`[BackfillOutcomes] Fetched ${allFingerprints.length} fingerprints for ${asset.symbol}`);

    // 3. Fetch existing outcomes to skip already-computed ones
    const existingFpIds = new Set<string>();
    offset = 0;

    while (true) {
      const { data, error } = await supabase
        .from('market_outcomes')
        .select('fingerprint_id')
        .eq('asset', asset.symbol)
        .eq('horizon', '4H')
        .range(offset, offset + pageSize - 1);

      if (error) {
        console.error(`[BackfillOutcomes] Error fetching existing outcomes: ${error.message}`);
        break;
      }
      if (!data || data.length === 0) break;
      for (const row of data) existingFpIds.add(row.fingerprint_id);
      offset += pageSize;
      if (data.length < pageSize) break;
    }

    console.log(`[BackfillOutcomes] ${existingFpIds.size} fingerprints already have outcomes`);

    // 4. Build candle lookup: timestamp → index
    const candleByTimestamp = new Map<string, number>();
    for (let i = 0; i < allCandles.length; i++) {
      candleByTimestamp.set(new Date(allCandles[i].timestamp_utc).toISOString(), i);
    }

    // 5. Compute missing outcomes
    const outcomesToInsert: Array<Record<string, unknown>> = [];
    let skipped = 0;

    for (const fp of allFingerprints) {
      if (existingFpIds.has(fp.fingerprint_id)) {
        skipped++;
        continue;
      }

      const fpTimestamp = new Date(fp.timestamp_utc).toISOString();
      const candleIdx = candleByTimestamp.get(fpTimestamp);

      if (candleIdx === undefined || candleIdx >= allCandles.length - 1) {
        // No next candle available yet — can't compute outcome
        continue;
      }

      const currentCandle = allCandles[candleIdx];
      const nextCandle = allCandles[candleIdx + 1];

      const prevClose = currentCandle.close;
      const currClose = nextCandle.close;
      const currHigh = nextCandle.high;
      const currLow = nextCandle.low;

      const pipSize = asset.pipSize;
      const netReturnPips = (currClose - prevClose) / pipSize;
      const maxFavourableExcursion = (currHigh - prevClose) / pipSize;
      const maxAdverseExcursion = (prevClose - currLow) / pipSize;
      const realisedVolatility = ((currHigh - currLow) / pipSize) / 10000;

      outcomesToInsert.push({
        fingerprint_id: fp.fingerprint_id,
        asset: asset.symbol,
        horizon: '4H',
        net_return_pips: Math.round(netReturnPips * 100) / 100,
        max_favourable_excursion: Math.round(maxFavourableExcursion * 100) / 100,
        max_adverse_excursion: Math.round(maxAdverseExcursion * 100) / 100,
        realised_volatility: Math.round(realisedVolatility * 10000) / 10000,
        timestamp_utc: nextCandle.timestamp_utc,
        engine_version: '1.0.0',
      });
    }

    console.log(`[BackfillOutcomes] ${skipped} already have outcomes, ${outcomesToInsert.length} to insert`);

    // 6. Batch insert
    const BATCH_SIZE = 200;
    let inserted = 0;
    let errors = 0;

    for (let i = 0; i < outcomesToInsert.length; i += BATCH_SIZE) {
      const batch = outcomesToInsert.slice(i, i + BATCH_SIZE);

      const { error } = await supabase
        .from('market_outcomes')
        .upsert(batch, { onConflict: 'fingerprint_id,horizon', ignoreDuplicates: true });

      if (error) {
        console.error(`[BackfillOutcomes] Batch insert error at offset ${i}: ${error.message}`);
        errors += batch.length;
      } else {
        inserted += batch.length;
      }
    }

    console.log(`[BackfillOutcomes] ${asset.symbol}: ${inserted} outcomes inserted, ${errors} errors`);
  }

  console.log('\n[BackfillOutcomes] Done.');
  process.exit(0);
}

main().catch((err) => {
  console.error('[BackfillOutcomes] Fatal error:', err);
  process.exit(1);
});
