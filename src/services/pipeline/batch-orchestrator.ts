/**
 * Batch Pipeline Orchestration Service
 *
 * Implements the 7-stage sequential pipeline:
 *   ingestion → fingerprint → similarity → outcome → forecast → confidence → cache write
 *
 * Key behaviors:
 * - Each stage starts only after predecessor succeeds
 * - On any stage failure: halt downstream, discard partial output, record failure in batch_runs
 * - Global 15-minute timeout — terminate Cloud Run instance on exceed
 * - Overlap detection: queue new cycle if previous still running (database lock on batch_runs.status)
 * - Generate batch_id, snapshot active engine versions at batch start
 * - Mark batch as completed only when all 7 stages succeed
 *
 * Requirements: 14.1, 14.2, 14.3, 14.4, 14.5, 10.6
 */

import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { env } from '../../config/env.js';
import { BATCH_TIMEOUT_MS } from '../../config/constants.js';
import { BatchStatus } from '../../types/enums.js';
import { traceEngineExecution } from '../observability/trace-emitter.js';
import type { EngineParticipationMap } from '../../config/research-assets.js';
import type {
  MacroContextEngineInput,
  MacroContextEngineOutput,
  MacroVector,
  EconomicEvent,
} from '../../types/macro.js';
import type {
  BatchRun,
  IngestionInput,
  IngestionOutput,
  FingerprintInput,
  Fingerprint,
  SimilarityInput,
  SimilarityOutput,
  OutcomeInput,
  OutcomeDistribution,
  ForecastInput,
  Forecast,
  ConfidenceInput,
  ConfidenceOutput,
  SentimentEngineInput,
  SentimentEngineOutput,
  SentimentVector,
  NewsArticle,
} from '../../types/index.js';

// =============================================================================
// Stage Types
// =============================================================================

/** Names of the 7 pipeline stages in execution order. */
export const PIPELINE_STAGES = [
  'ingestion',
  'fingerprint',
  'similarity',
  'outcome',
  'forecast',
  'confidence',
  'cache_write',
] as const;

export type PipelineStage = (typeof PIPELINE_STAGES)[number];

/** Result of a pipeline execution. */
export interface PipelineResult {
  batch_id: string;
  status: BatchStatus;
  completed_stages: PipelineStage[];
  failed_stage?: PipelineStage;
  failure_detail?: string;
  total_duration_ms: number;
}

/** Overlap detection result. */
export interface OverlapCheckResult {
  is_overlapping: boolean;
  running_batch_id?: string;
}

// =============================================================================
// Stage Handler Interfaces
// =============================================================================

/** Interface for each pipeline stage handler. */
export interface StageHandlers {
  ingestion: (input: IngestionInput) => Promise<IngestionOutput | null>;
  fingerprint: (input: FingerprintInput) => Promise<Fingerprint>;
  similarity: (input: SimilarityInput, batchId: string) => Promise<SimilarityOutput>;
  outcome: (input: OutcomeInput, queryFingerprintId: string, batchId: string) => Promise<OutcomeDistribution>;
  forecast: (input: ForecastInput) => Promise<Forecast>;
  confidence: (input: ConfidenceInput, fingerprintId: string) => Promise<ConfidenceOutput>;
  cache_write: (data: CacheWriteInput) => Promise<void>;
  /** Optional topology handler. Executes after fingerprint, before similarity. Failure never halts pipeline. */
  topology?: (fingerprintId: string, asset: string) => Promise<void>;
  /** Optional regime v2 handler. Executes after fingerprint (and topology), before similarity. Failure never halts pipeline. */
  regime_v2?: (fingerprint: Fingerprint) => Promise<void>;
  /** Optional post-pipeline handler for research persistence. Failures are logged, never propagated. */
  research_persist?: (data: ResearchPersistInput) => Promise<void>;
  /** Sentiment engine handler. Runs between ingestion and fingerprint. Failure never halts pipeline. */
  sentiment?: (input: SentimentEngineInput) => Promise<SentimentEngineOutput>;
  /** Macro context engine handler. Runs in parallel with sentiment before fingerprint. Failure never halts pipeline. */
  macro_context?: (input: MacroContextEngineInput) => Promise<MacroContextEngineOutput>;
}

/** Input to the research persistence post-pipeline handler. */
export interface ResearchPersistInput {
  batch_id: string;
  fingerprint: Fingerprint;
  similarity: SimilarityOutput;
  outcome: OutcomeDistribution;
  forecast: Forecast;
  confidence: ConfidenceOutput;
  engine_versions: Record<string, string>;
  candle_boundary: string;
}

/** Input to the cache write stage. */
export interface CacheWriteInput {
  batch_id: string;
  fingerprint: Fingerprint;
  similarity: SimilarityOutput;
  outcome: OutcomeDistribution;
  forecast: Forecast;
  confidence: ConfidenceOutput;
}

/** Configuration for the batch orchestrator. */
export interface BatchOrchestratorConfig {
  supabaseClient?: SupabaseClient;
  timeoutMs?: number;
  stageHandlers: StageHandlers;
}

/** Input for triggering a batch run. */
export interface BatchTriggerInput {
  asset: string;
  timeframe: string;
  candle_boundary: string;
  /** Provider-specific symbol for data fetching (e.g., "EUR/USD" for TwelveData). */
  providerSymbol?: string;
  /** Engine participation flags — when undefined, all engines run (backward compatible). */
  engineParticipation?: EngineParticipationMap;
}

// =============================================================================
// Batch Orchestrator
// =============================================================================

/**
 * Orchestrates the 7-stage batch processing pipeline.
 *
 * Responsibilities:
 * - Generate batch_id and record batch_runs
 * - Snapshot engine versions at batch start
 * - Execute stages sequentially with failure handling
 * - Enforce global timeout
 * - Detect and prevent overlapping batch runs
 */
export class BatchOrchestrator {
  private readonly supabase: SupabaseClient;
  private readonly timeoutMs: number;
  private readonly handlers: StageHandlers;

  constructor(config: BatchOrchestratorConfig) {
    this.supabase =
      config.supabaseClient ??
      createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);
    this.timeoutMs = config.timeoutMs ?? BATCH_TIMEOUT_MS;
    this.handlers = config.stageHandlers;
  }

  /**
   * Execute the full batch pipeline.
   *
   * @param input - Trigger input containing asset, timeframe, and candle boundary
   * @returns PipelineResult with execution status and metadata
   */
  async execute(input: BatchTriggerInput): Promise<PipelineResult> {
    const startTime = Date.now();
    const batchId = crypto.randomUUID();

    // Check for overlap — if a batch is already running, queue (return without executing)
    const overlapCheck = await this.checkOverlap();
    if (overlapCheck.is_overlapping) {
      return {
        batch_id: batchId,
        status: BatchStatus.FAILED,
        completed_stages: [],
        failure_detail: `Overlap detected: batch ${overlapCheck.running_batch_id} is still running`,
        total_duration_ms: Date.now() - startTime,
      };
    }

    // Snapshot engine versions
    const engineVersions = await this.snapshotEngineVersions();

    // Create batch_runs record with status RUNNING
    const batchRun: BatchRun = {
      batch_id: batchId,
      trigger_time: new Date().toISOString(),
      candle_boundary: input.candle_boundary,
      status: BatchStatus.RUNNING,
      engine_versions: engineVersions,
      total_duration_ms: null,
      completed_at: null,
      failure_detail: null,
    };

    await this.createBatchRecord(batchRun);

    // Execute pipeline with timeout
    const result = await this.executeWithTimeout(input, batchId, startTime, engineVersions);

    // Update batch record based on result
    await this.updateBatchRecord(result);

    return result;
  }

  /**
   * Check for overlap: query batch_runs for any record with status='RUNNING'.
   */
  async checkOverlap(): Promise<OverlapCheckResult> {
    const { data, error } = await this.supabase
      .from('batch_runs')
      .select('batch_id')
      .eq('status', BatchStatus.RUNNING)
      .limit(1)
      .maybeSingle();

    if (error) {
      // On error, allow the batch to proceed (fail-open for availability)
      return { is_overlapping: false };
    }

    if (data) {
      return {
        is_overlapping: true,
        running_batch_id: data.batch_id as string,
      };
    }

    return { is_overlapping: false };
  }

  /**
   * Snapshot active engine versions from the engine_versions table.
   */
  async snapshotEngineVersions(): Promise<Record<string, string>> {
    const { data, error } = await this.supabase
      .from('engine_versions')
      .select('engine_name, engine_version')
      .eq('is_active', true)
      .order('engine_name', { ascending: true });

    if (error || !data) {
      return {};
    }

    const versions: Record<string, string> = {};
    for (const row of data) {
      versions[row.engine_name as string] = row.engine_version as string;
    }
    return versions;
  }

  /**
   * Execute the pipeline stages with a global timeout.
   */
  private async executeWithTimeout(
    input: BatchTriggerInput,
    batchId: string,
    startTime: number,
    engineVersions: Record<string, string>,
  ): Promise<PipelineResult> {
    return new Promise<PipelineResult>((resolve) => {
      const timeoutHandle = setTimeout(() => {
        resolve({
          batch_id: batchId,
          status: BatchStatus.TIMEOUT,
          completed_stages: [],
          failure_detail: `Batch exceeded ${this.timeoutMs}ms timeout`,
          total_duration_ms: Date.now() - startTime,
        });
      }, this.timeoutMs);

      this.executePipeline(input, batchId, startTime, engineVersions)
        .then((result) => {
          clearTimeout(timeoutHandle);
          resolve(result);
        })
        .catch((error) => {
          clearTimeout(timeoutHandle);
          resolve({
            batch_id: batchId,
            status: BatchStatus.FAILED,
            completed_stages: [],
            failure_detail: `Unexpected error: ${error instanceof Error ? error.message : String(error)}`,
            total_duration_ms: Date.now() - startTime,
          });
        });
    });
  }

  /**
   * Execute all 7 pipeline stages sequentially.
   * On any stage failure, halt downstream and return failure result.
   *
   * Engine participation controls which stages run:
   * - fingerprint always runs (it's the foundation)
   * - topology runs only if engineParticipation.fingerprint is true
   * - If similarity is false → skip similarity, outcome, forecast, confidence, tradeability → return early
   * - If confidence is false → skip confidence but still run cache_write with placeholder confidence
   * - No conditional logic based on AssetClass — only the engine map drives routing (Req 4.4)
   *
   * Each stage handler is wrapped with `traceEngineExecution` to emit structured
   * execution traces. Trace emission never interrupts the pipeline (Req 12.3).
   */
  private async executePipeline(
    input: BatchTriggerInput,
    batchId: string,
    startTime: number,
    engineVersions: Record<string, string>,
  ): Promise<PipelineResult> {
    const completedStages: PipelineStage[] = [];

    // Default: all engines run when engineParticipation is not provided (backward compatible)
    const engines: EngineParticipationMap = input.engineParticipation ?? {
      fingerprint: true,
      similarity: true,
      confidence: true,
      tradeability: true,
      sentiment: true,
      macro: true,
    };

    /** Helper: resolve engine version for a given stage name. */
    const versionOf = (stage: string): string => engineVersions[stage] ?? 'unknown';

    // Stage 1: Ingestion
    let ingestionOutput: IngestionOutput;
    try {
      const ingestionInput: IngestionInput = {
        asset: input.asset,
        timeframe: input.timeframe,
        candle_boundary: input.candle_boundary,
      };
      const result = await traceEngineExecution(
        (inp: IngestionInput) => this.handlers.ingestion(inp),
        ingestionInput,
        { engine_name: 'ingestion', engine_version: versionOf('ingestion'), batch_id: batchId },
        this.supabase,
      );
      if (!result) {
        return this.buildFailureResult(batchId, 'ingestion', 'Ingestion returned null (all providers failed)', completedStages, startTime);
      }
      ingestionOutput = result;
      completedStages.push('ingestion');
    } catch (error) {
      return this.buildFailureResult(batchId, 'ingestion', error, completedStages, startTime);
    }

    // Stage 1.5: Sentiment & Macro engines (parallel, non-blocking)
    // Both engines run concurrently via Promise.all — they have no data dependency on each other.
    // Each engine handles its own errors internally (catches and logs, returns undefined on failure).
    // Failure of one engine does NOT affect the other or the pipeline.
    // Engines are skipped when disabled via Engine_Participation_Map (Req 10.5).

    const sentimentPromise = (async (): Promise<SentimentVector | undefined> => {
      if (!engines.sentiment || !this.handlers.sentiment) return undefined;
      try {
        // Fetch articles from news_articles table (24-hour window ending at candle boundary)
        // Include both asset-specific articles AND generic 'forex' articles (which affect the primary pair)
        const assetLower = input.asset.toLowerCase();
        const { data: articlesData, error: articlesError } = await this.supabase
          .from('news_articles')
          .select('id, asset_id, headline, summary, published_at, sentiment_hint, relevance_score, source')
          .in('asset_id', [assetLower, 'forex'])
          .gte('published_at', new Date(new Date(input.candle_boundary).getTime() - 24 * 3600000).toISOString())
          .lte('published_at', input.candle_boundary)
          .order('published_at', { ascending: false });

        if (articlesError) {
          console.warn(
            `[BatchOrchestrator] Failed to fetch news articles for sentiment (non-blocking): ${articlesError.message}`,
          );
          return undefined;
        }

        const articles: NewsArticle[] = (articlesData ?? []) as unknown as NewsArticle[];
        const sentimentInput: SentimentEngineInput = {
          articles,
          window_end: input.candle_boundary,
          window_hours: 24,
          previous_aggregate_sentiment: null,
        };

        const sentimentOutput = await traceEngineExecution(
          (inp: SentimentEngineInput) => this.handlers.sentiment!(inp),
          sentimentInput,
          { engine_name: 'sentiment', engine_version: versionOf('sentiment'), batch_id: batchId },
          this.supabase,
        );
        return sentimentOutput.vector;
      } catch (error) {
        console.warn(
          `[BatchOrchestrator] Sentiment engine failed (non-blocking): ${error instanceof Error ? error.message : String(error)}`,
        );
        return undefined;
      }
    })();

    const macroPromise = (async (): Promise<MacroVector | undefined> => {
      if (!engines.macro || !this.handlers.macro_context) return undefined;
      try {
        // Derive currencies from asset symbol (e.g., "eurusd" → ["EUR", "USD"])
        const assetUpper = input.asset.toUpperCase();
        const currencies: string[] = [];
        if (assetUpper.length >= 6) {
          currencies.push(assetUpper.slice(0, 3), assetUpper.slice(3, 6));
        } else {
          currencies.push(assetUpper);
        }

        // Fetch economic events (72h lookback, 24h lookahead from candle boundary)
        const candleBoundaryTime = new Date(input.candle_boundary).getTime();
        const lookbackStart = new Date(candleBoundaryTime - 72 * 3600000).toISOString();
        const lookaheadEnd = new Date(candleBoundaryTime + 24 * 3600000).toISOString();

        const { data: eventsData, error: eventsError } = await this.supabase
          .from('economic_events')
          .select('id, name, event_date, impact, actual, estimate, previous, currency')
          .in('currency', currencies)
          .gte('event_date', lookbackStart)
          .lte('event_date', lookaheadEnd)
          .order('event_date', { ascending: false });

        if (eventsError) {
          console.warn(
            `[BatchOrchestrator] Failed to fetch economic events for macro context (non-blocking): ${eventsError.message}`,
          );
          return undefined;
        }

        const events: EconomicEvent[] = (eventsData ?? []) as unknown as EconomicEvent[];
        const macroInput: MacroContextEngineInput = {
          events,
          reference_time: input.candle_boundary,
          lookback_hours: 72,
          lookahead_hours: 24,
        };

        const macroOutput = await traceEngineExecution(
          (inp: MacroContextEngineInput) => this.handlers.macro_context!(inp),
          macroInput,
          { engine_name: 'macro_context', engine_version: versionOf('macro_context'), batch_id: batchId },
          this.supabase,
        );
        return macroOutput.vector;
      } catch (error) {
        console.warn(
          `[BatchOrchestrator] Macro context engine failed (non-blocking): ${error instanceof Error ? error.message : String(error)}`,
        );
        return undefined;
      }
    })();

    const [sentimentVector, macroVector] = await Promise.all([sentimentPromise, macroPromise]);

    // Stage 2: Fingerprint (always runs — it's the foundation)
    let fingerprint: Fingerprint;
    try {
      const fingerprintInput: FingerprintInput = {
        asset: ingestionOutput.asset,
        timestamp_utc: ingestionOutput.timestamp_utc,
        ohlc: ingestionOutput.ohlc,
        ...(sentimentVector && { sentiment_vector: sentimentVector }),
        ...(macroVector && { macro_vector: macroVector }),
      };
      fingerprint = await traceEngineExecution(
        (inp: FingerprintInput) => this.handlers.fingerprint(inp),
        fingerprintInput,
        { engine_name: 'fingerprint', engine_version: versionOf('fingerprint'), batch_id: batchId },
        this.supabase,
      );
      completedStages.push('fingerprint');
    } catch (error) {
      return this.buildFailureResult(batchId, 'fingerprint', error, completedStages, startTime);
    }

    // Stage 2.5: Topology (optional, research-only — only runs if engines.fingerprint is true)
    // Topology uses fingerprint output, so it's gated by the fingerprint participation flag.
    // Failure never halts pipeline.
    if (engines.fingerprint && this.handlers.topology) {
      try {
        await traceEngineExecution(
          (inp: { fingerprintId: string; asset: string }) =>
            this.handlers.topology!(inp.fingerprintId, inp.asset),
          { fingerprintId: fingerprint.fingerprint_id, asset: input.asset },
          { engine_name: 'topology', engine_version: versionOf('topology'), batch_id: batchId },
          this.supabase,
        );
      } catch (error) {
        console.error(
          `[BatchOrchestrator] Topology stage failed (non-blocking): ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }

    // Stage 2.6: Regime v2 (optional, research-only — failure never halts pipeline)
    if (this.handlers.regime_v2) {
      try {
        await traceEngineExecution(
          (inp: { fingerprint: Fingerprint }) =>
            this.handlers.regime_v2!(inp.fingerprint),
          { fingerprint },
          { engine_name: 'regime_v2', engine_version: versionOf('regime_v2'), batch_id: batchId },
          this.supabase,
        );
      } catch (error) {
        console.error(
          `[BatchOrchestrator] Regime v2 stage failed (non-blocking): ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }

    // Engine dependency chain: if similarity is false, skip similarity + all downstream
    // stages (outcome, forecast, confidence, tradeability) and return early as completed.
    if (!engines.similarity) {
      return {
        batch_id: batchId,
        status: BatchStatus.COMPLETED,
        completed_stages: completedStages,
        total_duration_ms: Date.now() - startTime,
      };
    }

    // Stage 3: Similarity
    let similarityOutput: SimilarityOutput;
    try {
      const similarityInput: SimilarityInput = { query_fingerprint: fingerprint, top_n: 50 };
      similarityOutput = await traceEngineExecution(
        (inp: SimilarityInput) => this.handlers.similarity(inp, batchId),
        similarityInput,
        { engine_name: 'similarity', engine_version: versionOf('similarity'), batch_id: batchId },
        this.supabase,
      );
      completedStages.push('similarity');
    } catch (error) {
      return this.buildFailureResult(batchId, 'similarity', error, completedStages, startTime);
    }

    // Stage 4: Outcome
    let outcomeDistribution: OutcomeDistribution;
    try {
      const fingerprintIds = similarityOutput.matches.map((m) => m.match_fingerprint_id);
      const outcomeInput: OutcomeInput = { fingerprint_ids: fingerprintIds };
      outcomeDistribution = await traceEngineExecution(
        (inp: OutcomeInput) => this.handlers.outcome(inp, fingerprint.fingerprint_id, batchId),
        outcomeInput,
        {
          engine_name: 'outcome',
          engine_version: versionOf('outcome'),
          batch_id: batchId,
          sample_size: fingerprintIds.length,
        },
        this.supabase,
      );
      completedStages.push('outcome');
    } catch (error) {
      return this.buildFailureResult(batchId, 'outcome', error, completedStages, startTime);
    }

    // Stage 5: Forecast
    let forecast: Forecast;
    try {
      const forecastInput: ForecastInput = { outcome_distribution: outcomeDistribution };
      forecast = await traceEngineExecution(
        (inp: ForecastInput) => this.handlers.forecast(inp),
        forecastInput,
        {
          engine_name: 'forecast',
          engine_version: versionOf('forecast'),
          batch_id: batchId,
          sample_size: outcomeDistribution.sample_size,
        },
        this.supabase,
      );
      completedStages.push('forecast');
    } catch (error) {
      return this.buildFailureResult(batchId, 'forecast', error, completedStages, startTime);
    }

    // Stage 6: Confidence — only runs if engines.confidence is true
    let confidenceOutput: ConfidenceOutput;
    if (engines.confidence) {
      try {
        const confidenceInput: ConfidenceInput = {
          up_probability: outcomeDistribution.direction_probability.up,
          down_probability: outcomeDistribution.direction_probability.down,
          flat_probability: outcomeDistribution.direction_probability.flat,
          sample_size: outcomeDistribution.sample_size,
          variance: outcomeDistribution.volatility_profile.std_dev,
          skew: 0, // Derived from distribution shape — placeholder
          kurtosis: 0, // Derived from distribution shape — placeholder
          mean_similarity: 0.8, // Derived from similarity matches — placeholder
          similarity_spread: 0.2, // Derived from similarity matches — placeholder
          top_match_density: 0.7, // Derived from similarity matches — placeholder
          regime_metadata: {
            regime_match_ratio: outcomeDistribution.confidence_inputs.regime_consistency,
            dominant_regime: 'NORMAL_RANGING',
            regime_diversity: 1 - outcomeDistribution.confidence_inputs.regime_consistency,
          },
        };
        confidenceOutput = await traceEngineExecution(
          (inp: ConfidenceInput) => this.handlers.confidence(inp, fingerprint.fingerprint_id),
          confidenceInput,
          {
            engine_name: 'confidence',
            engine_version: versionOf('confidence'),
            batch_id: batchId,
            sample_size: outcomeDistribution.sample_size,
          },
          this.supabase,
        );
        completedStages.push('confidence');
      } catch (error) {
        return this.buildFailureResult(batchId, 'confidence', error, completedStages, startTime);
      }
    } else {
      // Confidence skipped — use placeholder values for cache_write
      confidenceOutput = {
        confidence_raw: 0,
        sample_weight: 0,
        regime_stability: 0,
        confidence_final: 0,
      };
    }

    // Stage 7: Cache Write (always runs if we reach this point)
    try {
      const cacheWriteInput: CacheWriteInput = {
        batch_id: batchId,
        fingerprint,
        similarity: similarityOutput,
        outcome: outcomeDistribution,
        forecast,
        confidence: confidenceOutput,
      };
      await traceEngineExecution(
        (inp: CacheWriteInput) => this.handlers.cache_write(inp),
        cacheWriteInput,
        { engine_name: 'cache_write', engine_version: versionOf('cache_write'), batch_id: batchId },
        this.supabase,
      );
      completedStages.push('cache_write');
    } catch (error) {
      return this.buildFailureResult(batchId, 'cache_write', error, completedStages, startTime);
    }

    // All applicable stages succeeded

    // Post-pipeline: Research persistence (fire-and-forget, never halts batch)
    if (this.handlers.research_persist) {
      const researchInput: ResearchPersistInput = {
        batch_id: batchId,
        fingerprint,
        similarity: similarityOutput,
        outcome: outcomeDistribution,
        forecast,
        confidence: confidenceOutput,
        engine_versions: engineVersions,
        candle_boundary: input.candle_boundary,
      };
      traceEngineExecution(
        (inp: ResearchPersistInput) => this.handlers.research_persist!(inp),
        researchInput,
        { engine_name: 'research_persist', engine_version: versionOf('research_persist'), batch_id: batchId },
        this.supabase,
      ).catch((err) => {
        console.error(
          `[BatchOrchestrator] Research persistence failed (non-blocking): ${err instanceof Error ? err.message : String(err)}`,
        );
      });
    }

    return {
      batch_id: batchId,
      status: BatchStatus.COMPLETED,
      completed_stages: completedStages,
      total_duration_ms: Date.now() - startTime,
    };
  }

  /**
   * Build a failure result from an error at a specific stage.
   */
  private buildFailureResult(
    batchId: string,
    failedStage: PipelineStage,
    error: unknown,
    completedStages: PipelineStage[],
    startTime: number,
  ): PipelineResult {
    const errorMessage = typeof error === 'string'
      ? error
      : error instanceof Error
        ? error.message
        : String(error);

    return {
      batch_id: batchId,
      status: BatchStatus.FAILED,
      completed_stages: [...completedStages],
      failed_stage: failedStage,
      failure_detail: `Stage '${failedStage}' failed: ${errorMessage}`,
      total_duration_ms: Date.now() - startTime,
    };
  }

  /**
   * Create the initial batch_runs record in the database.
   */
  private async createBatchRecord(batchRun: BatchRun): Promise<void> {
    const { error } = await this.supabase.from('batch_runs').insert(batchRun);
    if (error) {
      throw new Error(`Failed to create batch record: ${error.message}`);
    }
  }

  /**
   * Update the batch_runs record with the final status.
   */
  private async updateBatchRecord(result: PipelineResult): Promise<void> {
    const update: Record<string, unknown> = {
      status: result.status,
      total_duration_ms: result.total_duration_ms,
    };

    if (result.status === BatchStatus.COMPLETED) {
      update.completed_at = new Date().toISOString();
    }

    if (result.failure_detail) {
      update.failure_detail = result.failure_detail;
    }

    const { error } = await this.supabase
      .from('batch_runs')
      .update(update)
      .eq('batch_id', result.batch_id);

    if (error) {
      console.error(`[BatchOrchestrator] Failed to update batch record: ${error.message}`);
    }
  }
}
