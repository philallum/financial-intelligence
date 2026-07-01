/**
 * Historical Data Seeding Script
 *
 * Generates fingerprints and outcomes for all historical candles in raw_candles.
 * This is a one-time migration to bootstrap the similarity matching corpus.
 *
 * Steps:
 * 1. Fetch all raw_candles ordered by timestamp
 * 2. Generate a fingerprint for each candle
 * 3. Compute forward 4H outcome (next candle's return) for each fingerprint
 * 4. Batch insert fingerprints and outcomes into the database
 *
 * Usage: npx tsx scripts/seed-historical-data.ts
 */

import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';
import { generateFingerprint } from '../src/engines/fingerprint-engine.js';
import type { Fingerprint, OHLC } from '../src/types/index.js';

const SUPABASE_URL = process.env.SUPABASE_URL!;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const BATCH_SIZE = 200;
const SEED_BATCH_ID = '00000000-0000-0000-0000-000000000002';

interface RawCandle {
  asset: string;
  timeframe: string;
  timestamp_utc: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number | null;
}

async function main() {
  console.log('[Seed] Starting historical data seeding...');
  const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

  // 1. Fetch all candles ordered by time
  console.log('[Seed] Fetching raw candles...');
  let allCandles: RawCandle[] = [];
  let offset = 0;
  const pageSize = 1000;

  while (true) {
    const { data, error } = await supabase
      .from('raw_candles')
      .select('asset, timeframe, timestamp_utc, open, high, low, close, volume')
      .eq('asset', 'EURUSD')
      .eq('timeframe', '4H')
      .order('timestamp_utc', { ascending: true })
      .range(offset, offset + pageSize - 1);

    if (error) {
      console.error('[Seed] Error fetching candles:', error.message);
      process.exit(1);
    }

    if (!data || data.length === 0) break;
    allCandles = allCandles.concat(data as RawCandle[]);
    offset += pageSize;

    if (data.length < pageSize) break;
  }

  console.log(`[Seed] Fetched ${allCandles.length} candles`);

  if (allCandles.length < 2) {
    console.error('[Seed] Need at least 2 candles to compute outcomes');
    process.exit(1);
  }

  // 2. Generate fingerprints for all candles
  console.log('[Seed] Generating fingerprints...');
  const fingerprints: Fingerprint[] = [];

  for (const candle of allCandles) {
    const ohlc: OHLC = {
      open: Number(candle.open),
      high: Number(candle.high),
      low: Number(candle.low),
      close: Number(candle.close),
    };

    const fp = generateFingerprint({
      asset: candle.asset,
      timestamp_utc: candle.timestamp_utc,
      ohlc,
    });

    fingerprints.push(fp);
  }

  console.log(`[Seed] Generated ${fingerprints.length} fingerprints`);

  // 3. Compute forward outcomes (next candle's return relative to this candle's close)
  console.log('[Seed] Computing forward outcomes...');
  interface OutcomeRecord {
    fingerprint_id: string;
    asset: string;
    horizon: string;
    net_return_pips: number;
    max_favourable_excursion: number;
    max_adverse_excursion: number;
    realised_volatility: number;
    timestamp_utc: string;
    batch_id: string;
    engine_version: string;
  }

  const outcomes: OutcomeRecord[] = [];
  const PIP_DIVISOR = 0.0001;

  for (let i = 0; i < allCandles.length - 1; i++) {
    const currentCandle = allCandles[i];
    const nextCandle = allCandles[i + 1];
    const fp = fingerprints[i];

    const currentClose = Number(currentCandle.close);
    const nextOpen = Number(nextCandle.open);
    const nextHigh = Number(nextCandle.high);
    const nextLow = Number(nextCandle.low);
    const nextClose = Number(nextCandle.close);

    // Forward 4H return in pips
    const netReturnPips = Math.round(((nextClose - currentClose) / PIP_DIVISOR) * 100) / 100;

    // Max favourable excursion (best possible profit from close)
    const mfe = Math.round(((nextHigh - currentClose) / PIP_DIVISOR) * 100) / 100;

    // Max adverse excursion (worst drawdown from close)
    const mae = Math.round(((currentClose - nextLow) / PIP_DIVISOR) * 100) / 100;

    // Realised volatility (range of next candle in pips, normalised)
    const realisedVol = Math.round(((nextHigh - nextLow) / PIP_DIVISOR) * 100) / 100;

    outcomes.push({
      fingerprint_id: fp.fingerprint_id,
      asset: currentCandle.asset,
      horizon: '4H',
      net_return_pips: netReturnPips,
      max_favourable_excursion: mfe,
      max_adverse_excursion: mae,
      realised_volatility: realisedVol / 10000, // normalised
      timestamp_utc: nextCandle.timestamp_utc,
      batch_id: SEED_BATCH_ID,
      engine_version: '1.0.0',
    });
  }

  console.log(`[Seed] Computed ${outcomes.length} forward outcomes`);

  // 4. Batch insert fingerprints
  console.log('[Seed] Inserting fingerprints...');
  let fpInserted = 0;
  let fpSkipped = 0;

  for (let i = 0; i < fingerprints.length; i += BATCH_SIZE) {
    const batch = fingerprints.slice(i, i + BATCH_SIZE);

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
      batch_id: SEED_BATCH_ID,
    }));

    const { error, count } = await supabase
      .from('market_fingerprints')
      .upsert(rows, { onConflict: 'asset,timeframe,timestamp_utc', ignoreDuplicates: true });

    if (error) {
      console.error(`[Seed] Error inserting fingerprints batch at ${i}:`, error.message);
      // Continue with next batch instead of failing completely
      fpSkipped += batch.length;
    } else {
      fpInserted += batch.length;
    }

    if ((i + BATCH_SIZE) % 2000 === 0 || i + BATCH_SIZE >= fingerprints.length) {
      console.log(`[Seed]   Progress: ${Math.min(i + BATCH_SIZE, fingerprints.length)}/${fingerprints.length} fingerprints`);
    }
  }

  console.log(`[Seed] Fingerprints: ${fpInserted} inserted, ${fpSkipped} skipped`);

  // 5. Batch insert outcomes
  console.log('[Seed] Inserting outcomes...');
  let outInserted = 0;
  let outSkipped = 0;

  for (let i = 0; i < outcomes.length; i += BATCH_SIZE) {
    const batch = outcomes.slice(i, i + BATCH_SIZE);

    const { error } = await supabase
      .from('market_outcomes')
      .upsert(batch, { onConflict: 'fingerprint_id,horizon', ignoreDuplicates: true });

    if (error) {
      console.error(`[Seed] Error inserting outcomes batch at ${i}:`, error.message);
      outSkipped += batch.length;
    } else {
      outInserted += batch.length;
    }

    if ((i + BATCH_SIZE) % 2000 === 0 || i + BATCH_SIZE >= outcomes.length) {
      console.log(`[Seed]   Progress: ${Math.min(i + BATCH_SIZE, outcomes.length)}/${outcomes.length} outcomes`);
    }
  }

  console.log(`[Seed] Outcomes: ${outInserted} inserted, ${outSkipped} skipped`);

  // 6. Summary
  console.log('\n[Seed] === SEEDING COMPLETE ===');
  console.log(`[Seed] Candles processed: ${allCandles.length}`);
  console.log(`[Seed] Fingerprints stored: ${fpInserted}`);
  console.log(`[Seed] Outcomes stored: ${outInserted}`);
  console.log(`[Seed] Date range: ${allCandles[0].timestamp_utc} → ${allCandles[allCandles.length - 1].timestamp_utc}`);

  process.exit(0);
}

main().catch((err) => {
  console.error('[Seed] Fatal error:', err);
  process.exit(1);
});
