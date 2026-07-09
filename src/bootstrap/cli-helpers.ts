/**
 * CLI Helpers for the Bootstrap Pipeline
 *
 * Extracted into src/ so they can be imported by both the CLI entrypoint
 * (scripts/bootstrap-asset.ts) and unit tests without violating rootDir.
 *
 * Requirements: 7.1, 7.2, 7.3, 7.4, 8.1, 8.2, 8.3, 9.1, 9.2, 9.3, 9.4
 */

import type { PipelineSummary } from './types.js';

// ─── CLI Argument Parsing ───────────────────────────────────────────────────────

export interface CliArgs {
  asset: string;
  csv: string;
}

/**
 * Parse CLI arguments from argv.
 * Expects `--asset <SYMBOL>` and `--csv <path>`.
 *
 * @param argv - Array of CLI arguments (typically process.argv.slice(2))
 * @returns Parsed CliArgs object
 * @throws Calls process.exit(1) if required arguments are missing
 */
export function parseArgs(argv: string[]): CliArgs {
  let asset: string | undefined;
  let csv: string | undefined;

  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--asset' && i + 1 < argv.length) {
      asset = argv[i + 1];
      i++;
    } else if (argv[i] === '--csv' && i + 1 < argv.length) {
      csv = argv[i + 1];
      i++;
    }
  }

  if (!asset || !csv) {
    const missing: string[] = [];
    if (!asset) missing.push('--asset');
    if (!csv) missing.push('--csv');

    console.error(`[Bootstrap] ERROR: Missing required argument(s): ${missing.join(', ')}`);
    console.error('');
    console.error('Usage: npx tsx scripts/bootstrap-asset.ts --asset <SYMBOL> --csv <path>');
    console.error('');
    console.error('  --asset   Uppercase asset symbol (e.g., GBPUSD)');
    console.error('  --csv     Path to Dukascopy CSV file');
    process.exit(1);
  }

  return { asset, csv };
}

// ─── Summary Reporter ───────────────────────────────────────────────────────────

/**
 * Print a formatted summary report of the bootstrap pipeline results.
 *
 * @param summary - Aggregated pipeline statistics
 */
export function printSummary(summary: PipelineSummary): void {
  const elapsed = (summary.elapsedMs / 1000).toFixed(2);

  console.log('');
  console.log('═══════════════════════════════════════════════════════');
  console.log('  BOOTSTRAP PIPELINE COMPLETE');
  console.log('═══════════════════════════════════════════════════════');
  console.log(`  Asset:                 ${summary.asset}`);
  console.log(`  CSV Path:              ${summary.csvPath}`);
  console.log('───────────────────────────────────────────────────────');
  console.log(`  Candles Parsed:        ${summary.totalCandlesParsed}`);
  console.log(`  Candles Imported:      ${summary.candlesImported} (new)`);
  console.log(`  Candles Skipped:       ${summary.candlesSkipped} (duplicates)`);
  console.log(`  Fingerprints Generated:${summary.fingerprintsGenerated}`);
  console.log(`  Outcomes Computed:     ${summary.outcomesComputed}`);
  console.log(`  Topology Created:      ${summary.topologyVectorsCreated}`);
  console.log(`  Topology Skipped:      ${summary.topologyVectorsSkipped}`);
  console.log(`  Gaps Detected:         ${summary.gapsDetected}`);
  console.log('───────────────────────────────────────────────────────');
  console.log(`  Date Range:            ${summary.dateRange.start} → ${summary.dateRange.end}`);
  console.log(`  Elapsed Time:          ${elapsed}s`);
  console.log('═══════════════════════════════════════════════════════');
  console.log('');
}
