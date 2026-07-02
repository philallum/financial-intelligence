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
import { createResearchArchiveWriter, createEvaluationEngine, createSimilarityArchiver } from './research/index.js';
import type { ResearchForecastRecord, SimilarityArchiveRecord } from './research/index.js';
import { traceEngineExecution } from './services/observability/trace-emitter.js';
import { computeTopology } from './engines/topology-engine.js';
import { classifyRegimeV2 } from './engines/regime-engine-v2.js';
import type { OHLC } from './types/index.js';

/** Assets to process in the batch pipeline (MVP: EUR/USD only). */
const BATCH_ASSETS = [{ asset: 'EURUSD', timeframe: '4H' }];

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
  const similarityArchiver = createSimilarityArchiver(supabase);

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
    async topology(fingerprintId, asset) {
      // Fetch up to 120 most recent 4H candles for the asset, ordered chronologically (ASC)
      const { data: candleRows, error: candleError } = await supabase
        .from('raw_candles')
        .select('open, high, low, close')
        .eq('asset', asset)
        .order('timestamp_utc', { ascending: true })
        .limit(120);

      if (candleError) {
        console.error(`[BatchEntry] Topology: failed to fetch candles for ${asset}: ${candleError.message}`);
        return;
      }

      const candles: OHLC[] = (candleRows ?? []).map((r) => ({
        open: r.open as number,
        high: r.high as number,
        low: r.low as number,
        close: r.close as number,
      }));

      // Compute topology
      const topoOutput = computeTopology({
        fingerprint_id: fingerprintId,
        asset,
        candles,
      });

      // Format topology_vector as pgvector string
      const vectorStr = '[' + topoOutput.topology_vector.join(',') + ']';

      // Persist to fingerprint_topology table
      const { error: insertError } = await supabase
        .from('fingerprint_topology')
        .insert({
          fingerprint_id: topoOutput.fingerprint_id,
          asset: topoOutput.asset,
          levels: topoOutput.levels,
          topology_vector: vectorStr,
          insufficient_history: topoOutput.insufficient_history,
          candle_count_used: topoOutput.candle_count_used,
          engine_version: topoOutput.engine_version,
        });

      if (insertError) {
        // On duplicate key (fingerprint_id, asset) → log warning, continue
        if (insertError.code === '23505') {
          console.warn(`[BatchEntry] Topology: duplicate record for fingerprint=${fingerprintId}, asset=${asset} — skipping`);
        } else {
          console.error(`[BatchEntry] Topology: insert failed for ${asset}: ${insertError.message}`);
        }
      }
    },
    async regime_v2(fingerprint) {
      // Classify using Regime Engine v2 (deterministic, uses state_layers + extended_state)
      const regimeV2Output = classifyRegimeV2({
        state_layers: fingerprint.state_layers,
        extended_state: fingerprint.extended_state,
      });

      // Persist regime v2 classification to market_fingerprints.extended_state JSONB field
      // under the key 'regime_v2_classification'. This is additive — does not modify
      // existing RegimeClassification fields (volatility_regime, trend_regime, session).
      const { error: updateError } = await supabase
        .from('market_fingerprints')
        .update({
          extended_state: {
            ...(fingerprint.extended_state ?? {}),
            regime_v2_classification: regimeV2Output,
          },
        })
        .eq('fingerprint_id', fingerprint.fingerprint_id);

      if (updateError) {
        console.error(
          `[BatchEntry] Regime v2: failed to persist classification for fingerprint=${fingerprint.fingerprint_id}: ${updateError.message}`,
        );
        throw new Error(`Regime v2 persistence failed: ${updateError.message}`);
      }

      console.log(
        `[BatchEntry] Regime v2: classified fingerprint=${fingerprint.fingerprint_id} as primary=${regimeV2Output.primary_regime}`,
      );
    },
    async similarity(input, batchId) {
      const { getRegimeWeights } = await import('./engines/similarity-engine.js');
      const weights = getRegimeWeights(input.query_fingerprint.regime);
      const fp = input.query_fingerprint;

      // Query historical fingerprints with same asset/timeframe, excluding the query itself
      // Pre-filter by regime for better matches
      // Deterministic ordering by fingerprint_id ensures reproducible candidate set (Req 2.6)
      const { data: candidates, error } = await supabase
        .from('market_fingerprints')
        .select('fingerprint_id, market_structure_vector, volatility_vector, liquidity_vector, macro_vector, sentiment_vector, regime')
        .eq('asset', fp.asset)
        .eq('timeframe', fp.timeframe)
        .neq('fingerprint_id', fp.fingerprint_id)
        .order('fingerprint_id', { ascending: true })
        .limit(500);

      if (error || !candidates || candidates.length === 0) {
        return { matches: [], match_count: 0, regime_weights_used: weights };
      }

      // Compute cosine similarity for each candidate across all 5 layers
      type CandidateRow = {
        fingerprint_id: string;
        market_structure_vector: string | number[] | null;
        volatility_vector: string | number[] | null;
        liquidity_vector: string | number[] | null;
        macro_vector: string | number[] | null;
        sentiment_vector: string | number[] | null;
        regime: unknown;
      };

      function parseVector(v: string | number[] | null): number[] {
        if (!v) return [];
        if (Array.isArray(v)) return v;
        // pgvector returns as string like "[0.5,0.3,...]"
        try { return JSON.parse(v); } catch { return []; }
      }

      function cosineSimilarity(a: number[], b: number[]): number {
        if (a.length === 0 || b.length === 0 || a.length !== b.length) return 0;
        let dot = 0, normA = 0, normB = 0;
        for (let i = 0; i < a.length; i++) {
          dot += a[i] * b[i];
          normA += a[i] * a[i];
          normB += b[i] * b[i];
        }
        const denom = Math.sqrt(normA) * Math.sqrt(normB);
        return denom === 0 ? 0 : dot / denom;
      }

      const scored = (candidates as CandidateRow[]).map((c) => {
        const l1 = cosineSimilarity(fp.state_layers.market_structure, parseVector(c.market_structure_vector));
        const l2 = cosineSimilarity(fp.state_layers.volatility_profile, parseVector(c.volatility_vector));
        const l3 = cosineSimilarity(fp.state_layers.liquidity_field, parseVector(c.liquidity_vector));
        const l4 = cosineSimilarity(fp.state_layers.macro_context, parseVector(c.macro_vector));
        const l5 = cosineSimilarity(fp.state_layers.sentiment_pressure, parseVector(c.sentiment_vector));

        const score = l1 * weights.market_structure + l2 * weights.volatility + l3 * weights.liquidity + l4 * weights.macro + l5 * weights.sentiment;
        return { fingerprint_id: c.fingerprint_id, score, l1, l2, l3, l4, l5 };
      });

      // Sort by score descending, take top 50
      scored.sort((a, b) => b.score - a.score);
      const topMatches = scored.slice(0, input.top_n);

      const matches = topMatches.map((m, idx) => ({
        fingerprint_id: fp.fingerprint_id,
        match_fingerprint_id: m.fingerprint_id,
        similarity_score: Math.round(m.score * 1000000) / 1000000,
        rank: idx + 1,
        layer_breakdown: {
          market_structure: Math.round(m.l1 * 1000000) / 1000000,
          volatility: Math.round(m.l2 * 1000000) / 1000000,
          liquidity: Math.round(m.l3 * 1000000) / 1000000,
          macro: Math.round(m.l4 * 1000000) / 1000000,
          sentiment: Math.round(m.l5 * 1000000) / 1000000,
        },
        match_explanation: {
          matched_layers: [m.l1 > 0.8 ? 'market_structure' : '', m.l2 > 0.8 ? 'volatility' : '', m.l3 > 0.8 ? 'liquidity' : ''].filter(Boolean),
          mismatched_layers: [m.l4 < 0.5 ? 'macro' : '', m.l5 < 0.5 ? 'sentiment' : ''].filter(Boolean),
          primary_match_reason: 'weighted_vector_similarity',
        },
        batch_id: batchId,
      }));

      // Archive similarity matches before returning (halts pipeline on failure)
      if (matches.length > 0) {
        // Snapshot active engine versions for the archive records
        const { data: evData } = await supabase
          .from('engine_versions')
          .select('engine_name, engine_version')
          .eq('is_active', true)
          .order('engine_name', { ascending: true });
        const engineVersions: Record<string, string> = {};
        for (const row of (evData ?? [])) {
          engineVersions[row.engine_name as string] = row.engine_version as string;
        }

        const archiveRecords: SimilarityArchiveRecord[] = matches.map((m) => ({
          ...m,
          engine_versions: engineVersions,
          created_at: new Date().toISOString(),
        }));

        await similarityArchiver.persistMatches(archiveRecords);
      }

      return {
        matches,
        match_count: matches.length,
        regime_weights_used: weights,
      };
    },
    async outcome(input, queryFingerprintId, batchId) {
      const { computeDistributionFromReturns } = await import('./engines/outcome-engine.js');
      // Fetch forward returns for matched fingerprints from DB
      // Deterministic ordering by fingerprint_id ensures reproducible outcome computation (Req 2.6)
      const { data } = await supabase
        .from('market_outcomes')
        .select('net_return_pips')
        .in('fingerprint_id', input.fingerprint_ids)
        .order('fingerprint_id', { ascending: true });
      const returns = (data ?? []).map((r) => (r as { net_return_pips: number }).net_return_pips);
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
      // Normalise variance to [0, 1] — raw std_dev in pips, cap at 50 pips as max
      const normalisedInput = {
        ...input,
        variance: Math.min(input.variance / 50, 1),
      };
      return computeConfidenceFromInput(normalisedInput);
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
    async research_persist(data) {
      const archiveWriter = createResearchArchiveWriter(supabase);

      // Compute forecast_expiry: 4 hours from the candle boundary (next window boundary)
      const candleBoundaryDate = new Date(data.candle_boundary);
      const forecastExpiry = new Date(candleBoundaryDate.getTime() + 4 * 60 * 60 * 1000).toISOString();

      // Determine quantile_table_version from the fingerprint normalisation metadata
      const quantileTableVersion = data.fingerprint.normalisation?.quantile_table_version ?? '1.0.0';

      const record: ResearchForecastRecord = {
        fingerprint_id: data.fingerprint.fingerprint_id,
        batch_id: data.batch_id,
        asset: data.fingerprint.asset,
        timeframe: data.fingerprint.timeframe,
        forecast_timestamp: new Date().toISOString(),
        forecast_expiry: forecastExpiry,
        direction_probabilities: data.forecast.direction_probabilities,
        expected_move_pips: data.forecast.expected_move_pips,
        confidence_raw: data.confidence.confidence_raw,
        confidence_final: data.confidence.confidence_final,
        tradeability_placeholder: null,
        engine_versions: data.engine_versions,
        quantile_table_version: quantileTableVersion,
        regime: data.fingerprint.regime,
        sample_size: data.outcome.sample_size,
        created_at: new Date().toISOString(),
      };

      await archiveWriter.persistForecast(record);
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

  // === Post-Pipeline Stage: Evaluation ===
  // Evaluate PREVIOUSLY matured forecasts (forecast_expiry < NOW()).
  // Runs in Batch_Layer only. Failures do NOT halt the batch.
  try {
    console.log('[BatchEntry] Starting post-pipeline evaluation stage');
    const evaluationEngine = createEvaluationEngine(supabase);
    const evalBatchId = crypto.randomUUID();

    // Snapshot engine versions for trace metadata
    const { data: evData } = await supabase
      .from('engine_versions')
      .select('engine_name, engine_version')
      .eq('is_active', true)
      .order('engine_name', { ascending: true });
    const engineVersions: Record<string, string> = {};
    for (const row of (evData ?? [])) {
      engineVersions[row.engine_name as string] = row.engine_version as string;
    }

    const evaluations = await traceEngineExecution(
      (input: { batchId: string }) => evaluationEngine.evaluateMaturedForecasts(input.batchId),
      { batchId: evalBatchId },
      {
        engine_name: 'evaluation',
        engine_version: engineVersions['evaluation'] ?? 'unknown',
        batch_id: evalBatchId,
      },
      supabase,
    );
    console.log(`[BatchEntry] Evaluation stage complete: ${evaluations.length} evaluations produced (eval_batch_id=${evalBatchId})`);
  } catch (evalError) {
    console.error('[BatchEntry] Evaluation stage failed (non-fatal):', evalError);
  }

  console.log('[BatchEntry] Batch pipeline completed successfully');
  process.exit(0);
}

// Execute
main().catch((error) => {
  console.error('[BatchEntry] Fatal error:', error);
  process.exit(1);
});
