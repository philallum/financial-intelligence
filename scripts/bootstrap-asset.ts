/**
 * Historical Data Bootstrap CLI
 *
 * Orchestrates the full bootstrap pipeline for onboarding new currency pairs:
 * parse CSV → validate → import candles → generate fingerprints → compute outcomes → backfill topology
 *
 * Usage: npx tsx scripts/bootstrap-asset.ts --asset GBPUSD --csv path/to/file.csv
 *
 * Requirements: 7.1, 7.2, 7.3, 7.4, 8.1, 8.2, 8.3, 8.4, 8.5, 8.6, 8.7, 9.1, 9.2, 9.3, 9.4, 10.1, 11.1, 11.4
 */

import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';
import { parseDukascopyCSV } from '../src/bootstrap/csv-parser.js';
import { validateCandles } from '../src/bootstrap/data-validator.js';
import { importCandles } from '../src/bootstrap/candle-importer.js';
import { generateAndStoreFingerprints } from '../src/bootstrap/fingerprint-generator.js';
import { computeOutcomes, storeOutcomes } from '../src/bootstrap/outcome-computer.js';
import { backfillTopology } from '../src/bootstrap/topology-backfiller.js';
import { getAssetBySymbol, AssetStatus } from '../src/config/research-assets.js';
import { parseArgs, printSummary } from '../src/bootstrap/cli-helpers.js';
import type { PipelineSummary } from '../src/bootstrap/types.js';

// ─── Main Pipeline ──────────────────────────────────────────────────────────────

async function main() {
  const SUPABASE_URL = process.env.SUPABASE_URL!;
  const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;
  const startTime = Date.now();

  // Step 1: Parse CLI arguments
  const args = parseArgs(process.argv.slice(2));
  console.log(`[Bootstrap] Starting bootstrap for asset: ${args.asset}`);
  console.log(`[Bootstrap] CSV file: ${args.csv}`);

  // Step 2: Validate asset in registry
  const assetConfig = getAssetBySymbol(args.asset);

  if (!assetConfig) {
    console.error(
      `[Bootstrap] ERROR: Asset "${args.asset}" not found in RESEARCH_ASSETS registry.`
    );
    console.error(
      `[Bootstrap] Please add the asset to src/config/research-assets.ts before running the bootstrap.`
    );
    process.exit(1);
  }

  if (assetConfig.status === AssetStatus.DISABLED) {
    console.error(
      `[Bootstrap] ERROR: Asset "${args.asset}" has status DISABLED. Cannot bootstrap a disabled asset.`
    );
    process.exit(1);
  }

  if (assetConfig.status === AssetStatus.DEPRECATED) {
    console.error(
      `[Bootstrap] ERROR: Asset "${args.asset}" has status DEPRECATED. Cannot bootstrap a deprecated asset.`
    );
    process.exit(1);
  }

  console.log(`[Bootstrap] Asset validated: ${assetConfig.symbol} (${assetConfig.status}), pipSize=${assetConfig.pipSize}`);

  // Step 3: Create Supabase client
  const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

  // Step 4: Parse CSV
  console.log('[Bootstrap] Parsing CSV file...');
  const records = parseDukascopyCSV(args.csv);
  console.log(`[Bootstrap] Parsed ${records.length} candle records`);

  // Step 5: Validate candles
  console.log('[Bootstrap] Validating candle data...');
  const validation = validateCandles(records, args.asset);

  if (!validation.valid) {
    console.error(`[Bootstrap] ERROR: Validation failed with ${validation.ohlcViolations.length} OHLC violation(s):`);
    for (const v of validation.ohlcViolations.slice(0, 10)) {
      console.error(`  Row ${v.rowNumber} (${v.timestamp}): ${v.constraint}`);
    }
    process.exit(1);
  }

  if (validation.gaps.length > 0) {
    console.warn(`[Bootstrap] WARNING: ${validation.gaps.length} gap(s) detected in trading schedule.`);
    for (const gap of validation.gaps.slice(0, 5)) {
      console.warn(`  Missing: ${gap.expectedTimestamp} (after ${gap.previousTimestamp})`);
    }
    console.warn('[Bootstrap] Proceeding with import despite gaps (common in historical FX data).');
  }

  console.log(
    `[Bootstrap] Validation passed: ${validation.totalCandles} candles, ${validation.expectedCandles} expected, ${validation.gaps.length} gap(s)`
  );

  // Step 6: Import candles
  console.log('[Bootstrap] Importing candles into raw_candles...');
  const importResult = await importCandles(supabase, records, args.asset);
  console.log(
    `[Bootstrap] Import complete: ${importResult.inserted} inserted, ${importResult.skipped} skipped, ${importResult.errors} errors`
  );

  // Step 7: Generate fingerprints
  console.log('[Bootstrap] Generating fingerprints...');
  const fpResult = await generateAndStoreFingerprints(supabase, records, args.asset);
  console.log(
    `[Bootstrap] Fingerprints complete: ${fpResult.generated} generated, ${fpResult.stored} stored, ${fpResult.errors} errors`
  );

  // Step 8: Compute and store outcomes
  console.log('[Bootstrap] Computing outcomes...');
  const outcomes = computeOutcomes(records, fpResult.fingerprintIds, args.asset, assetConfig.pipSize);
  console.log(`[Bootstrap] Computed ${outcomes.length} outcomes, storing...`);

  const outcomeResult = await storeOutcomes(supabase, outcomes);
  console.log(
    `[Bootstrap] Outcomes complete: ${outcomeResult.stored} stored, ${outcomeResult.errors} errors`
  );

  // Step 9: Backfill topology
  console.log('[Bootstrap] Backfilling topology vectors...');
  const topoResult = await backfillTopology(supabase, records, fpResult.fingerprintIds, args.asset);
  console.log(
    `[Bootstrap] Topology complete: ${topoResult.computed} computed, ${topoResult.stored} stored, ${topoResult.skipped} skipped, ${topoResult.errors} errors`
  );

  // Step 10: Print summary
  const elapsedMs = Date.now() - startTime;

  // Determine date range from records
  const sortedByTime = [...records].sort(
    (a, b) => new Date(a.timestamp_utc).getTime() - new Date(b.timestamp_utc).getTime()
  );

  const summary: PipelineSummary = {
    asset: args.asset,
    csvPath: args.csv,
    totalCandlesParsed: records.length,
    candlesImported: importResult.inserted,
    candlesSkipped: importResult.skipped,
    fingerprintsGenerated: fpResult.generated,
    outcomesComputed: outcomeResult.computed,
    topologyVectorsCreated: topoResult.stored,
    topologyVectorsSkipped: topoResult.skipped,
    gapsDetected: validation.gaps.length,
    dateRange: {
      start: sortedByTime[0]?.timestamp_utc ?? 'N/A',
      end: sortedByTime[sortedByTime.length - 1]?.timestamp_utc ?? 'N/A',
    },
    elapsedMs,
  };

  printSummary(summary);

  process.exit(0);
}

// Only execute main when run directly (not when imported for testing)
const isDirectExecution = process.argv[1]?.endsWith('bootstrap-asset.ts');
if (isDirectExecution) {
  main().catch((err) => {
    console.error('[Bootstrap] Fatal error:', err);
    process.exit(1);
  });
}
