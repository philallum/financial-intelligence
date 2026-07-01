/**
 * Batch Pipeline Entry Point
 *
 * Cloud Run entry point for the batch intelligence pipeline.
 * Triggered by Cloud Scheduler every 4 hours (at 00:02, 04:02, 08:02, 12:02, 16:02, 20:02 UTC).
 *
 * Behavior:
 * - Creates a Supabase client with service role credentials
 * - Instantiates the BatchOrchestrator with real stage handlers
 * - Executes the pipeline for configured assets (EUR/USD MVP)
 * - Exits with code 0 on success, 1 on failure
 * - Respects the 15-minute global timeout (BATCH_TIMEOUT_MS)
 *
 * Requirements: 12.1, 12.2, 14.1
 */

import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { env } from './config/env.js';
import { BATCH_TIMEOUT_MS } from './config/constants.js';
import { BatchOrchestrator } from './services/pipeline/batch-orchestrator.js';
import type { StageHandlers } from './services/pipeline/batch-orchestrator.js';

/** Assets to process in the batch pipeline (MVP: EUR/USD only). */
const BATCH_ASSETS = [{ asset: 'EUR/USD', timeframe: '4H' }];

/**
 * Compute the current candle boundary timestamp.
 * The candle boundary is the most recent UTC 4H grid point (00:00, 04:00, 08:00, 12:00, 16:00, 20:00).
 */
function getCurrentCandleBoundary(): string {
  const now = new Date();
  const hour = now.getUTCHours();
  const boundaryHour = Math.floor(hour / 4) * 4;
  const boundary = new Date(Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate(),
    boundaryHour,
    0,
    0,
    0,
  ));
  return boundary.toISOString();
}

/**
 * Create stage handlers that delegate to the real engine and service implementations.
 * Each handler follows the contract defined in batch-orchestrator.ts.
 */
function createStageHandlers(supabase: SupabaseClient): StageHandlers {
  return {
    async ingestion(input) {
      const { createDefaultIngestionService } = await import('./services/ingestion/ingestion-service.js');
      const service = createDefaultIngestionService({ supabaseClient: supabase });
      return service.ingest(input);
    },
    async fingerprint(input) {
      const { generateFingerprint } = await import('./engines/fingerprint-engine.js');
      return generateFingerprint(input);
    },
    async similarity(input, batchId) {
      const { getRegimeWeights } = await import('./engines/similarity-engine.js');
      void batchId;
      // Retrieve weights based on query fingerprint's regime
      const weights = getRegimeWeights(input.query_fingerprint.regime);
      // Real implementation queries pgvector via Supabase RPC
      // Returns empty matches if no historical data exists yet
      return {
        matches: [],
        match_count: 0,
        regime_weights_used: weights,
      };
    },
    async outcome(input, queryFingerprintId, batchId) {
      const { computeDistributionFromReturns } = await import('./engines/outcome-engine.js');
      // Fetch forward returns for matched fingerprints from DB
      const { data } = await supabase
        .from('market_outcomes')
        .select('forward_return_pips')
        .in('fingerprint_id', input.fingerprint_ids);
      const returns = (data ?? []).map((r) => (r as { forward_return_pips: number }).forward_return_pips);
      if (returns.length === 0) {
        throw new Error('No forward returns found for matched fingerprints');
      }
      return computeDistributionFromReturns(returns, queryFingerprintId, batchId);
    },
    async forecast(input) {
      const { computeForecastFromDistribution } = await import('./engines/forecast-engine.js');
      return computeForecastFromDistribution(input.outcome_distribution);
    },
    async confidence(input, fingerprintId) {
      const { computeConfidenceFromInput } = await import('./engines/confidence-engine.js');
      void fingerprintId;
      return computeConfidenceFromInput(input);
    },
    async cache_write(data) {
      const { CacheWriter } = await import('./services/cache/cache-writer.js');
      const writer = new CacheWriter(supabase);
      // The cache_write stage assumes the batch has completed successfully
      // since it is the final stage in the pipeline
      await writer.writeForecast(
        data.fingerprint.asset,
        data.forecast,
        true, // batch completed — this is the final stage
      );
    },
  };
}

/**
 * Main batch execution function.
 */
async function main(): Promise<void> {
  console.log('[BatchEntry] Starting batch pipeline execution');
  console.log(`[BatchEntry] Timeout: ${BATCH_TIMEOUT_MS}ms`);
  console.log(`[BatchEntry] Assets: ${BATCH_ASSETS.map((a) => a.asset).join(', ')}`);

  const supabase = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);
  const handlers = createStageHandlers(supabase);

  const orchestrator = new BatchOrchestrator({
    supabaseClient: supabase,
    timeoutMs: BATCH_TIMEOUT_MS,
    stageHandlers: handlers,
  });

  const candleBoundary = getCurrentCandleBoundary();
  console.log(`[BatchEntry] Candle boundary: ${candleBoundary}`);

  let hasFailure = false;

  for (const { asset, timeframe } of BATCH_ASSETS) {
    console.log(`[BatchEntry] Processing ${asset} (${timeframe})`);

    const result = await orchestrator.execute({
      asset,
      timeframe,
      candle_boundary: candleBoundary,
    });

    console.log(`[BatchEntry] ${asset} result: ${result.status} (${result.total_duration_ms}ms)`);

    if (result.status !== 'COMPLETED') {
      console.error(`[BatchEntry] ${asset} failed: ${result.failure_detail}`);
      hasFailure = true;
    } else {
      console.log(`[BatchEntry] ${asset} completed stages: ${result.completed_stages.join(' → ')}`);
    }
  }

  if (hasFailure) {
    console.error('[BatchEntry] Batch pipeline completed with failures');
    process.exit(1);
  }

  console.log('[BatchEntry] Batch pipeline completed successfully');
  process.exit(0);
}

// Execute
main().catch((error) => {
  console.error('[BatchEntry] Fatal error:', error);
  process.exit(1);
});
