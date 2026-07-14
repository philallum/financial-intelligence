/**
 * Batch Pipeline Entry Point
 *
 * Cloud Run entry point for the batch intelligence pipeline.
 * Triggered by Cloud Scheduler every 4 hours (at 00:02, 04:02, 08:02, 12:02, 16:02, 20:02 UTC).
 *
 * Behavior:
 * - Creates a Supabase client with service role credentials
 * - Instantiates the BatchOrchestrator with real stage handlers
 * - Retrieves processable assets (ACTIVE + BETA) from the research asset registry
 * - Iterates over each asset and its supportedTimeframes
 * - Passes provider symbol and engine participation map to the orchestrator
 * - Exits with code 0 on success or zero processable assets
 * - Exits with code 1 if any asset/timeframe combination fails
 * - Respects the 15-minute global timeout (BATCH_TIMEOUT_MS)
 *
 * Requirements: 6.1, 6.2, 6.3, 6.4, 6.5, 6.6, 6.7, 9.1, 11.1, 11.4, 12.1, 12.2, 14.1
 */

import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { env } from './config/env.js';
import { BATCH_TIMEOUT_MS, TOPOLOGY_SIMILARITY_WEIGHT } from './config/constants.js';
import { BatchOrchestrator } from './services/pipeline/batch-orchestrator.js';
import type { StageHandlers } from './services/pipeline/batch-orchestrator.js';
import { computeBlendedScore } from './engines/similarity-engine.js';
import { createResearchArchiveWriter, createEvaluationEngine, createSimilarityArchiver } from './research/index.js';
import type { ResearchForecastRecord, SimilarityArchiveRecord } from './research/index.js';
import { traceEngineExecution } from './services/observability/trace-emitter.js';
import { computeTopology } from './engines/topology-engine.js';
import { classifyRegimeV2 } from './engines/regime-engine-v2.js';
import { fetchMacroData } from './services/ingestion/macro-fetcher.js';
import { createDefaultRegistry } from './services/ingestion/rate-limiter.js';
import type { OHLC, MacroContext } from './types/index.js';
import { getProcessableAssets } from './config/research-assets.js';
import type { CalibrationParameters } from './engines/confidence-engine-v2.js';
import { validateCalibrationParameters } from './engines/confidence-engine-v2.js';
import { DiagnosticsCollector } from './services/observability/diagnostics-collector.js';
import type {
  SentimentDiagnostics,
  MacroContextDiagnostics,
  MLServiceDiagnostics,
  MarketContextDiagnostics,
  SimilarityDiagnostics,
  OutcomeDiagnostics,
  ForecastDiagnostics,
  GeminiDiagnostics,
} from './services/observability/diagnostics-types.js';

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
 * Mutable accumulator for per-stage diagnostics data.
 * Stage handlers populate this during execution. After orchestrator.execute()
 * returns, the accumulated data is fed to a DiagnosticsCollector and persisted.
 */
interface DiagnosticsAccumulator {
  marketContext: MarketContextDiagnostics | null;
  sentiment: SentimentDiagnostics | null;
  macroContext: MacroContextDiagnostics | null;
  similarity: SimilarityDiagnostics | null;
  outcome: OutcomeDiagnostics | null;
  forecast: ForecastDiagnostics | null;
  mlService: MLServiceDiagnostics | null;
  gemini: GeminiDiagnostics | null;
}

/** Create a fresh (empty) diagnostics accumulator. */
function createDiagnosticsAccumulator(): DiagnosticsAccumulator {
  return {
    marketContext: null,
    sentiment: null,
    macroContext: null,
    similarity: null,
    outcome: null,
    forecast: null,
    mlService: null,
    gemini: null,
  };
}

/**
 * Create stage handlers that delegate to the real engine and service implementations.
 * Each handler follows the contract defined in batch-orchestrator.ts.
 */
function createStageHandlers(supabase: SupabaseClient, calibrationParams: CalibrationParameters, diagAccumulator: DiagnosticsAccumulator): StageHandlers {
  const similarityArchiver = createSimilarityArchiver(supabase);

  return {
    async ingestion(input) {
      const { createDefaultIngestionService } = await import('./services/ingestion/ingestion-service.js');
      const service = createDefaultIngestionService({ supabaseClient: supabase });
      return service.ingest(input);
    },
    async fingerprint(input) {
      const { generateFingerprint } = await import('./engines/fingerprint-engine.js');

      // Fetch live intermarket data (DXY, VIX, SPX, US10Y) — non-blocking
      // This enriches the fingerprint's extended features (macro_state, sentiment_summary)
      // and provides the L4 fallback if MacroVector is unavailable.
      let marketContext: MacroContext | undefined;
      try {
        const rateLimits = createDefaultRegistry();
        const macroResult = await fetchMacroData({
          twelveDataApiKey: env.TWELVE_DATA_API_KEY,
          alphaVantageApiKey: env.ALPHA_VANTAGE_API_KEY,
          rateLimitRegistry: rateLimits,
          timeoutMs: 8000,
        });
        // Only use if at least one data point was fetched
        if (macroResult.data.dxy !== null || macroResult.data.vix !== null || macroResult.data.spx !== null) {
          marketContext = macroResult.data;
          console.log(
            `[BatchEntry] Macro context fetched: DXY=${macroResult.data.dxy}, VIX=${macroResult.data.vix}, SPX=${macroResult.data.spx}, US10Y=${macroResult.data.us10y} (${macroResult.fetch_time_ms}ms)`,
          );
        }
        if (macroResult.errors.length > 0) {
          console.warn(`[BatchEntry] Macro fetch warnings: ${macroResult.errors.map(e => `${e.symbol}: ${e.error}`).join(', ')}`);
        }
      } catch (err) {
        console.warn(`[BatchEntry] Macro data fetch failed (non-blocking): ${err instanceof Error ? err.message : String(err)}`);
      }

      // Record market context diagnostics
      try {
        diagAccumulator.marketContext = {
          available: !!marketContext,
          dxy: marketContext?.dxy ?? null,
          vix: marketContext?.vix ?? null,
          spx: marketContext?.spx ?? null,
        };
      } catch { /* diagnostics must never affect pipeline */ }

      return generateFingerprint({
        ...input,
        ...(marketContext && { market_context: marketContext }),
      });
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

        let score = l1 * weights.market_structure + l2 * weights.volatility + l3 * weights.liquidity + l4 * weights.macro + l5 * weights.sentiment;

        // Session match bonus: prefer candidates from the same session (5% boost)
        // This encodes temporal context without adding extra dimensions — candidates
        // from the same session are more likely to exhibit similar directional patterns.
        const candidateRegime = c.regime as { session?: string; volatility_regime?: string } | null;
        if (candidateRegime?.session === fp.regime.session) {
          score = Math.min(score * 1.05, 1.0);
        }

        // Volatility regime match bonus: prefer candidates from same volatility regime (3% boost)
        // A HIGH-vol candle's outcome distribution differs fundamentally from LOW-vol.
        // This ensures regime-appropriate matches bubble up.
        if (candidateRegime?.volatility_regime === fp.regime.volatility_regime) {
          score = Math.min(score * 1.03, 1.0);
        }

        return { fingerprint_id: c.fingerprint_id, score, l1, l2, l3, l4, l5 };
      });

      // Fetch topology vectors for blending
      const allFingerprintIds = [fp.fingerprint_id, ...scored.map(s => s.fingerprint_id)];
      const { data: topoRows } = await supabase
        .from('fingerprint_topology')
        .select('fingerprint_id, topology_vector')
        .in('fingerprint_id', allFingerprintIds);

      // Build lookup map: fingerprint_id -> topology_vector (as number[])
      const topoMap = new Map<string, number[]>();
      for (const row of (topoRows ?? [])) {
        const vec = parseVector(row.topology_vector as string | number[] | null);
        if (vec.length > 0) {
          topoMap.set(row.fingerprint_id as string, vec);
        }
      }

      // Compute topology cosine similarity and apply blending
      const queryTopoVec = topoMap.get(fp.fingerprint_id);
      for (const candidate of scored) {
        const candidateTopoVec = topoMap.get(candidate.fingerprint_id);
        const topologySimilarity = (queryTopoVec && candidateTopoVec)
          ? cosineSimilarity(queryTopoVec, candidateTopoVec)
          : undefined;
        candidate.score = computeBlendedScore(candidate.score, topologySimilarity, TOPOLOGY_SIMILARITY_WEIGHT);
      }

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

      // Record similarity diagnostics
      try {
        // Count session bonus and regime bonus candidates from the scored pool
        let sessionBonusCount = 0;
        let regimeBonusCount = 0;
        for (const c of (candidates as CandidateRow[])) {
          const candidateRegime = c.regime as { session?: string; volatility_regime?: string } | null;
          if (candidateRegime?.session === fp.regime.session) sessionBonusCount++;
          if (candidateRegime?.volatility_regime === fp.regime.volatility_regime) regimeBonusCount++;
        }
        diagAccumulator.similarity = {
          match_count: matches.length,
          session_bonus_count: sessionBonusCount,
          regime_bonus_count: regimeBonusCount,
        };
      } catch { /* diagnostics must never affect pipeline */ }

      return {
        matches,
        match_count: matches.length,
        regime_weights_used: weights,
      };
    },
    async outcome(input, queryFingerprintId, batchId) {
      const { computeDistributionFromReturns } = await import('./engines/outcome-engine.js');
      // Fetch forward returns WITH regime metadata for regime-stratified weighting
      const { data } = await supabase
        .from('market_outcomes')
        .select('fingerprint_id, net_return_pips')
        .in('fingerprint_id', input.fingerprint_ids)
        .order('fingerprint_id', { ascending: true });
      const outcomeRecords = (data ?? []) as Array<{ fingerprint_id: string; net_return_pips: number }>;

      if (outcomeRecords.length === 0) {
        throw new Error('No forward returns found for matched fingerprints');
      }

      // ─── Tier 3.2: Regime-Stratified Weighting ──────────────────────────
      // Fetch regime classification for each matched fingerprint
      // Weight returns by regime match score: same regime = 1.5x, partial match = 1.0x, mismatch = 0.7x
      const matchedFpIds = outcomeRecords.map(r => r.fingerprint_id);
      const { data: regimeData } = await supabase
        .from('market_fingerprints')
        .select('fingerprint_id, regime')
        .in('fingerprint_id', matchedFpIds);

      const regimeMap = new Map<string, { volatility_regime?: string; session?: string }>();
      for (const row of (regimeData ?? [])) {
        const regime = row.regime as { volatility_regime?: string; session?: string } | null;
        if (regime) regimeMap.set(row.fingerprint_id as string, regime);
      }

      // Get the query fingerprint's regime for comparison
      const { data: queryFpData } = await supabase
        .from('market_fingerprints')
        .select('regime')
        .eq('fingerprint_id', queryFingerprintId)
        .limit(1)
        .single();

      const queryRegime = queryFpData?.regime as { volatility_regime?: string; session?: string } | null;

      // Build weighted returns array
      // Regime-matched returns are replicated (weighted) to influence the distribution
      const weightedReturns: number[] = [];
      for (const record of outcomeRecords) {
        const matchRegime = regimeMap.get(record.fingerprint_id);
        let weight = 1.0; // default: equal contribution

        if (queryRegime && matchRegime) {
          const volMatch = queryRegime.volatility_regime === matchRegime.volatility_regime;
          const sessionMatch = queryRegime.session === matchRegime.session;

          if (volMatch && sessionMatch) {
            weight = 1.5; // Strong regime match: boost contribution
          } else if (volMatch) {
            weight = 1.2; // Partial match (same volatility)
          } else {
            weight = 0.7; // Regime mismatch: reduce contribution
          }
        }

        // Replicate returns based on weight (integer replication for weighted distribution)
        // weight 1.5 → add return 3 times in 2 iterations (1.5 rounds to include 1x + 50% chance of 2nd)
        // Simpler approach: use fractional weights by repeating at 10x scale
        const scaledWeight = Math.round(weight * 10);
        for (let i = 0; i < scaledWeight; i++) {
          weightedReturns.push(record.net_return_pips);
        }
      }

      // ─── Tier 3.1: ATR-Normalised Flat Threshold ──────────────────────────
      // Instead of the fixed 2-pip threshold, use 25% of recent ATR.
      // This means "flat" adapts to current volatility: during high-vol a 4-pip
      // move is unremarkable, during low-vol a 2-pip move is significant.
      let dynamicFlatThreshold: number | undefined;
      try {
        const { data: recentCandles } = await supabase
          .from('raw_candles')
          .select('high, low')
          .eq('asset', input.fingerprint_ids.length > 0 ? 'EURUSD' : 'EURUSD')
          .order('timestamp_utc', { ascending: false })
          .limit(14);

        if (recentCandles && recentCandles.length >= 5) {
          // Compute ATR: average of (high - low) in pips over last N candles
          const ranges = recentCandles.map((c: any) => (c.high - c.low) / 0.0001);
          const atr = ranges.reduce((a: number, b: number) => a + b, 0) / ranges.length;
          dynamicFlatThreshold = Math.max(atr * 0.25, 1.0); // Min 1 pip, dynamic otherwise
        }
      } catch {
        // Fall back to static threshold on error
      }

      // Record outcome diagnostics
      try {
        diagAccumulator.outcome = {
          dynamic_flat_threshold: dynamicFlatThreshold ?? 2.0,
          weighted_return_count: weightedReturns.length,
        };
      } catch { /* diagnostics must never affect pipeline */ }

      return computeDistributionFromReturns(
        weightedReturns,
        queryFingerprintId,
        batchId,
        dynamicFlatThreshold ? { flatThreshold: dynamicFlatThreshold } : undefined,
      );
    },
    async forecast(input) {
      const { computeForecastFromDistribution } = await import('./engines/forecast-engine.js');
      const similarityForecast = computeForecastFromDistribution(input.outcome_distribution);

      // ─── Tier 4.3: Ensemble with ML Service (non-blocking) ────────────────
      // Call the ML service for XGBoost probabilities and blend with similarity-based.
      // If ML service is unavailable, use similarity-only (graceful degradation).
      const mlServiceUrl = process.env['ML_SERVICE_URL'];
      if (mlServiceUrl) {
        try {
          // The ML service needs the fingerprint features — we get them from
          // the fingerprint that was just generated (available via closure in orchestrator)
          // For now, we'll attempt the call; if the service isn't trained yet, it returns 503.
          const mlStartTime = Date.now();
          const mlResponse = await fetch(`${mlServiceUrl}/predict`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              // Features will be populated when we wire the fingerprint data through
              // For now this is a placeholder — the ML service returns 503 until trained
              market_structure: Array(16).fill(0.5),
              volatility_profile: Array(12).fill(0.5),
              macro_context: Array(8).fill(0.5),
              sentiment_pressure: Array(6).fill(0.5),
              session_london: 0, session_ny: 0, session_asia: 0,
              volatility_regime_high: 0, volatility_regime_low: 0,
            }),
            signal: AbortSignal.timeout(3000), // 3s timeout
          });
          const mlLatencyMs = Date.now() - mlStartTime;

          if (mlResponse.ok) {
            const mlProbs = await mlResponse.json() as { up: number; down: number; flat: number };

            // Ensemble: 50/50 weighted average between similarity and ML predictions
            const alpha = 0.5; // similarity weight
            const ensembled = {
              ...similarityForecast,
              direction_probabilities: {
                up: Math.round((alpha * similarityForecast.direction_probabilities.up + (1 - alpha) * mlProbs.up) * 100) / 100,
                down: Math.round((alpha * similarityForecast.direction_probabilities.down + (1 - alpha) * mlProbs.down) * 100) / 100,
                flat: Math.round((alpha * similarityForecast.direction_probabilities.flat + (1 - alpha) * mlProbs.flat) * 100) / 100,
              },
            };

            // Normalise to sum = 1.0
            const total = ensembled.direction_probabilities.up + ensembled.direction_probabilities.down + ensembled.direction_probabilities.flat;
            if (total > 0) {
              ensembled.direction_probabilities.up = Math.round((ensembled.direction_probabilities.up / total) * 100) / 100;
              ensembled.direction_probabilities.down = Math.round((ensembled.direction_probabilities.down / total) * 100) / 100;
              ensembled.direction_probabilities.flat = Math.round((1 - ensembled.direction_probabilities.up - ensembled.direction_probabilities.down) * 100) / 100;
            }

            console.log(`[BatchEntry] Ensemble: similarity=[${similarityForecast.direction_probabilities.up},${similarityForecast.direction_probabilities.down},${similarityForecast.direction_probabilities.flat}] + ML=[${mlProbs.up},${mlProbs.down},${mlProbs.flat}] → final=[${ensembled.direction_probabilities.up},${ensembled.direction_probabilities.down},${ensembled.direction_probabilities.flat}]`);

            // Record ML service and forecast diagnostics (ML was called and succeeded)
            try {
              diagAccumulator.mlService = {
                called: true,
                response: mlProbs,
                latency_ms: mlLatencyMs,
              };
              diagAccumulator.forecast = {
                similarity_only: similarityForecast.direction_probabilities,
                ensemble: ensembled.direction_probabilities,
                alpha_weight: alpha,
              };
            } catch { /* diagnostics must never affect pipeline */ }

            return ensembled;
          } else {
            // ML responded but not ok — record as called but no usable response
            try {
              diagAccumulator.mlService = {
                called: true,
                response: null,
                latency_ms: mlLatencyMs,
              };
            } catch { /* diagnostics must never affect pipeline */ }
          }
        } catch (err) {
          // ML service unavailable — fall back to similarity-only (non-blocking)
          console.warn(`[BatchEntry] ML service unavailable (non-blocking): ${err instanceof Error ? err.message : String(err)}`);

          // Record ML service diagnostics (called but failed)
          try {
            diagAccumulator.mlService = { called: true, response: null, latency_ms: null };
          } catch { /* diagnostics must never affect pipeline */ }
        }
      } else {
        // ML service URL not configured — record as not called
        try {
          diagAccumulator.mlService = { called: false, response: null, latency_ms: null };
        } catch { /* diagnostics must never affect pipeline */ }
      }

      // Record forecast diagnostics (similarity-only, no ensemble)
      try {
        diagAccumulator.forecast = {
          similarity_only: similarityForecast.direction_probabilities,
          ensemble: similarityForecast.direction_probabilities,
          alpha_weight: 1.0,
        };
      } catch { /* diagnostics must never affect pipeline */ }

      return similarityForecast;
    },
    async confidence(input, fingerprintId) {
      const { computeConfidenceV2FromInput } = await import('./engines/confidence-engine-v2.js');
      void fingerprintId;
      // Normalise variance to [0, 1] — raw std_dev in pips, cap at 50 pips as max
      const normalisedInput = {
        ...input,
        variance: Math.min(input.variance / 50, 1),
      };
      const v2Output = computeConfidenceV2FromInput(normalisedInput, calibrationParams);
      return {
        confidence_raw: v2Output.calibration_adjusted_base,
        sample_weight: v2Output.sample_density_modifier,
        regime_stability: v2Output.regime_accuracy_modifier,
        confidence_final: v2Output.confidence_final,
      };
    },
    async cache_write(data) {
      const { CacheWriter } = await import('./services/cache/cache-writer.js');
      const writer = new CacheWriter(supabase);
      // Merge confidence output into forecast before caching
      // (forecast engine sets confidence_raw/confidence_final as 0 placeholders)
      const enrichedForecast = {
        ...data.forecast,
        confidence_raw: data.confidence.confidence_raw,
        confidence_final: data.confidence.confidence_final,
      };
      // The cache_write stage assumes the batch has completed successfully
      // since it is the final stage in the pipeline
      await writer.writeForecast(
        data.fingerprint.asset,
        enrichedForecast,
        true, // batch completed — this is the final stage
      );
    },
    async sentiment(input) {
      const { computeSentiment } = await import('./engines/sentiment-engine.js');
      const output = computeSentiment(input);

      // Record sentiment diagnostics
      try {
        const vectorValues = Object.values(output.vector) as [number, number, number, number, number, number];
        diagAccumulator.sentiment = {
          article_count: output.article_count,
          window_hours: input.window_hours,
          sentiment_vector: vectorValues,
          sentiment_score: output.sentiment_score,
          confidence_factor: output.confidence_factor,
        };
      } catch { /* diagnostics must never affect pipeline */ }

      // Record Gemini diagnostics (scored articles = those with non-zero sentiment_hint)
      try {
        const scoredArticleCount = input.articles.filter(
          (a) => a.sentiment_hint !== null && a.sentiment_hint !== 0,
        ).length;
        diagAccumulator.gemini = { scored_article_count: scoredArticleCount };
      } catch { /* diagnostics must never affect pipeline */ }

      return output;
    },
    async macro_context(input) {
      const { computeMacroContext } = await import('./engines/macro-context-engine.js');
      const output = computeMacroContext(input);

      // Record macro context diagnostics
      try {
        const vectorValues = Object.values(output.vector) as [number, number, number, number, number, number, number, number];
        diagAccumulator.macroContext = {
          event_count: output.event_count,
          macro_vector: vectorValues,
          macro_state: String(output.macro_state),
        };
      } catch { /* diagnostics must never affect pipeline */ }

      return output;
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

  const processableAssets = getProcessableAssets();

  if (processableAssets.length === 0) {
    console.warn('[BatchEntry] No processable assets found in registry (ACTIVE or BETA). Exiting.');
    process.exit(0);
  }

  console.log(`[BatchEntry] Assets: ${processableAssets.map((a) => a.symbol).join(', ')}`);

  const supabase = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);

  // Load calibration parameters from engine_versions table (required for confidence v2)
  const { data: calibrationData, error: calibrationError } = await supabase
    .from('engine_versions')
    .select('config')
    .eq('engine_name', 'confidence_v2')
    .eq('is_active', true)
    .single();

  if (calibrationError || !calibrationData) {
    console.error('[BatchEntry] Failed to load calibration parameters from engine_versions table:', calibrationError?.message ?? 'No active confidence_v2 engine config found');
    process.exit(1);
  }

  const calibrationParams = (calibrationData.config as any).calibration_parameters as CalibrationParameters;

  try {
    validateCalibrationParameters(calibrationParams);
  } catch (validationError) {
    console.error('[BatchEntry] Invalid calibration parameters:', validationError instanceof Error ? validationError.message : validationError);
    process.exit(1);
  }

  const diagAccumulator = createDiagnosticsAccumulator();
  const handlers = createStageHandlers(supabase, calibrationParams, diagAccumulator);

  const orchestrator = new BatchOrchestrator({
    supabaseClient: supabase,
    timeoutMs: BATCH_TIMEOUT_MS,
    stageHandlers: handlers,
  });

  const candleBoundary = getCurrentCandleBoundary();
  console.log(`[BatchEntry] Candle boundary: ${candleBoundary}`);

  let hasFailure = false;

  for (const asset of processableAssets) {
    for (const timeframe of asset.supportedTimeframes) {
      console.log(`[BatchEntry] Processing ${asset.symbol} (${timeframe})`);

      // Reset diagnostics accumulator for this asset/timeframe execution
      diagAccumulator.marketContext = null;
      diagAccumulator.sentiment = null;
      diagAccumulator.macroContext = null;
      diagAccumulator.similarity = null;
      diagAccumulator.outcome = null;
      diagAccumulator.forecast = null;
      diagAccumulator.mlService = null;
      diagAccumulator.gemini = null;

      try {
        const result = await orchestrator.execute({
          asset: asset.symbol,
          timeframe,
          candle_boundary: candleBoundary,
          providerSymbol: asset.providers.twelveData,
          engineParticipation: asset.engines,
        });

        console.log(`[BatchEntry] ${asset.symbol} (${timeframe}) result: ${result.status} (${result.total_duration_ms}ms)`);

        if (result.status !== 'COMPLETED') {
          console.error(`[BatchEntry] ${asset.symbol} (${timeframe}) failed: ${result.failure_detail}`);
          hasFailure = true;
        } else {
          console.log(`[BatchEntry] ${asset.symbol} (${timeframe}) completed stages: ${result.completed_stages.join(' → ')}`);
        }

        // Persist diagnostics (fire-and-forget) using the batch_id from the result
        try {
          const diagnostics = new DiagnosticsCollector(asset.symbol, result.batch_id, supabase);
          if (diagAccumulator.marketContext) diagnostics.recordMarketContext(diagAccumulator.marketContext);
          if (diagAccumulator.sentiment) diagnostics.recordSentiment(diagAccumulator.sentiment);
          if (diagAccumulator.macroContext) diagnostics.recordMacroContext(diagAccumulator.macroContext);
          if (diagAccumulator.similarity) diagnostics.recordSimilarity(diagAccumulator.similarity);
          if (diagAccumulator.outcome) diagnostics.recordOutcome(diagAccumulator.outcome);
          if (diagAccumulator.forecast) diagnostics.recordForecast(diagAccumulator.forecast);
          if (diagAccumulator.mlService) diagnostics.recordMLService(diagAccumulator.mlService);
          if (diagAccumulator.gemini) diagnostics.recordGemini(diagAccumulator.gemini);
          diagnostics.persist().catch(() => {});
        } catch { /* diagnostics persistence must never affect pipeline */ }
      } catch (error) {
        console.error(`[BatchEntry] ${asset.symbol} (${timeframe}) threw an error:`, error);
        hasFailure = true;
      }
    }
  }

  if (hasFailure) {
    console.error('[BatchEntry] Batch pipeline completed with failures');
    process.exit(1);
  }

  // === Post-Pipeline Stage: Outcome Backfill ===
  // Compute and store forward outcomes for previous fingerprints that don't have one yet.
  // This fills the gap so the evaluation engine can assess forecast accuracy.
  // Failures do NOT halt the batch.
  try {
    console.log('[BatchEntry] Starting outcome backfill stage');

    for (const asset of processableAssets) {
      // Find the 2 most recent candles for this asset (previous + current)
      const { data: recentCandles, error: candleErr } = await supabase
        .from('raw_candles')
        .select('timestamp_utc, open, high, low, close')
        .eq('asset', asset.symbol)
        .eq('timeframe', '4H')
        .order('timestamp_utc', { ascending: false })
        .limit(2);

      if (candleErr || !recentCandles || recentCandles.length < 2) {
        console.warn(`[BatchEntry] Outcome backfill: insufficient candles for ${asset.symbol}`);
        continue;
      }

      // recentCandles[0] = current candle (just ingested), recentCandles[1] = previous candle
      const currentCandle = recentCandles[0];
      const previousCandle = recentCandles[1];

      // Find the fingerprint for the previous candle
      const { data: prevFp, error: fpErr } = await supabase
        .from('market_fingerprints')
        .select('fingerprint_id')
        .eq('asset', asset.symbol)
        .eq('timeframe', '4H')
        .eq('timestamp_utc', previousCandle.timestamp_utc)
        .single();

      if (fpErr || !prevFp) {
        console.warn(`[BatchEntry] Outcome backfill: no fingerprint for ${asset.symbol} at ${previousCandle.timestamp_utc}`);
        continue;
      }

      // Check if outcome already exists (idempotent)
      const { data: existingOutcome } = await supabase
        .from('market_outcomes')
        .select('outcome_id')
        .eq('fingerprint_id', prevFp.fingerprint_id)
        .eq('horizon', '4H')
        .single();

      if (existingOutcome) {
        console.log(`[BatchEntry] Outcome backfill: ${asset.symbol} already has outcome for ${previousCandle.timestamp_utc}`);
        continue;
      }

      // Compute forward outcome: how the market moved from previous close to current close
      const pipSize = asset.pipSize;
      const prevClose = Number(previousCandle.close);
      const currClose = Number(currentCandle.close);
      const currHigh = Number(currentCandle.high);
      const currLow = Number(currentCandle.low);

      const netReturnPips = (currClose - prevClose) / pipSize;
      const maxFavourableExcursion = (currHigh - prevClose) / pipSize;
      const maxAdverseExcursion = (prevClose - currLow) / pipSize;
      const realisedVolatility = ((currHigh - currLow) / pipSize) / 10000;

      const { error: insertErr } = await supabase
        .from('market_outcomes')
        .upsert({
          fingerprint_id: prevFp.fingerprint_id,
          asset: asset.symbol,
          horizon: '4H',
          net_return_pips: Math.round(netReturnPips * 100) / 100,
          max_favourable_excursion: Math.round(maxFavourableExcursion * 100) / 100,
          max_adverse_excursion: Math.round(maxAdverseExcursion * 100) / 100,
          realised_volatility: Math.round(realisedVolatility * 10000) / 10000,
          timestamp_utc: currentCandle.timestamp_utc,
          batch_id: candleBoundary,
          engine_version: '1.0.0',
        }, { onConflict: 'fingerprint_id,horizon', ignoreDuplicates: true });

      if (insertErr) {
        console.warn(`[BatchEntry] Outcome backfill: insert failed for ${asset.symbol}: ${insertErr.message}`);
      } else {
        console.log(`[BatchEntry] Outcome backfill: stored outcome for ${asset.symbol} at ${previousCandle.timestamp_utc} → net_return=${netReturnPips.toFixed(2)} pips`);
      }
    }
  } catch (backfillError) {
    console.error('[BatchEntry] Outcome backfill stage failed (non-fatal):', backfillError);
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
